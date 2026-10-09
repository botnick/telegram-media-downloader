package backup

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/smithy-go"
)

type fixtureS3Object struct {
	data      []byte
	etag, sha string
}
type fixtureS3Upload struct {
	key, sha string
	parts    map[int]fixtureS3Object
}
type fixtureS3 struct {
	t                                                *testing.T
	server                                           *httptest.Server
	mu                                               sync.Mutex
	objects                                          map[string]fixtureS3Object
	uploads                                          map[string]*fixtureS3Upload
	puts, creates, completes, aborts, gets, requests int
	hook                                             func(http.ResponseWriter, *http.Request) bool
}

func newFixtureS3(t *testing.T) *fixtureS3 {
	t.Helper()
	f := &fixtureS3{t: t, objects: map[string]fixtureS3Object{}, uploads: map[string]*fixtureS3Upload{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}
func (f *fixtureS3) config() map[string]any {
	return map[string]any{"endpoint": f.server.URL, "region": "us-east-1", "bucket": "fixture", "accessKeyId": "fixture-access", "secretAccessKey": "fixture-secret", "prefix": "library/ไทย"}
}
func (f *fixtureS3) setHook(h func(http.ResponseWriter, *http.Request) bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hook = h
}
func (f *fixtureS3) provider() *s3Provider {
	f.t.Helper()
	p, err := newS3(f.config())
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { _ = p.Close() })
	return p
}
func fixtureXML(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(v)
}
func fixtureS3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fixtureXML(w, struct {
		XMLName xml.Name `xml:"Error"`
		Code    string
		Message string
	}{Code: code, Message: "server-private-detail must not appear in client errors"})
}
func fixtureHMAC(key []byte, value string) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = io.WriteString(h, value)
	return h.Sum(nil)
}
func fixtureSHA(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:])
}

// Verify the wire signature independently of the SDK signer. This fixture is
// deliberately not an AWS mock client: every operation crosses a real socket.
func fixtureValidSignature(r *http.Request) bool {
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ")
	fields := map[string]string{}
	for _, field := range strings.Split(auth, ", ") {
		k, v, ok := strings.Cut(field, "=")
		if !ok {
			return false
		}
		fields[k] = v
	}
	cred := strings.Split(fields["Credential"], "/")
	if len(cred) != 5 || cred[0] != "fixture-access" || cred[2] != "us-east-1" || cred[3] != "s3" || cred[4] != "aws4_request" {
		return false
	}
	var headers strings.Builder
	for _, name := range strings.Split(fields["SignedHeaders"], ";") {
		value := strings.Join(r.Header.Values(name), ",")
		if name == "host" {
			value = r.Host
		}
		if name == "content-length" {
			value = strconv.FormatInt(r.ContentLength, 10)
		}
		fmt.Fprintf(&headers, "%s:%s\n", name, strings.Join(strings.Fields(value), " "))
	}
	query := strings.ReplaceAll(r.URL.Query().Encode(), "+", "%20")
	canonical := strings.Join([]string{r.Method, r.URL.EscapedPath(), query, headers.String(), fields["SignedHeaders"], r.Header.Get("X-Amz-Content-Sha256")}, "\n")
	scope := strings.Join(cred[1:], "/")
	toSign := "AWS4-HMAC-SHA256\n" + r.Header.Get("X-Amz-Date") + "\n" + scope + "\n" + fixtureSHA(canonical)
	key := fixtureHMAC([]byte("AWS4fixture-secret"), cred[1])
	for _, component := range cred[2:] {
		key = fixtureHMAC(key, component)
	}
	return hmac.Equal([]byte(fields["Signature"]), []byte(hex.EncodeToString(fixtureHMAC(key, toSign))))
}
func (f *fixtureS3) body(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		fixtureS3Error(w, 400, "IncompleteBody")
		return nil, false
	}
	if r.ContentLength != int64(len(b)) {
		fixtureS3Error(w, 400, "IncompleteBody")
		return nil, false
	}
	md := md5.Sum(b)
	if r.Header.Get("Content-MD5") != base64.StdEncoding.EncodeToString(md[:]) {
		fixtureS3Error(w, 400, "BadDigest")
		return nil, false
	}
	if signed := r.Header.Get("X-Amz-Content-Sha256"); signed != "UNSIGNED-PAYLOAD" && signed != fixtureSHA(string(b)) {
		fixtureS3Error(w, 400, "XAmzContentSHA256Mismatch")
		return nil, false
	}
	return b, true
}
func fixtureETag(b []byte) string { md := md5.Sum(b); return `"` + hex.EncodeToString(md[:]) + `"` }
func (f *fixtureS3) serve(w http.ResponseWriter, r *http.Request) {
	if !fixtureValidSignature(r) {
		f.t.Errorf("invalid SigV4 signature on %s %s", r.Method, r.URL.Path)
		fixtureS3Error(w, 403, "SignatureDoesNotMatch")
		return
	}
	f.mu.Lock()
	f.requests++
	hook := f.hook
	f.mu.Unlock()
	if hook != nil && hook(w, r) {
		return
	}
	if r.URL.Path == "/fixture" && r.Method == "HEAD" {
		w.WriteHeader(200)
		return
	}
	q := r.URL.Query()
	if r.URL.Path == "/fixture" && q.Get("list-type") == "2" {
		f.mu.Lock()
		defer f.mu.Unlock()
		keys := []string{}
		for key := range f.objects {
			if strings.HasPrefix(key, q.Get("prefix")) {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		offset, _ := strconv.Atoi(q.Get("continuation-token"))
		if offset > len(keys) {
			fixtureS3Error(w, 400, "InvalidArgument")
			return
		}
		end := min(offset+2, len(keys))
		type entry struct {
			Key          string
			Size         int
			ETag         string
			LastModified string
		}
		out := struct {
			XMLName               xml.Name `xml:"ListBucketResult"`
			IsTruncated           bool
			NextContinuationToken string `xml:",omitempty"`
			Contents              []entry
		}{IsTruncated: end < len(keys)}
		if out.IsTruncated {
			out.NextContinuationToken = strconv.Itoa(end)
		}
		for _, key := range keys[offset:end] {
			v := f.objects[key]
			out.Contents = append(out.Contents, entry{key, len(v.data), v.etag, "2026-10-09T00:00:00Z"})
		}
		fixtureXML(w, out)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/fixture/") {
		fixtureS3Error(w, 400, "InvalidURI")
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/fixture/")
	if r.Method == "PUT" {
		b, ok := f.body(w, r)
		if !ok {
			return
		}
		v := fixtureS3Object{data: b, etag: fixtureETag(b), sha: r.Header.Get("X-Amz-Meta-Tgdl-Sha256")}
		f.mu.Lock()
		defer f.mu.Unlock()
		if id := q.Get("uploadId"); id != "" {
			u := f.uploads[id]
			if u == nil || u.key != key {
				fixtureS3Error(w, 404, "NoSuchUpload")
				return
			}
			n, _ := strconv.Atoi(q.Get("partNumber"))
			if n < 1 || n > 10000 {
				fixtureS3Error(w, 400, "InvalidPart")
				return
			}
			u.parts[n] = v
		} else {
			f.puts++
			f.objects[key] = v
		}
		w.Header().Set("ETag", v.etag)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == "POST" && q.Has("uploads") {
		f.creates++
		id := fmt.Sprintf("upload-%d", f.creates)
		f.uploads[id] = &fixtureS3Upload{key: key, sha: r.Header.Get("X-Amz-Meta-Tgdl-Sha256"), parts: map[int]fixtureS3Object{}}
		fixtureXML(w, struct {
			XMLName               xml.Name `xml:"InitiateMultipartUploadResult"`
			Bucket, Key, UploadId string
		}{Bucket: "fixture", Key: key, UploadId: id})
		return
	}
	if id := q.Get("uploadId"); id != "" {
		u := f.uploads[id]
		if u == nil || u.key != key {
			fixtureS3Error(w, 404, "NoSuchUpload")
			return
		}
		if r.Method == "GET" {
			numbers := make([]int, 0, len(u.parts))
			for n := range u.parts {
				numbers = append(numbers, n)
			}
			sort.Ints(numbers)
			limit, _ := strconv.Atoi(q.Get("max-parts"))
			if limit <= 0 {
				limit = 1000
			}
			type part struct {
				PartNumber int
				ETag       string
				Size       int
			}
			out := struct {
				XMLName     xml.Name `xml:"ListPartsResult"`
				IsTruncated bool
				Parts       []part `xml:"Part"`
			}{IsTruncated: len(numbers) > limit}
			for _, n := range numbers[:min(len(numbers), limit)] {
				v := u.parts[n]
				out.Parts = append(out.Parts, part{n, v.etag, len(v.data)})
			}
			fixtureXML(w, out)
			return
		}
		if r.Method == "DELETE" {
			delete(f.uploads, id)
			f.aborts++
			w.WriteHeader(204)
			return
		}
		if r.Method == "POST" {
			var parts struct {
				Parts []struct {
					PartNumber int
					ETag       string
				} `xml:"Part"`
			}
			if err := xml.NewDecoder(r.Body).Decode(&parts); err != nil {
				fixtureS3Error(w, 400, "MalformedXML")
				return
			}
			var b, digests []byte
			for i, p := range parts.Parts {
				v, ok := u.parts[p.PartNumber]
				if !ok || p.PartNumber != i+1 || p.ETag != v.etag || i < len(parts.Parts)-1 && len(v.data) < 5<<20 {
					fixtureS3Error(w, 400, "InvalidPart")
					return
				}
				b = append(b, v.data...)
				md := md5.Sum(v.data)
				digests = append(digests, md[:]...)
			}
			md := md5.Sum(digests)
			etag := fmt.Sprintf(`"%x-%d"`, md, len(parts.Parts))
			f.objects[key] = fixtureS3Object{data: b, etag: etag, sha: u.sha}
			delete(f.uploads, id)
			f.completes++
			fixtureXML(w, struct {
				XMLName           xml.Name `xml:"CompleteMultipartUploadResult"`
				Bucket, Key, ETag string
			}{Bucket: "fixture", Key: key, ETag: etag})
			return
		}
	}
	v, exists := f.objects[key]
	switch r.Method {
	case "HEAD", "GET":
		if !exists {
			fixtureS3Error(w, 404, "NoSuchKey")
			return
		}
		if match := r.Header.Get("If-Match"); match != "" && match != v.etag {
			fixtureS3Error(w, 412, "PreconditionFailed")
			return
		}
		w.Header().Set("ETag", v.etag)
		w.Header().Set("Content-Length", strconv.Itoa(len(v.data)))
		w.Header().Set("X-Amz-Meta-Tgdl-Sha256", v.sha)
		if r.Method == "GET" {
			f.gets++
			_, _ = w.Write(v.data)
		}
	case "DELETE":
		delete(f.objects, key)
		w.WriteHeader(204)
	default:
		fixtureS3Error(w, 405, "MethodNotAllowed")
	}
}

func TestS3WireTransferDedupListingAndDelete(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	ctx := context.Background()
	if detail, err := p.Test(ctx); err != nil || detail != "HeadBucket fixture → 200" {
		t.Fatalf("probe: %q %v", detail, err)
	}
	for _, name := range []string{"snapshots/a +%ไทย.bin", "snapshots/b.bin", "snapshots/c.bin", "empty.bin"} {
		data := []byte("same-size exact data")
		if name == "empty.bin" {
			data = nil
		}
		result, err := p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), nil)
		if err != nil || result.Skipped || result.Bytes != int64(len(data)) {
			t.Fatalf("upload: %+v %v", result, err)
		}
		result, err = p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), nil)
		if err != nil || !result.Skipped {
			t.Fatalf("dedup: %+v %v", result, err)
		}
		f.mu.Lock()
		v := f.objects[p.prefix+"/"+name]
		f.mu.Unlock()
		if !bytes.Equal(v.data, data) || v.sha != fixtureSHA(string(data)) {
			t.Fatal("stored bytes/metadata mismatch")
		}
	}
	f.mu.Lock()
	v := f.objects[p.prefix+"/snapshots/b.bin"]
	v.data = []byte("BAD!size exact data")
	v.data = append(v.data, '!')
	v.etag = fixtureETag(v.data)
	f.objects[p.prefix+"/snapshots/b.bin"] = v
	f.mu.Unlock()
	data := []byte("same-size exact data")
	if len(v.data) != len(data) {
		t.Fatal("fixture sizes differ")
	}
	r, err := p.Upload(ctx, "snapshots/b.bin", bytes.NewReader(data), int64(len(data)), nil)
	if err != nil || r.Skipped {
		t.Fatalf("same-size corruption skipped: %+v %v", r, err)
	}
	list, err := p.List(ctx, "snapshots/")
	if err != nil || len(list) != 3 || list[0].Path != "snapshots/a +%ไทย.bin" {
		t.Fatalf("paginated list: %+v %v", list, err)
	}
	if err = p.Delete(ctx, "snapshots/b.bin"); err != nil {
		t.Fatal(err)
	}
	if err = p.Delete(ctx, "snapshots/b.bin"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.objects[p.prefix+"/snapshots/b.bin"]; ok || f.puts != 5 || f.gets != 5 {
		t.Fatalf("wire operations: puts=%d gets=%d", f.puts, f.gets)
	}
}

func TestS3MultipartParallelRetryAndBoundedProgress(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	data := bytes.Repeat([]byte("0123456789abcdef"), (int(s3PartSize)*4+123)/16)
	var active, peak atomic.Int32
	var retried atomic.Bool
	barrier := make(chan struct{})
	var once sync.Once
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "PUT" || r.URL.Query().Get("uploadId") == "" {
			return false
		}
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		if n == s3Parallel {
			once.Do(func() { close(barrier) })
		}
		select {
		case <-barrier:
		case <-r.Context().Done():
			return true
		}
		if r.URL.Query().Get("partNumber") == "2" && !retried.Swap(true) {
			_, _ = io.Copy(io.Discard, r.Body)
			fixtureS3Error(w, 500, "InternalError")
			return true
		}
		return false
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var previous int64
	var inCallback atomic.Bool
	result, err := p.Upload(ctx, "movie.mp4", bytes.NewReader(data), int64(len(data)), func(n int64) {
		if inCallback.Swap(true) {
			t.Error("concurrent progress callbacks")
		}
		defer inCallback.Store(false)
		if n <= previous || n > int64(len(data)) {
			t.Errorf("invalid progress %d -> %d", previous, n)
		}
		previous = n
	})
	if err != nil || result.Skipped {
		t.Fatalf("multipart: %+v %v", result, err)
	}
	if peak.Load() != 4 || !retried.Load() || previous != int64(len(data)) {
		t.Fatalf("parallel/retry/progress: %d %v %d", peak.Load(), retried.Load(), previous)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	v := f.objects[p.prefix+"/movie.mp4"]
	if !bytes.Equal(v.data, data) || v.sha != fixtureSHA(string(data)) || f.completes != 1 || f.aborts != 0 || len(f.uploads) != 0 {
		t.Fatal("multipart bytes or lifecycle incorrect")
	}
}

func TestS3CancelAndCloseAbortMultipart(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(fmt.Sprint(shutdown), func(t *testing.T) {
			f := newFixtureS3(t)
			p := f.provider()
			reached := make(chan struct{}, 4)
			f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method == "PUT" && r.URL.Query().Get("uploadId") != "" {
					_, _ = io.Copy(io.Discard, r.Body)
					reached <- struct{}{}
					<-r.Context().Done()
					return true
				}
				return false
			})
			data := bytes.Repeat([]byte("x"), int(s3PartSize)*4+1)
			f.objects[p.prefix+"/movie"] = fixtureS3Object{data: []byte("old"), etag: `"old"`}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := p.Upload(ctx, "movie", bytes.NewReader(data), int64(len(data)), nil); result <- err }()
			for range 4 {
				select {
				case <-reached:
				case <-time.After(10 * time.Second):
					t.Fatal("parts did not start")
				}
			}
			closed := make(chan struct{})
			if shutdown {
				go func() { _ = p.Close(); close(closed) }()
			} else {
				cancel()
				close(closed)
			}
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation lost: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not cancel and abort")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("close did not join")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.aborts != 1 || f.completes != 0 || len(f.uploads) != 0 || string(f.objects[p.prefix+"/movie"].data) != "old" {
				t.Fatalf("failed cleanup: aborts=%d completes=%d uploads=%d", f.aborts, f.completes, len(f.uploads))
			}
		})
	}
}

type changedS3Source struct {
	*bytes.Reader
	after []byte
	seeks int
}

func (s *changedS3Source) Seek(o int64, w int) (int64, error) {
	if o == 0 && w == io.SeekStart {
		s.seeks++
		if s.seeks == 2 {
			s.Reader = bytes.NewReader(s.after)
		}
	}
	return s.Reader.Seek(o, w)
}
func TestS3ChangedSourceRejectedByRemoteChecksum(t *testing.T) {
	for _, size := range []int{64, int(s3PartSize) + 33} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			f := newFixtureS3(t)
			p := f.provider()
			f.objects[p.prefix+"/file"] = fixtureS3Object{data: []byte("original"), etag: `"original"`}
			src := &changedS3Source{Reader: bytes.NewReader(bytes.Repeat([]byte{1}, size)), after: bytes.Repeat([]byte{2}, size)}
			_, err := p.Upload(context.Background(), "file", src, int64(size), nil)
			if err == nil || !strings.Contains(err.Error(), "BadDigest") || strings.Contains(err.Error(), "server-private-detail") {
				t.Fatalf("mutation: %v", err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if string(f.objects[p.prefix+"/file"].data) != "original" || len(f.uploads) != 0 {
				t.Fatal("failed transfer replaced existing object or leaked multipart")
			}
		})
	}
}

func TestS3RejectsInvalidSourceBeforeRemoteIO(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	for _, size := range []int64{-1, 0, 2, 4, 10000*(5<<30) + 1} {
		if _, err := p.Upload(context.Background(), "file", strings.NewReader("abc"), size, nil); err == nil {
			t.Fatalf("accepted invalid size %d", size)
		}
	}
	for _, name := range []string{"", "../escape", "/absolute", "a/../b", `a\b`, "a:b"} {
		if _, err := p.Upload(context.Background(), name, strings.NewReader("abc"), 3, nil); err == nil {
			t.Fatalf("accepted invalid path %q", name)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.requests != 0 {
		t.Fatalf("invalid input performed %d remote operations", f.requests)
	}
}

func TestS3RejectsInvalidListing(t *testing.T) {
	for _, response := range []string{
		`<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>`,
		`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>unchanged</NextContinuationToken></ListBucketResult>`,
		`<ListBucketResult><Contents><Key>another-library/file</Key><Size>3</Size></Contents></ListBucketResult>`,
		`<ListBucketResult><Contents><Key>library/ไทย/../escape</Key><Size>3</Size></Contents></ListBucketResult>`,
		`<ListBucketResult><Contents><Key>library/ไทย/file</Key><Size>-1</Size></Contents></ListBucketResult>`,
	} {
		t.Run(response, func(t *testing.T) {
			f := newFixtureS3(t)
			p := f.provider()
			f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.URL.Query().Get("list-type") == "2" {
					_, _ = io.WriteString(w, response)
					return true
				}
				return false
			})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if _, err := p.List(ctx, ""); err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("bad listing was accepted or looped: %v", err)
			}
		})
	}
}

func TestS3RedirectDoesNotForwardCredentials(t *testing.T) {
	var hits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer other.Close()
	f := newFixtureS3(t)
	p := f.provider()
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		http.Redirect(w, r, other.URL+"/private", http.StatusTemporaryRedirect)
		return true
	})
	if _, err := p.Test(context.Background()); err == nil {
		t.Fatal("redirect reported success")
	}
	if hits.Load() != 0 {
		t.Fatal("redirect received signed credentials")
	}
}

func TestS3ErrorsPreserveCancellationAndHideServiceBodies(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		err := s3Error("read", fmt.Errorf("https://secret.invalid/signed?credential=private: %w", cause))
		if !errors.Is(err, cause) || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "secret") {
			t.Fatalf("unsafe cancellation: %v", err)
		}
	}
	err := s3Error("read", &smithy.GenericAPIError{Code: "<private>secret</private>", Message: "private server detail"})
	if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe service error: %v", err)
	}
	err = s3Error("read", &smithy.GenericAPIError{Code: "PrivateCredentialAlphanumeric123", Message: "private"})
	if strings.Contains(err.Error(), "PrivateCredential") {
		t.Fatal("unknown service code echoed a credential")
	}
	f := newFixtureS3(t)
	p := f.provider()
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "DELETE" {
			fixtureS3Error(w, 403, "AccessDenied")
			return true
		}
		return false
	})
	err = p.Delete(context.Background(), "object")
	if err == nil || !strings.Contains(err.Error(), "AccessDenied") || strings.Contains(err.Error(), "server-private-detail") {
		t.Fatalf("delete swallowed or leaked: %v", err)
	}
}

func TestS3MultipartFailureReportsFailedAbort(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("uploadId") == "" {
			return false
		}
		if r.Method == "PUT" {
			_, _ = io.Copy(io.Discard, r.Body)
			fixtureS3Error(w, 403, "AccessDenied")
			return true
		}
		if r.Method == "DELETE" {
			fixtureS3Error(w, 403, "AccessDenied")
			return true
		}
		return false
	})
	data := bytes.Repeat([]byte{1}, int(s3PartSize)+1)
	_, err := p.Upload(context.Background(), "movie", bytes.NewReader(data), int64(len(data)), nil)
	if err == nil || !strings.Contains(err.Error(), "UploadPart: AccessDenied") || !strings.Contains(err.Error(), "AbortMultipartUpload: AccessDenied") {
		t.Fatalf("cleanup failure lost: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.completes != 0 {
		t.Fatal("failed parts were published")
	}
}

func TestS3ManagerAutomaticMirrorSurvivesRestart(t *testing.T) {
	f := newFixtureS3(t)
	m, db, dir := fixtureManager(t, nil)
	ctx := context.Background()
	cfg := f.config()
	cfg["sessionToken"] = "test-session-token"
	d, err := m.Create(ctx, map[string]any{"name": "S3 mirror", "provider": "s3", "config": cfg})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	if err = m.Pause(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	addSource(t, db, dir, "group/movie.bin", "fresh telegram bytes", 43)
	if _, err = m.Update(ctx, id, map[string]any{"config": map[string]any{"sessionToken": "", "secretAccessKey": ""}}); err != nil {
		t.Fatal(err)
	}
	stored, err := m.load(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	private, err := m.config(ctx, stored)
	if err != nil || private["sessionToken"] != "test-session-token" || private["secretAccessKey"] != "fixture-secret" {
		t.Fatalf("secret update: %v", err)
	}
	public, err := m.Config(ctx, id)
	if err != nil || public["sessionToken"] != nil || public["secretAccessKey"] != nil || public["accessKeyId"] != nil {
		t.Fatal("config exposed credentials")
	}
	m.Close()
	next, err := NewManager(ctx, m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err = next.Pause(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	waitBackup(t, next, id, 1, 0)
	f.mu.Lock()
	defer f.mu.Unlock()
	if string(f.objects["library/ไทย/group/movie.bin"].data) != "fresh telegram bytes" || f.puts != 1 {
		t.Fatal("durable automatic mirror did not publish exact bytes once")
	}
}

func BenchmarkS3SourceInspection(b *testing.B) {
	for _, size := range []int{1 << 20, 64 << 20} {
		b.Run(strconv.Itoa(size), func(b *testing.B) {
			data := bytes.Repeat([]byte{7}, size)
			src := bytes.NewReader(data)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if _, err := inspectS3Source(context.Background(), src, int64(size)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
