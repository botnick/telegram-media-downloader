package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Google Drive v3 over plain REST. Drive identifies files by ID and parents, so
// remote paths are resolved through folder lookups cached per provider.
// Files and folders created here carry the released appProperties stamp.

const (
	gdriveFolderMime = "application/vnd.google-apps.folder"
	gdriveChunk      = 8 << 20 // a multiple of Drive's 256 KiB chunk unit
	gdriveFileFields = "id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum"
	gdriveListLimit  = 100000
)

type gdriveEndpoints struct{ token, api, upload string }

var defaultGDriveEndpoints = gdriveEndpoints{
	token:  "https://oauth2.googleapis.com/token",
	api:    "https://www.googleapis.com/drive/v3",
	upload: "https://www.googleapis.com/upload/drive/v3",
}

var gdriveIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

type gdriveProvider struct {
	life       *cloudLife
	api        *cloudAPI
	ep         gdriveEndpoints
	folderName string
	folderID   string
	chunk      int64

	mu      sync.Mutex
	folders map[string]string // path under the root ("" = root) → folder ID
}

type driveFile struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MimeType     string    `json:"mimeType"`
	Size         int64     `json:"size,string"`
	ModifiedTime time.Time `json:"modifiedTime"`
	MD5          string    `json:"md5Checksum"`
	SHA256       string    `json:"sha256Checksum"`
}

func newGDrive(cfg map[string]any) (*gdriveProvider, error) {
	return newGDriveAt(cfg, defaultGDriveEndpoints)
}
func newGDriveAt(cfg map[string]any, ep gdriveEndpoints) (*gdriveProvider, error) {
	id, secret, refresh := strings.TrimSpace(text(cfg["clientId"])), strings.TrimSpace(text(cfg["clientSecret"])), strings.TrimSpace(text(cfg["refreshToken"]))
	if id == "" || secret == "" || refresh == "" {
		return nil, errors.New("Google Drive needs clientId + clientSecret + refreshToken")
	}
	name := strings.TrimSpace(text(cfg["folderName"]))
	if name == "" {
		name = "tgdl-backup"
	}
	if strings.ContainsAny(name, "/\\\x00") || name == "." || name == ".." {
		return nil, errors.New("invalid Google Drive folder name")
	}
	folderID := strings.TrimSpace(text(cfg["folderId"]))
	if folderID != "" && !gdriveIDPattern.MatchString(folderID) {
		return nil, errors.New("invalid Google Drive folder ID")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "client_secret": {secret}, "refresh_token": {refresh}}
	api := newCloudAPI("Google Drive", ep.token, form, "The refresh token was rejected; it may be expired or revoked. Generate a new one and edit the destination", decodeDriveError)
	return &gdriveProvider{life: newCloudLife("Google Drive"), api: api, ep: ep, folderName: name, folderID: folderID, chunk: gdriveChunk, folders: map[string]string{}}, nil
}

func (p *gdriveProvider) Close() error {
	p.life.close()
	p.api.close()
	return nil
}

// Drive returns {"error":{"errors":[{"reason":…}]}}; the token endpoint
// returns {"error":"invalid_grant"}.
func decodeDriveError(status int, body []byte) (string, bool) {
	var e struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &e) != nil || len(e.Error) == 0 {
		return "", false
	}
	if code := decodeOAuthError(body); code != "" {
		return code, false
	}
	var detail struct {
		Errors []struct {
			Reason string `json:"reason"`
		} `json:"errors"`
		Status string `json:"status"`
	}
	if json.Unmarshal(e.Error, &detail) != nil {
		return "", false
	}
	code := cloudCode(detail.Status)
	if len(detail.Errors) > 0 && detail.Errors[0].Reason != "" {
		code = cloudCode(detail.Errors[0].Reason)
	}
	retry := status == http.StatusForbidden && (code == "rateLimitExceeded" || code == "userRateLimitExceeded")
	return code, retry
}

func driveQuote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

func (p *gdriveProvider) get(ctx context.Context, op, endpoint string, query url.Values, out any) (int, error) {
	query.Set("supportsAllDrives", "true")
	res, err := p.api.do(ctx, cloudRequest{op: op, method: http.MethodGet, url: endpoint + "?" + query.Encode(), accept: []int{http.StatusNotFound}})
	if err != nil {
		return 0, err
	}
	if res.status == http.StatusNotFound {
		return res.status, nil
	}
	if err = json.Unmarshal(res.body, out); err != nil {
		return 0, fmt.Errorf("Google Drive %s: invalid response", op)
	}
	return res.status, nil
}

// search runs one files.list query to completion, bounded by limit.
func (p *gdriveProvider) search(ctx context.Context, q, order string, limit int, visit func(driveFile) error) error {
	seen := map[string]bool{}
	token := ""
	count := 0
	for {
		query := url.Values{"q": {q}, "fields": {"nextPageToken,files(" + gdriveFileFields + ")"}, "pageSize": {"1000"}, "spaces": {"drive"}, "includeItemsFromAllDrives": {"true"}}
		if order != "" {
			query.Set("orderBy", order)
		}
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			NextPageToken string      `json:"nextPageToken"`
			Files         []driveFile `json:"files"`
		}
		status, err := p.get(ctx, "files.list", p.ep.api+"/files", query, &page)
		if err != nil {
			return err
		}
		if status == http.StatusNotFound {
			return nil
		}
		for _, f := range page.Files {
			if count++; count > limit {
				return errors.New("Google Drive listing exceeds the supported entry limit")
			}
			if err = visit(f); err != nil {
				return err
			}
		}
		if page.NextPageToken == "" {
			return nil
		}
		if seen[page.NextPageToken] {
			return errors.New("Google Drive listing did not advance its page token")
		}
		seen[page.NextPageToken] = true
		token = page.NextPageToken
	}
}

func (p *gdriveProvider) childFolder(ctx context.Context, parent, name string) (string, error) {
	id := ""
	q := "name=" + driveQuote(name) + " and " + driveQuote(parent) + " in parents and mimeType='" + gdriveFolderMime + "' and trashed=false"
	// The oldest match is chosen so repeated lookups agree when duplicates exist.
	err := p.search(ctx, q, "createdTime", 1000, func(f driveFile) error {
		if id == "" && f.Name == name && gdriveIDPattern.MatchString(f.ID) {
			id = f.ID
		}
		return nil
	})
	return id, err
}

func (p *gdriveProvider) createFolder(ctx context.Context, parent, name string) (string, error) {
	body, err := jsonBody(map[string]any{"name": name, "mimeType": gdriveFolderMime, "parents": []string{parent}, "appProperties": map[string]string{"tgdl-backup": "1"}})
	if err != nil {
		return "", err
	}
	// Not retried blindly: a lost reply would create a duplicate folder.
	// ensureFolder looks the name up again before another attempt.
	res, err := p.api.do(ctx, cloudRequest{op: "create folder", method: http.MethodPost, url: p.ep.api + "/files?supportsAllDrives=true&fields=id", header: http.Header{"Content-Type": {"application/json; charset=UTF-8"}}, body: body, once: true})
	if err != nil {
		return "", err
	}
	var f driveFile
	if json.Unmarshal(res.body, &f) != nil || !gdriveIDPattern.MatchString(f.ID) {
		return "", errors.New("Google Drive create folder: invalid response")
	}
	return f.ID, nil
}

func (p *gdriveProvider) ensureFolder(ctx context.Context, parent, name string) (string, error) {
	var last error
	for attempt := 0; attempt < cloudAttempts; attempt++ {
		id, err := p.childFolder(ctx, parent, name)
		if err != nil {
			return "", err
		}
		if id != "" {
			return id, nil
		}
		id, err = p.createFolder(ctx, parent, name)
		if err == nil {
			return id, nil
		}
		var ce *cloudError
		if ctx.Err() != nil || errors.As(err, &ce) && !ce.retry {
			return "", err
		}
		last = err
		var hinted time.Duration
		if ce != nil {
			hinted = ce.retryAfter
		}
		if e := sleepContext(ctx, p.api.delay(attempt, min(hinted, cloudMaxRetryAfter))); e != nil {
			return "", e
		}
	}
	return "", last
}

// root resolves the configured folder ID, or finds/creates folderName in My
// Drive exactly as the released provider did.
func (p *gdriveProvider) root(ctx context.Context) (string, error) {
	p.mu.Lock()
	id, ok := p.folders[""]
	p.mu.Unlock()
	if ok {
		return id, nil
	}
	if p.folderID != "" {
		var f struct {
			driveFile
			Trashed bool `json:"trashed"`
		}
		status, err := p.get(ctx, "files.get", p.ep.api+"/files/"+url.PathEscape(p.folderID), url.Values{"fields": {"id,mimeType,trashed"}}, &f)
		if err != nil {
			return "", err
		}
		if status == http.StatusNotFound || f.MimeType != gdriveFolderMime || f.Trashed {
			return "", fmt.Errorf("Google Drive folder %q not found or not accessible", p.folderID)
		}
		id = p.folderID
	} else {
		var err error
		if id, err = p.ensureFolder(ctx, "root", p.folderName); err != nil {
			return "", err
		}
	}
	p.mu.Lock()
	p.folders[""] = id
	p.mu.Unlock()
	return id, nil
}

// folder walks dir below the root. Missing folders are created only when
// create is set; otherwise "" reports absence.
func (p *gdriveProvider) folder(ctx context.Context, dir string, create bool) (string, error) {
	parent, err := p.root(ctx)
	if err != nil {
		return "", err
	}
	dir = strings.Trim(dir, "/")
	if dir == "" {
		return parent, nil
	}
	acc := ""
	for _, segment := range strings.Split(dir, "/") {
		acc = path.Join(acc, segment)
		p.mu.Lock()
		id, ok := p.folders[acc]
		p.mu.Unlock()
		if !ok {
			if create {
				id, err = p.ensureFolder(ctx, parent, segment)
			} else {
				id, err = p.childFolder(ctx, parent, segment)
			}
			if err != nil || id == "" {
				return "", err
			}
			p.mu.Lock()
			p.folders[acc] = id
			p.mu.Unlock()
		}
		parent = id
	}
	return parent, nil
}

func (p *gdriveProvider) files(ctx context.Context, parent, name string) ([]driveFile, error) {
	out := []driveFile{}
	q := "name=" + driveQuote(name) + " and " + driveQuote(parent) + " in parents and mimeType!='" + gdriveFolderMime + "' and trashed=false"
	err := p.search(ctx, q, "modifiedTime desc", 1000, func(f driveFile) error {
		if f.Name == name && gdriveIDPattern.MatchString(f.ID) {
			out = append(out, f)
		}
		return nil
	})
	return out, err
}

func (p *gdriveProvider) Test(ctx context.Context) (string, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return "", err
	}
	defer done()
	var about struct {
		User struct {
			Email string `json:"emailAddress"`
		} `json:"user"`
	}
	if _, err = p.get(ctx, "about.get", p.ep.api+"/about", url.Values{"fields": {"user(emailAddress)"}}, &about); err != nil {
		return "", err
	}
	root, err := p.root(ctx)
	if err != nil {
		return "", err
	}
	email := cloudText(about.User.Email)
	if email == "" {
		email = "unknown"
	}
	return "Authorised as " + email + " — backup folder id " + root, nil
}

func (p *gdriveProvider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (UploadResult, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	defer done()
	if err = validObject(name); err != nil {
		return UploadResult{}, err
	}
	sum := md5.New()
	digest, err := inspectCloudSource(ctx, src, size, sum)
	if err != nil {
		return UploadResult{}, err
	}
	want := hex.EncodeToString(digest)
	wantMD5 := hex.EncodeToString(sum.Sum(nil))
	dir, base := path.Split(name)
	parent, err := p.folder(ctx, dir, true)
	if err != nil {
		return UploadResult{}, err
	}
	existing, err := p.files(ctx, parent, base)
	if err != nil {
		return UploadResult{}, err
	}
	// Drive computes sha256Checksum itself; size alone never proves equality.
	for _, f := range existing {
		if f.Size == size && f.SHA256 != "" && strings.EqualFold(f.SHA256, want) {
			return UploadResult{Bytes: size, ETag: f.MD5, Skipped: true}, nil
		}
	}
	target := ""
	if len(existing) > 0 {
		target = existing[0].ID
	}
	var file driveFile
	for restart := 0; ; restart++ {
		session, e := p.session(ctx, target, parent, base, size)
		if e != nil {
			return UploadResult{}, e
		}
		file, err = p.send(ctx, session, src, size, newTransferProgress(size, progress))
		if errors.Is(err, errDriveSessionGone) && restart < 2 {
			continue
		}
		if err != nil {
			p.cancelSession(session)
			return UploadResult{}, err
		}
		break
	}
	ok := file.Size == size
	if file.SHA256 != "" {
		ok = ok && strings.EqualFold(file.SHA256, want)
	} else {
		ok = ok && file.MD5 != "" && strings.EqualFold(file.MD5, wantMD5)
	}
	if !ok {
		if target == "" && gdriveIDPattern.MatchString(file.ID) {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_ = p.deleteID(cleanup, file.ID)
			cancel()
		}
		return UploadResult{}, errors.New("Google Drive uploaded file has an unexpected size or checksum")
	}
	return UploadResult{Bytes: size, ETag: file.MD5}, nil
}

var errDriveSessionGone = errors.New("Google Drive upload session expired")

// session starts a resumable upload. Drive publishes the file (or the new
// revision of an existing one) only when the final byte is accepted.
func (p *gdriveProvider) session(ctx context.Context, target, parent, name string, size int64) (string, error) {
	meta := map[string]any{"appProperties": map[string]string{"tgdl-backup": "1"}}
	method, endpoint := http.MethodPatch, p.ep.upload+"/files/"+url.PathEscape(target)
	if target == "" {
		meta["name"], meta["parents"] = name, []string{parent}
		method, endpoint = http.MethodPost, p.ep.upload+"/files"
	}
	body, err := jsonBody(meta)
	if err != nil {
		return "", err
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	res, err := p.api.do(ctx, cloudRequest{op: "start upload", method: method, url: endpoint + "?uploadType=resumable&supportsAllDrives=true", body: body,
		header: http.Header{"Content-Type": {"application/json; charset=UTF-8"}, "X-Upload-Content-Type": {contentType}, "X-Upload-Content-Length": {strconv.FormatInt(size, 10)}}})
	if err != nil {
		return "", err
	}
	// The session URI is a bearer capability; accept it only for the
	// configured upload origin.
	location, err := url.Parse(res.header.Get("Location"))
	base, _ := url.Parse(p.ep.upload)
	if err != nil || base == nil || location.Scheme != base.Scheme || location.Host != base.Host || location.User != nil {
		return "", errors.New("Google Drive start upload: invalid session location")
	}
	return location.String(), nil
}

// resumeOffset interprets a 308 Resume Incomplete reply.
func resumeOffset(h http.Header, size int64) (int64, error) {
	r := h.Get("Range")
	if r == "" {
		return 0, nil
	}
	last, ok := strings.CutPrefix(r, "bytes=0-")
	n, err := strconv.ParseInt(last, 10, 64)
	if !ok || err != nil || n < 0 || n >= size {
		return 0, errors.New("Google Drive upload: invalid resume range")
	}
	return n + 1, nil
}

func (p *gdriveProvider) send(ctx context.Context, session string, src io.ReadSeeker, size int64, tracker *transferProgress) (driveFile, error) {
	reader := asReaderAt(src)
	var offset int64
	failures := 0
	accept := []int{http.StatusPermanentRedirect, http.StatusNotFound, http.StatusGone}
	for {
		var res cloudResponse
		var err error
		if size > 0 && offset >= size {
			// Every byte is stored but the reply was lost: ask for the result.
			res, err = p.status(ctx, session, size)
		} else {
			length := min(p.chunk, size-offset)
			contentRange := fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, size)
			if size == 0 {
				contentRange = "bytes */0"
			}
			start := offset
			res, err = p.api.do(ctx, cloudRequest{op: "upload chunk", method: http.MethodPut, url: session, once: true, progress: tracker, part: start, accept: accept,
				header: http.Header{"Content-Range": {contentRange}},
				body:   func() (io.Reader, int64) { return newSourceSection(reader, start, length, ctx), length }})
		}
		if err != nil {
			var ce *cloudError
			if ctx.Err() != nil || errors.As(err, &ce) && !ce.retry {
				return driveFile{}, err
			}
			if failures++; failures >= cloudAttempts {
				return driveFile{}, err
			}
			var hinted time.Duration
			if ce != nil {
				hinted = min(ce.retryAfter, cloudMaxRetryAfter)
			}
			if e := sleepContext(ctx, p.api.delay(failures-1, hinted)); e != nil {
				return driveFile{}, e
			}
			// After an interrupted chunk, ask Drive how much it actually stored.
			if res, err = p.status(ctx, session, size); err != nil {
				return driveFile{}, err
			}
		}
		switch res.status {
		case http.StatusOK, http.StatusCreated:
			var f driveFile
			if json.Unmarshal(res.body, &f) != nil {
				return f, errors.New("Google Drive upload: invalid response")
			}
			return f, nil
		case http.StatusNotFound, http.StatusGone:
			return driveFile{}, errDriveSessionGone
		}
		next, err := resumeOffset(res.header, size)
		if err != nil {
			return driveFile{}, err
		}
		if next > offset {
			failures = 0
		} else if failures++; failures >= cloudAttempts {
			return driveFile{}, errors.New("Google Drive upload is not making progress")
		}
		offset = next
	}
}

func (p *gdriveProvider) status(ctx context.Context, session string, size int64) (cloudResponse, error) {
	return p.api.do(ctx, cloudRequest{op: "upload status", method: http.MethodPut, url: session, accept: []int{http.StatusPermanentRedirect, http.StatusNotFound, http.StatusGone},
		header: http.Header{"Content-Range": {fmt.Sprintf("bytes */%d", size)}},
		body:   func() (io.Reader, int64) { return bytes.NewReader(nil), 0 }})
}

// cancelSession discards an unfinished upload; Drive also expires abandoned
// sessions, and an unfinished session never publishes a file.
func (p *gdriveProvider) cancelSession(session string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = p.api.do(ctx, cloudRequest{op: "cancel upload", method: http.MethodDelete, url: session, once: true, accept: []int{499, http.StatusNotFound, http.StatusGone}})
}

func (p *gdriveProvider) deleteID(ctx context.Context, id string) error {
	_, err := p.api.do(ctx, cloudRequest{op: "files.delete", method: http.MethodDelete, url: p.ep.api + "/files/" + url.PathEscape(id) + "?supportsAllDrives=true", accept: []int{http.StatusNotFound}})
	return err
}

func (p *gdriveProvider) Delete(ctx context.Context, name string) error {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return err
	}
	defer done()
	if err = validObject(name); err != nil {
		return err
	}
	dir, base := path.Split(name)
	parent, err := p.folder(ctx, dir, false)
	if err != nil || parent == "" {
		return err
	}
	found, err := p.files(ctx, parent, base)
	if err != nil {
		return err
	}
	for _, f := range found {
		if err = p.deleteID(ctx, f.ID); err != nil {
			return err
		}
	}
	return nil
}

func (p *gdriveProvider) List(ctx context.Context, prefix string) ([]Object, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	dir := ""
	if i := strings.LastIndex(prefix, "/"); i >= 0 {
		dir = prefix[:i]
	}
	if dir != "" {
		if err = validObject(dir); err != nil {
			return nil, err
		}
	}
	start, err := p.folder(ctx, dir, false)
	if err != nil {
		return nil, err
	}
	out := []Object{}
	if start == "" {
		return out, nil
	}
	type pending struct{ id, rel string }
	stack := []pending{{start, dir}}
	visited := map[string]bool{start: true}
	total := 0
	for len(stack) > 0 {
		next := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		err = p.search(ctx, driveQuote(next.id)+" in parents and trashed=false", "", gdriveListLimit-total, func(f driveFile) error {
			total++
			// Drive names may contain "/" or be "..", which cannot map to a
			// backup path; such entries were not written by this transport.
			if strings.Contains(f.Name, "/") || validObject(f.Name) != nil {
				return nil
			}
			rel := path.Join(next.rel, f.Name)
			if f.MimeType == gdriveFolderMime {
				if gdriveIDPattern.MatchString(f.ID) && !visited[f.ID] {
					visited[f.ID] = true
					stack = append(stack, pending{f.ID, rel})
				}
				return nil
			}
			if f.Size < 0 {
				return errors.New("Google Drive returned a negative file size")
			}
			if strings.HasPrefix(rel, prefix) {
				out = append(out, Object{Path: rel, Size: f.Size, Modified: f.ModifiedTime})
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if total > gdriveListLimit {
			return nil, errors.New("Google Drive listing exceeds the supported entry limit")
		}
	}
	return out, nil
}
