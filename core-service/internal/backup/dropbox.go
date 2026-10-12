package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

// Dropbox API v2 over plain REST. Small files use files/upload; larger files
// use an upload session whose commit publishes the file atomically. Every call
// carries Dropbox's content_hash of its own bytes, and the committed metadata
// must report the hash of the whole inspected source.

const (
	dropboxBlock        = 4 << 20
	dropboxDefaultChunk = 8 << 20
	dropboxMaxChunk     = 148 << 20 // below the 150 MiB per-call limit, 4 MiB aligned
	dropboxListLimit    = 100000
)

type dropboxEndpoints struct{ token, api, content string }

var defaultDropboxEndpoints = dropboxEndpoints{
	token:   "https://api.dropboxapi.com/oauth2/token",
	api:     "https://api.dropboxapi.com/2",
	content: "https://content.dropboxapi.com/2",
}

type dropboxProvider struct {
	life  *cloudLife
	api   *cloudAPI
	ep    dropboxEndpoints
	root  string // "" is the app folder / account root, otherwise "/a/b"
	chunk int64

	mu    sync.Mutex
	ready bool
}

type dropboxMetadata struct {
	Tag            string    `json:".tag"`
	Name           string    `json:"name"`
	PathDisplay    string    `json:"path_display"`
	Size           int64     `json:"size"`
	ServerModified time.Time `json:"server_modified"`
	ContentHash    string    `json:"content_hash"`
}

// dropboxChunkBytes honours the released BACKUP_DROPBOX_CHUNK_BYTES override,
// clamped to 4–148 MiB and aligned to Dropbox's 4 MiB hash blocks.
func dropboxChunkBytes() int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(os.Getenv("BACKUP_DROPBOX_CHUNK_BYTES")), 10, 64)
	if err != nil || n <= 0 {
		return dropboxDefaultChunk
	}
	return min(dropboxMaxChunk, max(dropboxBlock, n/dropboxBlock*dropboxBlock))
}

func dropboxRoot(raw string) (string, error) {
	raw = strings.ReplaceAll(raw, "\\", "/")
	parts := []string{}
	for _, segment := range strings.Split(raw, "/") {
		switch segment {
		case "", ".":
			continue
		case "..":
			return "", errors.New("Dropbox remote root must not contain \"..\"")
		}
		if strings.ContainsAny(segment, "\x00\r\n") {
			return "", errors.New("invalid Dropbox remote root")
		}
		parts = append(parts, segment)
	}
	if len(parts) == 0 {
		return "", nil
	}
	return "/" + strings.Join(parts, "/"), nil
}

func newDropbox(cfg map[string]any) (*dropboxProvider, error) {
	return newDropboxAt(cfg, defaultDropboxEndpoints)
}
func newDropboxAt(cfg map[string]any, ep dropboxEndpoints) (*dropboxProvider, error) {
	key, secret, refresh := strings.TrimSpace(text(cfg["appKey"])), strings.TrimSpace(text(cfg["appSecret"])), strings.TrimSpace(text(cfg["refreshToken"]))
	if key == "" || secret == "" || refresh == "" {
		return nil, errors.New("Dropbox needs appKey + appSecret + refreshToken")
	}
	raw, ok := cfg["remoteRoot"].(string)
	if !ok || strings.TrimSpace(raw) == "" {
		raw = "/tgdl-backup"
	}
	root, err := dropboxRoot(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {key}, "client_secret": {secret}, "refresh_token": {refresh}}
	api := newCloudAPI("Dropbox", ep.token, form, "The refresh token was rejected; generate a new one and edit the destination", decodeDropboxError)
	return &dropboxProvider{life: newCloudLife("Dropbox"), api: api, ep: ep, root: root, chunk: dropboxChunkBytes()}, nil
}

func (p *dropboxProvider) Close() error {
	p.life.close()
	p.api.close()
	return nil
}

// Dropbox errors carry error_summary such as "path/not_found/..". Rate limits
// use 429, or 409 too_many_write_operations for namespace lock contention.
func decodeDropboxError(status int, body []byte) (string, bool) {
	var e struct {
		Summary string `json:"error_summary"`
	}
	code := ""
	if json.Unmarshal(body, &e) == nil && e.Summary != "" {
		code = cloudCode(e.Summary)
	} else if c := decodeOAuthError(body); c != "" {
		code = c
	}
	retry := strings.Contains(code, "too_many_write_operations") || strings.Contains(code, "too_many_requests") || strings.Contains(code, "internal_error")
	return code, retry
}

// dropboxArg encodes the Dropbox-API-Arg header. HTTP headers must be ASCII,
// so every non-ASCII rune is \u-escaped as the API requires.
func dropboxArg(v any) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, r := range string(data) {
		if r < 0x7f {
			b.WriteRune(r)
			continue
		}
		for _, unit := range utf16.Encode([]rune{r}) {
			fmt.Fprintf(&b, `\u%04x`, unit)
		}
	}
	return b.String(), nil
}

func (p *dropboxProvider) path(name string) string { return p.root + "/" + name }

func (p *dropboxProvider) rpc(ctx context.Context, op string, arg, out any, accept ...int) (cloudResponse, error) {
	body, err := jsonBody(arg)
	if err != nil {
		return cloudResponse{}, err
	}
	res, err := p.api.do(ctx, cloudRequest{op: op, method: http.MethodPost, url: p.ep.api + "/" + op, header: http.Header{"Content-Type": {"application/json"}}, body: body, accept: accept})
	if err != nil {
		return res, err
	}
	if out != nil && res.status >= 200 && res.status < 300 {
		if err = json.Unmarshal(res.body, out); err != nil {
			return res, fmt.Errorf("Dropbox %s: invalid response", op)
		}
	}
	return res, nil
}

func (p *dropboxProvider) content(ctx context.Context, op string, arg any, reader io.ReaderAt, offset, length int64, tracker *transferProgress, out any) error {
	header, err := dropboxArg(arg)
	if err != nil {
		return err
	}
	res, err := p.api.do(ctx, cloudRequest{op: op, method: http.MethodPost, url: p.ep.content + "/" + op, progress: tracker, part: offset,
		header: http.Header{"Content-Type": {"application/octet-stream"}, "Dropbox-Api-Arg": {header}},
		body:   func() (io.Reader, int64) { return newSourceSection(reader, offset, length, ctx), length }})
	if err != nil {
		return err
	}
	if out != nil && json.Unmarshal(res.body, out) != nil {
		return fmt.Errorf("Dropbox %s: invalid response", op)
	}
	return nil
}

func dropboxCode(err error) string {
	var ce *cloudError
	if errors.As(err, &ce) {
		return ce.code
	}
	return ""
}

// ensureRoot creates the configured root once; an existing folder is fine.
func (p *dropboxProvider) ensureRoot(ctx context.Context) error {
	p.mu.Lock()
	ready := p.ready
	p.mu.Unlock()
	if ready || p.root == "" {
		return nil
	}
	_, err := p.rpc(ctx, "files/create_folder_v2", map[string]any{"path": p.root, "autorename": false}, nil)
	if err != nil && !strings.HasPrefix(dropboxCode(err), "path/conflict/folder") {
		return err
	}
	p.mu.Lock()
	p.ready = true
	p.mu.Unlock()
	return nil
}

func (p *dropboxProvider) Test(ctx context.Context) (string, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return "", err
	}
	defer done()
	var account struct {
		Email string `json:"email"`
	}
	if _, err = p.rpc(ctx, "users/get_current_account", nil, &account); err != nil {
		return "", err
	}
	if err = p.ensureRoot(ctx); err != nil {
		return "", err
	}
	email := cloudText(account.Email)
	if email == "" {
		email = "unknown"
	}
	root := p.root
	if root == "" {
		root = "/"
	}
	return "Authorised as " + email + " — root " + root + " ready", nil
}

// metadata returns nil when the path does not exist.
func (p *dropboxProvider) metadata(ctx context.Context, target string) (*dropboxMetadata, error) {
	var m dropboxMetadata
	_, err := p.rpc(ctx, "files/get_metadata", map[string]any{"path": target}, &m)
	if strings.HasPrefix(dropboxCode(err), "path/not_found") {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// dropboxHasher computes Dropbox's content_hash: SHA-256 over the SHA-256 of
// each 4 MiB block. Block digests are retained so each upload call can carry
// the hash of its own (block-aligned) byte range.
type dropboxHasher struct {
	block  hash.Hash
	filled int
	blocks [][]byte
}

func newDropboxHasher() *dropboxHasher { return &dropboxHasher{block: sha256.New()} }
func (h *dropboxHasher) Write(b []byte) (int, error) {
	n := len(b)
	for len(b) > 0 {
		take := min(len(b), dropboxBlock-h.filled)
		h.block.Write(b[:take])
		h.filled += take
		b = b[take:]
		if h.filled == dropboxBlock {
			h.flush()
		}
	}
	return n, nil
}
func (h *dropboxHasher) flush() {
	h.blocks = append(h.blocks, h.block.Sum(nil))
	h.block.Reset()
	h.filled = 0
}
func (h *dropboxHasher) finish() {
	if h.filled > 0 {
		h.flush()
	}
}

// rangeHash returns the content hash of [offset, offset+length) for block
// aligned offsets.
func (h *dropboxHasher) rangeHash(offset, length int64) string {
	sum := sha256.New()
	first, last := offset/dropboxBlock, (offset+length+dropboxBlock-1)/dropboxBlock
	for i := first; i < last && i < int64(len(h.blocks)); i++ {
		sum.Write(h.blocks[i])
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func (p *dropboxProvider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (UploadResult, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	defer done()
	if err = validObject(name); err != nil {
		return UploadResult{}, err
	}
	if size > 350<<30 {
		return UploadResult{}, errors.New("Dropbox uploads are limited to 350 GB")
	}
	hasher := newDropboxHasher()
	if _, err = inspectCloudSource(ctx, src, size, hasher); err != nil {
		return UploadResult{}, err
	}
	hasher.finish()
	want := hasher.rangeHash(0, size)
	target := p.path(name)
	existing, err := p.metadata(ctx, target)
	if err != nil {
		return UploadResult{}, err
	}
	if existing != nil {
		if existing.Tag != "file" {
			return UploadResult{}, errors.New("Dropbox backup destination is not a regular file")
		}
		// content_hash is computed by Dropbox over the stored bytes.
		if existing.Size == size && strings.EqualFold(existing.ContentHash, want) {
			return UploadResult{Bytes: size, ETag: existing.ContentHash, Skipped: true}, nil
		}
	}
	reader := asReaderAt(src)
	tracker := newTransferProgress(size, progress)
	commit := map[string]any{"path": target, "mode": "overwrite", "autorename": false, "mute": true, "strict_conflict": false}
	var file dropboxMetadata
	if size <= p.chunk {
		arg := map[string]any{"content_hash": want}
		for k, v := range commit {
			arg[k] = v
		}
		err = p.content(ctx, "files/upload", arg, reader, 0, size, tracker, &file)
	} else {
		file, err = p.session(ctx, commit, reader, size, hasher, tracker)
	}
	if err != nil {
		return UploadResult{}, err
	}
	if file.Size != size || !strings.EqualFold(file.ContentHash, want) {
		return UploadResult{}, errors.New("Dropbox uploaded file has an unexpected size or content hash")
	}
	return UploadResult{Bytes: size, ETag: file.ContentHash}, nil
}

// session uploads chunk by chunk. A retried append whose first attempt was
// stored is answered with incorrect_offset and its correct offset; abandoned
// sessions expire without publishing anything.
func (p *dropboxProvider) session(ctx context.Context, commit map[string]any, reader io.ReaderAt, size int64, hasher *dropboxHasher, tracker *transferProgress) (dropboxMetadata, error) {
	var file dropboxMetadata
	var started struct {
		SessionID string `json:"session_id"`
	}
	if err := p.content(ctx, "files/upload_session/start", map[string]any{"close": false, "content_hash": hasher.rangeHash(0, p.chunk)}, reader, 0, p.chunk, tracker, &started); err != nil {
		return file, err
	}
	if started.SessionID == "" {
		return file, errors.New("Dropbox upload_session/start returned no session ID")
	}
	offset := p.chunk
	for offset < size {
		length := min(p.chunk, size-offset)
		cursor := map[string]any{"session_id": started.SessionID, "offset": offset}
		chunkHash := hasher.rangeHash(offset, length)
		var err error
		if offset+length == size {
			err = p.content(ctx, "files/upload_session/finish", map[string]any{"cursor": cursor, "commit": commit, "content_hash": chunkHash}, reader, offset, length, tracker, &file)
			if err == nil {
				return file, nil
			}
			// A lost finish reply leaves a closed/missing session; the committed
			// file proves success only if its content hash matches.
			if strings.HasPrefix(dropboxCode(err), "lookup_failed") {
				if m, e := p.metadata(ctx, commit["path"].(string)); e == nil && m != nil && m.Tag == "file" && m.Size == size && strings.EqualFold(m.ContentHash, hasher.rangeHash(0, size)) {
					return *m, nil
				}
			}
			return file, err
		}
		err = p.content(ctx, "files/upload_session/append_v2", map[string]any{"cursor": cursor, "close": false, "content_hash": chunkHash}, reader, offset, length, tracker, nil)
		if err == nil {
			offset += length
			continue
		}
		correct, ok := dropboxCorrectOffset(err)
		if !ok || correct <= offset || correct > size || correct%dropboxBlock != 0 || correct%p.chunk != 0 {
			return file, err
		}
		offset = correct
	}
	return file, errors.New("Dropbox upload session ended without a commit")
}

func dropboxCorrectOffset(err error) (int64, bool) {
	var ce *cloudError
	if !errors.As(err, &ce) || !strings.HasPrefix(ce.code, "incorrect_offset") && !strings.Contains(ce.code, "/incorrect_offset") {
		return 0, false
	}
	var body struct {
		Error struct {
			CorrectOffset *int64 `json:"correct_offset"`
		} `json:"error"`
	}
	if json.Unmarshal(ce.body, &body) != nil || body.Error.CorrectOffset == nil {
		return 0, false
	}
	return *body.Error.CorrectOffset, true
}

func (p *dropboxProvider) Delete(ctx context.Context, name string) error {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return err
	}
	defer done()
	if err = validObject(name); err != nil {
		return err
	}
	_, err = p.rpc(ctx, "files/delete_v2", map[string]any{"path": p.path(name)}, nil)
	if strings.HasPrefix(dropboxCode(err), "path_lookup/not_found") {
		return nil
	}
	return err
}

func (p *dropboxProvider) List(ctx context.Context, prefix string) ([]Object, error) {
	ctx, done, err := p.life.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	dir := ""
	if i := strings.LastIndex(prefix, "/"); i >= 0 {
		dir = prefix[:i]
	}
	start := p.root
	if dir != "" {
		if err = validObject(dir); err != nil {
			return nil, err
		}
		start = p.path(dir)
	}
	out := []Object{}
	var page struct {
		Entries []dropboxMetadata `json:"entries"`
		Cursor  string            `json:"cursor"`
		HasMore bool              `json:"has_more"`
	}
	_, err = p.rpc(ctx, "files/list_folder", map[string]any{"path": start, "recursive": true, "include_deleted": false, "limit": 2000}, &page)
	if strings.HasPrefix(dropboxCode(err), "path/not_found") {
		return out, nil
	}
	seen := map[string]bool{}
	total := 0
	for {
		if err != nil {
			return nil, err
		}
		for _, entry := range page.Entries {
			if total++; total > dropboxListLimit {
				return nil, errors.New("Dropbox listing exceeds the supported entry limit")
			}
			if entry.Tag != "file" {
				continue
			}
			// Only the last path_display component is guaranteed to have its
			// stored casing; Dropbox paths compare case-insensitively.
			if len(entry.PathDisplay) <= len(p.root)+1 || !strings.EqualFold(entry.PathDisplay[:len(p.root)+1], p.root+"/") {
				return nil, errors.New("Dropbox returned an entry outside the requested folder")
			}
			rel := entry.PathDisplay[len(p.root)+1:]
			if validObject(rel) != nil {
				continue
			}
			if entry.Size < 0 {
				return nil, errors.New("Dropbox returned a negative file size")
			}
			if strings.HasPrefix(rel, prefix) {
				out = append(out, Object{Path: rel, Size: entry.Size, Modified: entry.ServerModified})
			}
		}
		if !page.HasMore {
			return out, nil
		}
		if page.Cursor == "" || seen[page.Cursor] {
			return nil, errors.New("Dropbox listing did not advance its cursor")
		}
		seen[page.Cursor] = true
		cursor := page.Cursor
		page.Entries, page.Cursor, page.HasMore = nil, "", false
		_, err = p.rpc(ctx, "files/list_folder/continue", map[string]any{"cursor": cursor}, &page)
	}
}
