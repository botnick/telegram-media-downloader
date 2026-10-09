package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"golang.org/x/sync/errgroup"
)

const s3PartSize int64 = 8 << 20
const s3Parallel = 4

type s3Provider struct {
	client         *s3.Client
	transport      *http.Transport
	bucket, prefix string
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	mu             sync.Mutex
	closed         bool
}

func newS3(cfg map[string]any) (*s3Provider, error) {
	region, bucket := strings.TrimSpace(text(cfg["region"])), strings.TrimSpace(text(cfg["bucket"]))
	access, secret := strings.TrimSpace(text(cfg["accessKeyId"])), text(cfg["secretAccessKey"])
	if region == "" {
		return nil, errors.New("region required")
	}
	if bucket == "" {
		return nil, errors.New("bucket required")
	}
	if strings.ContainsAny(bucket, "/\\?#\x00\r\n") {
		return nil, errors.New("invalid S3 bucket")
	}
	if access == "" || secret == "" {
		return nil, errors.New("accessKeyId + secretAccessKey required")
	}
	endpoint := strings.TrimSpace(text(cfg["endpoint"]))
	pathStyle := false
	fps := strings.ToLower(text(cfg["forcePathStyle"]))
	if b, ok := cfg["forcePathStyle"].(bool); ok {
		fps = strconv.FormatBool(b)
	}
	if fps != "" && fps != "auto" && fps != "true" && fps != "false" {
		return nil, errors.New("invalid forcePathStyle")
	}
	if endpoint != "" {
		u, e := url.Parse(endpoint)
		if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("endpoint must be an HTTP(S) URL without credentials, query or fragment")
		}
		host := strings.ToLower(u.Hostname())
		pathStyle = host == "localhost" || net.ParseIP(host) != nil || strings.Contains(host, "minio")
	}
	if fps == "true" {
		pathStyle = true
	} else if fps == "false" {
		pathStyle = false
	}
	prefix := strings.Trim(text(cfg["prefix"]), "/")
	if prefix != "" {
		if err := validObject(prefix); err != nil {
			return nil, fmt.Errorf("invalid S3 prefix: %w", err)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = s3Parallel
	transport.MaxConnsPerHost = s3Parallel
	transport.ResponseHeaderTimeout = 30 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.IdleConnTimeout = time.Minute
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &remoteDeadlineConn{Conn: conn}, nil
	}
	options := s3.Options{Region: region, Credentials: credentials.NewStaticCredentialsProvider(access, secret, text(cfg["sessionToken"])), UsePathStyle: pathStyle, RetryMaxAttempts: 3, HTTPClient: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenSupported}
	if endpoint != "" {
		options.BaseEndpoint = &endpoint
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &s3Provider{client: s3.New(options), transport: transport, bucket: bucket, prefix: prefix, ctx: ctx, cancel: cancel}, nil
}

// Bound a silent remote socket independently of the total size of the object.
type remoteDeadlineConn struct{ net.Conn }

func (c *remoteDeadlineConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(time.Minute))
	return c.Conn.Read(b)
}
func (c *remoteDeadlineConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(time.Minute))
	return c.Conn.Write(b)
}
func (p *s3Provider) begin(ctx context.Context) (context.Context, func(), error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, nil, errors.New("S3 provider is closed")
	}
	p.wg.Add(1)
	p.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(p.ctx, cancel)
	return ctx, func() { stop(); cancel(); p.wg.Done() }, nil
}
func (p *s3Provider) Close() error {
	p.mu.Lock()
	p.closed = true
	p.cancel()
	p.mu.Unlock()
	p.wg.Wait()
	p.transport.CloseIdleConnections()
	return nil
}
func (p *s3Provider) key(name string) (string, error) {
	if err := validObject(name); err != nil {
		return "", err
	}
	if p.prefix != "" {
		return p.prefix + "/" + name, nil
	}
	return name, nil
}
func s3Missing(err error) bool {
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) && re.HTTPStatusCode() == 404 {
		return true
	}
	var api smithy.APIError
	return errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound")
}

// Do not reflect untrusted service error bodies or signed URLs into UI logs.
func s3Error(op string, err error) error {
	if err == nil {
		return nil
	}
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		if errors.Is(err, cause) {
			return fmt.Errorf("S3 %s: %w", op, cause)
		}
	}
	var api smithy.APIError
	code := "transport error"
	if errors.As(err, &api) {
		// Even a syntactically valid unknown Code can echo credentials. Only
		// recognized protocol codes may cross the UI/log boundary.
		code = "service error"
		switch api.ErrorCode() {
		case "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "TokenRefreshRequired",
			"InvalidArgument", "InvalidRequest", "NoSuchBucket", "NoSuchKey", "NoSuchUpload", "NotFound", "PreconditionFailed",
			"ConditionalRequestConflict", "EntityTooSmall", "EntityTooLarge", "InvalidPart", "InvalidPartOrder", "BadDigest",
			"IncompleteBody", "RequestTimeout", "RequestTimeTooSkewed", "InvalidURI", "MalformedXML", "MethodNotAllowed",
			"NotImplemented", "SlowDown", "InternalError", "ServiceUnavailable", "XAmzContentSHA256Mismatch", "PermanentRedirect", "AuthorizationHeaderMalformed":
			code = api.ErrorCode()
		}
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) {
		return fmt.Errorf("S3 %s: %s (HTTP %d)", op, code, re.HTTPStatusCode())
	}
	return fmt.Errorf("S3 %s: %s", op, code)
}
func (p *s3Provider) Test(ctx context.Context) (string, error) {
	ctx, done, err := p.begin(ctx)
	if err != nil {
		return "", err
	}
	defer done()
	_, err = p.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &p.bucket})
	if err != nil {
		return "", s3Error("HeadBucket", err)
	}
	return "HeadBucket " + p.bucket + " → 200", nil
}

type s3Source struct {
	digest    []byte
	partSize  int64
	checksums []string
}

// One bounded pass computes the SHA-256 identity and S3's widely supported
// Content-MD5 transport checksums. MD5 is not used for dedup or authentication.
func inspectS3Source(ctx context.Context, src io.ReadSeeker, size int64) (s3Source, error) {
	var out s3Source
	if size < 0 || size > 10000*(5<<30) {
		return out, errors.New("invalid backup source size or S3 multipart limit exceeded")
	}
	out.partSize = max(s3PartSize, ((size+9999)/10000+(1<<20)-1)/(1<<20)*(1<<20))
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return out, err
	}
	whole := sha256.New()
	buf := make([]byte, 64<<10)
	for offset := int64(0); offset < size || offset == 0; offset += out.partSize {
		part := md5.New()
		length := min(out.partSize, size-offset)
		n, err := io.CopyBuffer(io.MultiWriter(whole, part), io.LimitReader(contextReader{ctx, src}, length), buf)
		if err != nil {
			return out, err
		}
		if n != length {
			return out, errors.New("backup source size changed during inspection")
		}
		out.checksums = append(out.checksums, base64.StdEncoding.EncodeToString(part.Sum(nil)))
	}
	var extra [1]byte
	n, err := contextReader{ctx, src}.Read(extra[:])
	if n != 0 || err == nil {
		return out, errors.New("backup source size changed during inspection")
	}
	if !errors.Is(err, io.EOF) {
		return out, err
	}
	out.digest = whole.Sum(nil)
	_, err = src.Seek(0, io.SeekStart)
	return out, err
}
func (p *s3Provider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (UploadResult, error) {
	ctx, done, err := p.begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	defer done()
	key, err := p.key(name)
	if err != nil {
		return UploadResult{}, err
	}
	inspected, err := inspectS3Source(ctx, src, size)
	if err != nil {
		return UploadResult{}, err
	}
	head, err := p.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &p.bucket, Key: &key})
	if err != nil && !s3Missing(err) {
		return UploadResult{}, s3Error("HeadObject", err)
	}
	if err == nil && aws.ToInt64(head.ContentLength) == size {
		if aws.ToString(head.ETag) == "" {
			return UploadResult{}, errors.New("S3 omitted existing object ETag")
		}
		existing, e := p.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &p.bucket, Key: &key, IfMatch: head.ETag})
		if e != nil {
			return UploadResult{}, s3Error("verify existing object", e)
		}
		hash, n, e := fileDigest(ctx, io.LimitReader(existing.Body, size+1))
		closeErr := existing.Body.Close()
		if e != nil {
			return UploadResult{}, s3Error("read existing object", e)
		}
		if closeErr != nil {
			return UploadResult{}, s3Error("close existing object", closeErr)
		}
		if n == size && bytes.Equal(inspected.digest, hash) {
			return UploadResult{Bytes: size, ETag: strings.Trim(aws.ToString(head.ETag), "\""), Skipped: true}, nil
		}
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	metadata := map[string]string{"tgdl-sha256": hex.EncodeToString(inspected.digest)}
	var etag string
	if size <= s3PartSize {
		tracker := newTransferProgress(size, progress)
		body := newProgressSection(asReaderAt(src), 0, size, 0, tracker, ctx)
		out, e := p.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &p.bucket, Key: &key, Body: body, ContentLength: &size, ContentType: &contentType, Metadata: metadata, ContentMD5: &inspected.checksums[0]})
		if e != nil {
			return UploadResult{}, s3Error("PutObject", e)
		}
		etag = aws.ToString(out.ETag)
	} else {
		etag, err = p.multipart(ctx, key, contentType, metadata, src, size, inspected, progress)
		if err != nil {
			return UploadResult{}, err
		}
	}
	if etag == "" {
		return UploadResult{}, errors.New("S3 omitted uploaded object ETag")
	}
	// Acknowledgement is checked against the exact published version's ETag and
	// length; metadata alone is never accepted as proof of existing content.
	check, e := p.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &p.bucket, Key: &key, IfMatch: aws.String(etag)})
	if e != nil {
		return UploadResult{}, s3Error("verify upload", e)
	}
	if aws.ToInt64(check.ContentLength) != size || aws.ToString(check.ETag) != etag {
		return UploadResult{}, errors.New("S3 uploaded object has an unexpected size or ETag")
	}
	return UploadResult{Bytes: size, ETag: strings.Trim(etag, "\"")}, nil
}
func (p *s3Provider) multipart(ctx context.Context, key, contentType string, metadata map[string]string, src io.ReadSeeker, size int64, inspected s3Source, progress func(int64)) (etag string, err error) {
	partSize := inspected.partSize
	count := (size + partSize - 1) / partSize
	created, err := p.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &p.bucket, Key: &key, ContentType: &contentType, Metadata: metadata})
	if err != nil {
		return "", s3Error("CreateMultipartUpload", err)
	}
	id := created.UploadId
	if id == nil || *id == "" {
		return "", errors.New("S3 omitted multipart upload ID")
	}
	completed := false
	defer func() {
		if !completed {
			// Cancellation must not cancel the cleanup request itself. Join all part
			// requests before aborting; report cleanup failure instead of hiding it.
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, e := p.client.AbortMultipartUpload(cleanup, &s3.AbortMultipartUploadInput{Bucket: &p.bucket, Key: &key, UploadId: id})
			if e != nil {
				err = errors.Join(err, s3Error("AbortMultipartUpload", e))
			}
		}
	}()
	parts := make([]types.CompletedPart, count)
	reader := asReaderAt(src)
	tracker := newTransferProgress(size, progress)
	group, gctx := errgroup.WithContext(ctx)
	group.SetLimit(s3Parallel)
	for i := int64(0); i < count; i++ {
		if gctx.Err() != nil {
			break
		}
		i := i
		group.Go(func() error {
			offset := i * partSize
			length := min(partSize, size-offset)
			partNumber := int32(i + 1)
			body := newProgressSection(reader, offset, length, i, tracker, gctx)
			out, e := p.client.UploadPart(gctx, &s3.UploadPartInput{Bucket: &p.bucket, Key: &key, UploadId: id, PartNumber: &partNumber, Body: body, ContentLength: &length, ContentMD5: &inspected.checksums[i]})
			if e != nil {
				return s3Error("UploadPart", e)
			}
			if out.ETag == nil || *out.ETag == "" {
				return errors.New("S3 omitted uploaded part ETag")
			}
			parts[i] = types.CompletedPart{PartNumber: &partNumber, ETag: out.ETag}
			return nil
		})
	}
	if err = group.Wait(); err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	out, e := p.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &p.bucket, Key: &key, UploadId: id, MultipartUpload: &types.CompletedMultipartUpload{Parts: parts}})
	if e != nil {
		return "", s3Error("CompleteMultipartUpload", e)
	}
	completed = true
	return aws.ToString(out.ETag), nil
}
func (p *s3Provider) List(ctx context.Context, prefix string) ([]Object, error) {
	ctx, done, err := p.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	raw := strings.TrimSuffix(prefix, "/")
	if raw != "" {
		if err = validObject(raw); err != nil {
			return nil, err
		}
	}
	base := ""
	if p.prefix != "" {
		base = p.prefix + "/"
	}
	keyPrefix := base + prefix
	out := []Object{}
	seen := map[string]bool{}
	var token *string
	for {
		response, e := p.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: &p.bucket, Prefix: &keyPrefix, ContinuationToken: token, MaxKeys: aws.Int32(1000)})
		if e != nil {
			return nil, s3Error("ListObjectsV2", e)
		}
		for _, entry := range response.Contents {
			key := aws.ToString(entry.Key)
			if !strings.HasPrefix(key, keyPrefix) || !strings.HasPrefix(key, base) {
				return nil, errors.New("S3 returned an object outside the requested prefix")
			}
			name := strings.TrimPrefix(key, base)
			if strings.HasSuffix(name, "/") {
				continue
			}
			if e = validObject(name); e != nil {
				return nil, e
			}
			if aws.ToInt64(entry.Size) < 0 {
				return nil, errors.New("S3 returned a negative object size")
			}
			out = append(out, Object{Path: name, Size: aws.ToInt64(entry.Size), Modified: aws.ToTime(entry.LastModified)})
		}
		if !aws.ToBool(response.IsTruncated) {
			return out, nil
		}
		next := aws.ToString(response.NextContinuationToken)
		if next == "" || seen[next] {
			return nil, errors.New("S3 listing did not advance its continuation token")
		}
		seen[next] = true
		token = &next
	}
}
func (p *s3Provider) Delete(ctx context.Context, name string) error {
	ctx, done, err := p.begin(ctx)
	if err != nil {
		return err
	}
	defer done()
	key, err := p.key(name)
	if err != nil {
		return err
	}
	_, err = p.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &p.bucket, Key: &key})
	if s3Missing(err) {
		return nil
	}
	return s3Error("DeleteObject", err)
}

// Files supply ReaderAt natively. Other seekable sources are serialized, without
// buffering each complete part, so memory remains independent of object size.
type seekReaderAt struct {
	mu     sync.Mutex
	source io.ReadSeeker
}

func asReaderAt(src io.ReadSeeker) io.ReaderAt {
	if r, ok := src.(io.ReaderAt); ok {
		return r
	}
	return &seekReaderAt{source: src}
}
func (r *seekReaderAt) ReadAt(b []byte, offset int64) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, e := r.source.Seek(offset, io.SeekStart); e != nil {
		return 0, e
	}
	n, err := io.ReadFull(r.source, b)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF
	}
	return n, err
}

type transferProgress struct {
	mu          sync.Mutex
	parts       map[int64]int64
	total, size int64
	fn          func(int64)
}

func newTransferProgress(size int64, fn func(int64)) *transferProgress {
	return &transferProgress{parts: map[int64]int64{}, size: size, fn: fn}
}
func (p *transferProgress) read(part, position int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if position <= p.parts[part] {
		return
	}
	p.total += position - p.parts[part]
	p.parts[part] = position
	if p.fn != nil {
		p.fn(min(p.total, p.size))
	}
}

type progressSection struct {
	section  *io.SectionReader
	part     int64
	progress *transferProgress
	ctx      context.Context
}

func newProgressSection(r io.ReaderAt, offset, size, part int64, tracker *transferProgress, ctx context.Context) *progressSection {
	return &progressSection{io.NewSectionReader(r, offset, size), part, tracker, ctx}
}
func (r *progressSection) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.section.Read(b)
	pos, e := r.section.Seek(0, io.SeekCurrent)
	if e != nil {
		return n, e
	}
	if n > 0 {
		r.progress.read(r.part, pos)
	}
	return n, err
}
func (r *progressSection) Seek(offset int64, whence int) (int64, error) {
	return r.section.Seek(offset, whence)
}
