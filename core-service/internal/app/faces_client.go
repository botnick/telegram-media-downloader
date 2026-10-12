package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"
)

// The faces sidecar (faces-service/tgdl_faces/app.py) wire format:
//
//	GET  /health                 → {ok, ready, version, model, providers, features, max_upload_bytes, …}
//	POST /detect/batch           {files, min_score, min_box_px, ar_range} → {results:[{file, faces, error?, exif_oriented}]}
//	POST /detect                 {image_b64 | path, …} → {faces, exif_oriented?, error?}
//	POST /detect/upload?min_score&min_box_px&ar_lo&ar_hi  raw bytes → same as /detect (0.5.1+)
//	POST /detect/video           {path, …, max_frames} → {faces, error?}
//	GET  /providers, /info, POST /preload/{model}, GET /preload/{model}/status
//
// Every endpoint but /health needs X-API-Token when the sidecar has
// TGDL_FACES_API_TOKEN set. Per-file problems come back as 200 + `error`;
// 503 means the model is loading or failed to load.

const (
	facesHealthTTL     = 5 * time.Second
	facesHealthTimeout = 5 * time.Second
	facesTokenHeader   = "X-API-Token"
	facesUploadBudget  = 40 << 20 // request body budget (proxies cap bodies)
	facesUnauthorized  = "sidecar rejected the API token (401) — set faces.sidecarToken / TGDL_FACES_SIDECAR_TOKEN to the sidecar TGDL_FACES_API_TOKEN"
)

// errFacesNotConfigured: no sidecar URL; Local mode cannot be served by Go.
var errFacesNotConfigured = errors.New(facesLocalUnavailableMsg)

// errVideoUnreadable: the sidecar cannot open the video at its path. The
// Node app extracted frames locally with ffmpeg here; this server does not.
var errVideoUnreadable = errors.New("the face sidecar cannot read this video at its path (mount the downloads into the sidecar or set a path map)")

// facesUnavailableError: the sidecar gave no answer for reasons unrelated
// to the file (down, restarting, loading its model, timing out). The row
// must stay unscanned so a later scan retries it.
type facesUnavailableError struct {
	msg      string
	timedOut bool
	fatal    bool // retrying cannot help (rejected token)
	err      error
}

func (e *facesUnavailableError) Error() string { return e.msg }
func (e *facesUnavailableError) Unwrap() error { return e.err }

func isFacesUnavailable(err error) bool {
	var target *facesUnavailableError
	return errors.As(err, &target) || errors.Is(err, errFacesNotConfigured)
}

type facesDetectParams struct {
	MinScore float64
	MinBoxPx int
	ARRange  [2]float64
}

type detectedFace struct {
	X, Y, W, H   float64
	Score        float64
	QualityScore *float64
	Embedding    []float32
	ExifOriented bool
	FrameTimeSec *float64
}

// storedQuality is the value stored in faces.quality_score: the sidecar's
// composite quality, else the detector score (scan-runner.js).
func (f detectedFace) storedQuality() any {
	if f.QualityScore != nil {
		return *f.QualityScore
	}
	return f.Score
}

// fileDetection is one file's answer. answered=false is the Node `null`:
// the sidecar reached no verdict for the file (it is still stamped).
type fileDetection struct {
	faces    []detectedFace
	answered bool
}

type wireFace struct {
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	W            float64   `json:"w"`
	H            float64   `json:"h"`
	Score        *float64  `json:"score"`
	QualityScore *float64  `json:"quality_score"`
	Embedding    []float32 `json:"embedding"`
	FrameTimeSec *float64  `json:"frame_time_sec"`
}

type wireDetect struct {
	Faces        []wireFace `json:"faces"`
	Error        string     `json:"error"`
	Code         string     `json:"code"`
	ExifOriented bool       `json:"exif_oriented"`
}

func parseWireFaces(faces []wireFace, exifOriented bool) []detectedFace {
	out := make([]detectedFace, 0, len(faces))
	for _, f := range faces {
		if len(f.Embedding) == 0 {
			continue
		}
		face := detectedFace{X: f.X, Y: f.Y, W: f.W, H: f.H, QualityScore: f.QualityScore, Embedding: f.Embedding, ExifOriented: exifOriented, FrameTimeSec: f.FrameTimeSec}
		if f.Score != nil {
			face.Score = *f.Score
		}
		out = append(out, face)
	}
	return out
}

// facesHealth is the parsed /health answer (faces-client.js health()).
type facesHealth struct {
	OK                 bool     `json:"ok"`
	Version            any      `json:"version"`
	Model              any      `json:"model"`
	Dim                any      `json:"dim"`
	Ready              bool     `json:"ready"`
	ProvidersResolved  []string `json:"providersResolved"`
	ProvidersRequested any      `json:"providersRequested"`
	DetSize            any      `json:"detSize"`
	Platform           any      `json:"platform"`
	Python             any      `json:"python"`
	Features           []string `json:"features"`
	Error              string   `json:"error,omitempty"`
}

// facesClient talks to one sidecar. configure() is called with fresh
// settings before every unit of work, so URL / token / path-map edits take
// effect without a restart.
type facesClient struct {
	http *http.Client

	mu           sync.Mutex
	url          string
	token        string
	rules        []facesPathRule
	timeout      time.Duration
	retries      int
	backoff      []time.Duration
	bytesMode    bool // the sidecar cannot read our paths: send file bytes
	features     []string
	featuresSeen bool
	maxUpload    int64
	health       facesHealth
	healthAt     time.Time
	healthURL    string
	limit        int
	slots        chan struct{}
}

func newFacesClient() *facesClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 0 // per-request contexts carry the deadlines
	return &facesClient{http: &http.Client{Transport: transport}}
}

func (c *facesClient) configure(s facesSettings) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s.URL != c.url {
		c.url = s.URL
		c.resetLocked()
	}
	c.token, c.rules = s.Token, s.PathMap
	c.timeout, c.retries, c.backoff = s.RequestTimeout, s.MaxRetries, s.RetryBackoff
	if s.MaxConcurrency != c.limit || (c.slots == nil && s.MaxConcurrency > 0) {
		c.limit = s.MaxConcurrency
		c.slots = nil
		if c.limit > 0 {
			c.slots = make(chan struct{}, c.limit)
		}
	}
}

// reset forgets everything learned about the sidecar (restart button).
func (c *facesClient) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resetLocked()
}

func (c *facesClient) resetLocked() {
	c.bytesMode, c.features, c.featuresSeen, c.maxUpload = false, nil, false, 0
	c.health, c.healthAt, c.healthURL = facesHealth{}, time.Time{}, ""
}

func (c *facesClient) baseURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.url
}

// acquire bounds the requests in flight (sidecarMaxConcurrency, 0 = no cap).
func (c *facesClient) acquire(ctx context.Context) (func(), error) {
	c.mu.Lock()
	slots := c.slots
	c.mu.Unlock()
	if slots == nil {
		return func() {}, nil
	}
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *facesClient) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	c.mu.Lock()
	base, token := c.url, c.token
	c.mu.Unlock()
	if base == "" {
		return nil, errFacesNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set(facesTokenHeader, token)
	}
	return c.http.Do(req)
}

func (c *facesClient) noteHealth(body map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.features, c.featuresSeen = stringValues(body["features"]), true
	c.maxUpload = int64(number(body["max_upload_bytes"], 0))
}

func stringValues(value any) []string {
	out := []string{}
	for _, item := range anyList(value) {
		out = append(out, toString(item))
	}
	return out
}

// Health probes /health, cached for five seconds. It never fails: problems
// come back as OK=false with Error set.
func (c *facesClient) Health(ctx context.Context) facesHealth {
	c.mu.Lock()
	base := c.url
	if base == "" {
		c.mu.Unlock()
		return facesHealth{Error: "sidecar_url_unset"}
	}
	if c.healthURL == base && time.Since(c.healthAt) < facesHealthTTL {
		h := c.health
		c.mu.Unlock()
		return h
	}
	c.mu.Unlock()
	var h facesHealth
	for attempt := 0; attempt < 2; attempt++ {
		var retry bool
		h, retry = c.probeHealth(ctx)
		if !retry || ctx.Err() != nil {
			break
		}
	}
	c.mu.Lock()
	if c.url == base {
		c.health, c.healthAt, c.healthURL = h, time.Now(), base
	}
	c.mu.Unlock()
	return h
}

func (c *facesClient) probeHealth(ctx context.Context) (facesHealth, bool) {
	probeCtx, cancel := context.WithTimeout(ctx, facesHealthTimeout)
	defer cancel()
	res, err := c.request(probeCtx, http.MethodGet, "/health", nil, "")
	if err != nil {
		return facesHealth{Error: err.Error()}, true
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return facesHealth{Error: "http_" + strconv.Itoa(res.StatusCode)}, res.StatusCode >= 500
	}
	var body map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return facesHealth{Error: "invalid health JSON: " + err.Error()}, false
	}
	c.noteHealth(body)
	h := facesHealth{
		OK: body["ok"] == true, Version: body["version"], Model: body["model"], Dim: body["dim"],
		Ready: body["ready"] == true, ProvidersRequested: body["providers_requested"],
		Platform: body["platform"], Python: body["python"], Features: stringValues(body["features"]),
	}
	if _, ok := body["det_size"].(float64); ok {
		h.DetSize = body["det_size"]
	}
	if providers, ok := body["providers_resolved"].([]any); ok {
		h.ProvidersResolved = stringValues(providers)
	} else if providers, ok := body["providers"].([]any); ok {
		h.ProvidersResolved = stringValues(providers)
	}
	if !h.OK {
		h.Error = firstNonEmpty(toString(body["error"]), "sidecar_not_ok")
	}
	return h, false
}

// probeReady is one uncached readiness check (model loaded).
func (c *facesClient) probeReady(ctx context.Context) (bool, string) {
	h, _ := c.probeHealth(ctx)
	switch {
	case h.OK && h.Ready:
		return true, ""
	case h.OK:
		return false, "model_loading"
	default:
		return false, h.Error
	}
}

// WaitReady blocks until the sidecar answers /health with a loaded model,
// polling with backoff (1 s → 15 s), or until timeout / ctx.
func (c *facesClient) WaitReady(ctx context.Context, timeout time.Duration, logf func(string, ...any)) bool {
	deadline := time.Now().Add(timeout)
	delay := time.Second
	announced := false
	reason := "sidecar_url_unset"
	for ctx.Err() == nil {
		if c.baseURL() != "" {
			ok, why := c.probeReady(ctx)
			if ok {
				if announced {
					logf("face sidecar ready at %s", c.baseURL())
				}
				return true
			}
			reason = why
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		if !announced {
			announced = true
			logf("waiting for the face sidecar (%s) — up to %d s", reason, int(remaining.Seconds()))
		}
		timer := time.NewTimer(min(delay, remaining))
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
		timer.Stop()
		delay = min(delay*2, 15*time.Second)
	}
	if ctx.Err() == nil {
		logf("face sidecar still not ready (%s)", reason)
	}
	return false
}

// unavailableFrom classifies a failed request; reqCtx carries its deadline.
func unavailableFrom(reqCtx context.Context, err error, timeout time.Duration) error {
	if errors.Is(err, errFacesNotConfigured) {
		return err
	}
	if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
		return &facesUnavailableError{msg: fmt.Sprintf("timed out after %d ms", timeout.Milliseconds()), timedOut: true, err: err}
	}
	return &facesUnavailableError{msg: "network error — " + err.Error(), err: err}
}

func statusUnavailable(status int) bool {
	return status >= 500 || status == http.StatusRequestTimeout || status == http.StatusTooManyRequests
}

// DetectBatch sends files to /detect/batch in path mode and falls back to
// sending bytes for files the sidecar cannot see (detectFacesBatch()). The
// answer has one entry per input. It returns a *facesUnavailableError when
// the sidecar, not the files, is the problem; a cancelled ctx returns
// unanswered entries and no error.
func (c *facesClient) DetectBatch(ctx context.Context, paths []string, p facesDetectParams, timeout time.Duration, logf func(string, ...any)) ([]fileDetection, error) {
	out := make([]fileDetection, len(paths))
	if len(paths) == 0 {
		return out, nil
	}
	c.mu.Lock()
	bytesMode, rules := c.bytesMode, c.rules
	if timeout <= 0 {
		timeout = max(time.Duration(len(paths))*c.timeout, 2*time.Minute)
	}
	c.mu.Unlock()
	if bytesMode {
		for i, path := range paths {
			if ctx.Err() != nil {
				return out, nil
			}
			det, err := c.DetectBytes(ctx, path, p, logf)
			if err != nil {
				return out, err
			}
			out[i] = det
		}
		return out, nil
	}
	sent := make([]string, len(paths))
	for i, path := range paths {
		sent[i] = toSidecarPath(path, rules)
	}
	body, _ := json.Marshal(map[string]any{"files": sent, "min_score": p.MinScore, "min_box_px": p.MinBoxPx, "ar_range": p.ARRange})
	release, err := c.acquire(ctx)
	if err != nil {
		return out, nil
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	res, err := c.request(reqCtx, http.MethodPost, "/detect/batch", bytes.NewReader(body), "application/json")
	var parsed struct {
		Results []struct {
			File string `json:"file"`
			wireDetect
		} `json:"results"`
	}
	if err == nil {
		if res.StatusCode == http.StatusOK {
			err = json.NewDecoder(res.Body).Decode(&parsed)
			if err != nil && reqCtx.Err() == nil {
				err = &facesUnavailableError{msg: "invalid JSON — " + err.Error(), err: err}
			}
		}
		res.Body.Close()
	}
	cancel()
	release()
	if ctx.Err() != nil {
		return out, nil
	}
	if err != nil {
		var unavailable *facesUnavailableError
		if errors.As(err, &unavailable) {
			return out, err
		}
		return out, unavailableFrom(reqCtx, err, timeout)
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return out, &facesUnavailableError{msg: facesUnauthorized, fatal: true}
	case statusUnavailable(res.StatusCode):
		return out, &facesUnavailableError{msg: fmt.Sprintf("sidecar returned %d", res.StatusCode)}
	case res.StatusCode != http.StatusOK:
		logf("detect batch: sidecar returned %d", res.StatusCode)
		return out, nil
	}
	byFile := make(map[string]int, len(parsed.Results))
	for i, item := range parsed.Results {
		byFile[item.File] = i
	}
	var rejected, unseen []int
	for i := range paths {
		k, ok := byFile[sent[i]]
		if !ok {
			continue
		}
		item := parsed.Results[k]
		switch item.Error {
		case "":
			out[i] = fileDetection{faces: parseWireFaces(item.Faces, item.ExifOriented), answered: true}
		case "path_not_allowed":
			rejected = append(rejected, i)
		case "file_not_found":
			unseen = append(unseen, i)
		default:
			// decode_failed etc.: the sidecar reached the file.
			logf("batch detect %s: sidecar soft-error=%q", paths[i], item.Error)
			out[i] = fileDetection{faces: []detectedFace{}, answered: true}
		}
	}
	if len(rejected) > 0 {
		logf("path mode rejected by sidecar; switching to sending file bytes for all files")
		c.setBytesMode()
	}
	for _, idxs := range [][]int{rejected, unseen} {
		for _, i := range idxs {
			if ctx.Err() != nil {
				return out, nil
			}
			det, err := c.DetectBytes(ctx, paths[i], p, logf)
			if err != nil {
				return out, err
			}
			out[i] = det
			if det.answered && !c.isBytesMode() {
				logf("sidecar cannot see files at their local paths (external sidecar?); switching to sending file bytes for all files")
				c.setBytesMode()
			}
		}
	}
	return out, nil
}

func (c *facesClient) setBytesMode() {
	c.mu.Lock()
	c.bytesMode = true
	c.mu.Unlock()
}

func (c *facesClient) isBytesMode() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytesMode
}

// DetectBytes sends one file's bytes: raw to /detect/upload when the
// sidecar lists the `upload` feature, base64 JSON to /detect otherwise.
// Files over the request budget are sent unchanged; the sidecar answers
// 413, recorded as a soft error (the Node app downscaled them first).
func (c *facesClient) DetectBytes(ctx context.Context, path string, p facesDetectParams, logf func(string, ...any)) (fileDetection, error) {
	data, err := os.ReadFile(path) // #nosec G304 -- a stored download path resolved under the media roots.
	if err != nil {
		logf("detect: read %s failed: %v", path, err)
		return fileDetection{}, nil
	}
	c.mu.Lock()
	seen := c.featuresSeen
	c.mu.Unlock()
	if !seen {
		_ = c.Health(ctx)
	}
	c.mu.Lock()
	upload := containsString(c.features, "upload")
	c.mu.Unlock()
	for {
		var res *http.Response
		var err error
		if upload {
			q := url.Values{}
			q.Set("min_score", strconv.FormatFloat(p.MinScore, 'f', -1, 64))
			q.Set("min_box_px", strconv.Itoa(p.MinBoxPx))
			q.Set("ar_lo", strconv.FormatFloat(p.ARRange[0], 'f', -1, 64))
			q.Set("ar_hi", strconv.FormatFloat(p.ARRange[1], 'f', -1, 64))
			res, err = c.postWithRetry(ctx, "/detect/upload?"+q.Encode(), data, "application/octet-stream", logf)
			if err == nil && (res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusMethodNotAllowed) {
				res.Body.Close()
				// Replaced by an older sidecar since /health was read.
				c.mu.Lock()
				c.features = removeString(c.features, "upload")
				c.mu.Unlock()
				upload = false
				continue
			}
		} else {
			body, _ := json.Marshal(map[string]any{"image_b64": base64.StdEncoding.EncodeToString(data), "min_score": p.MinScore, "min_box_px": p.MinBoxPx, "ar_range": p.ARRange})
			res, err = c.postWithRetry(ctx, "/detect", body, "application/json", logf)
		}
		if err != nil {
			return fileDetection{}, err
		}
		return c.readDetect(ctx, res, path, logf)
	}
}

func removeString(values []string, target string) []string {
	out := values[:0:0]
	for _, value := range values {
		if value != target {
			out = append(out, value)
		}
	}
	return out
}

func (c *facesClient) readDetect(ctx context.Context, res *http.Response, path string, logf func(string, ...any)) (fileDetection, error) {
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return fileDetection{}, &facesUnavailableError{msg: facesUnauthorized, fatal: true}
	case res.StatusCode == http.StatusRequestEntityTooLarge:
		logf("detect %s: file is over the sidecar upload limit — 0 faces stored", path)
		return fileDetection{faces: []detectedFace{}, answered: true}, nil
	case res.StatusCode != http.StatusOK:
		logf("detect %s: sidecar returned %d", path, res.StatusCode)
		return fileDetection{}, nil
	}
	var body wireDetect
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		if ctx.Err() != nil {
			return fileDetection{}, nil
		}
		return fileDetection{}, &facesUnavailableError{msg: "invalid JSON from sidecar: " + err.Error(), err: err}
	}
	if body.Error != "" {
		logf("detect %s: sidecar soft-error=%q — 0 faces stored", path, body.Error)
	}
	return fileDetection{faces: parseWireFaces(body.Faces, body.ExifOriented), answered: true}, nil
}

// postWithRetry retries 5xx / 408 / 429 and network errors with backoff;
// other answers (200, 4xx) are returned for the caller to read.
func (c *facesClient) postWithRetry(ctx context.Context, path string, body []byte, contentType string, logf func(string, ...any)) (*http.Response, error) {
	c.mu.Lock()
	retries, backoff, timeout := c.retries, c.backoff, c.timeout
	c.mu.Unlock()
	retries = max(retries, 1)
	var lastErr error
	for attempt := 0; attempt < retries; attempt++ {
		release, err := c.acquire(ctx)
		if err != nil {
			return nil, err
		}
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		res, err := c.request(reqCtx, http.MethodPost, path, bytes.NewReader(body), contentType)
		if err == nil && !statusUnavailable(res.StatusCode) {
			// The body is read under the request deadline by the caller.
			res.Body = &cancelOnClose{ReadCloser: res.Body, cancel: cancel, release: release}
			return res, nil
		}
		timedOut := reqCtx.Err() != nil && ctx.Err() == nil
		if err == nil {
			res.Body.Close()
			lastErr = &facesUnavailableError{msg: fmt.Sprintf("sidecar returned %d", res.StatusCode)}
		} else {
			lastErr = unavailableFrom(reqCtx, err, timeout)
		}
		cancel()
		release()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, errFacesNotConfigured) || timedOut {
			// A slow sidecar only gets slower with more requests piled on.
			return nil, lastErr
		}
		logf("sidecar POST %s attempt %d/%d failed: %v", path, attempt+1, retries, lastErr)
		if attempt < retries-1 {
			wait := backoff[min(attempt, len(backoff)-1)]
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
	}
	return nil, lastErr
}

type cancelOnClose struct {
	io.ReadCloser
	cancel  context.CancelFunc
	release func()
	once    sync.Once
}

func (b *cancelOnClose) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() { b.cancel(); b.release() })
	return err
}

// DetectVideo asks /detect/video for the faces of one video in path mode.
func (c *facesClient) DetectVideo(ctx context.Context, path string, p facesDetectParams, maxFrames int, logf func(string, ...any)) (fileDetection, error) {
	c.mu.Lock()
	rules, perFrame, bytesMode := c.rules, c.timeout, c.bytesMode
	c.mu.Unlock()
	if bytesMode {
		return fileDetection{}, errVideoUnreadable
	}
	timeout := max(time.Duration(maxFrames)*perFrame, 5*time.Minute)
	body, _ := json.Marshal(map[string]any{"path": toSidecarPath(path, rules), "min_score": p.MinScore, "min_box_px": p.MinBoxPx, "ar_range": p.ARRange, "max_frames": maxFrames})
	release, err := c.acquire(ctx)
	if err != nil {
		return fileDetection{}, nil
	}
	defer release()
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := c.request(reqCtx, http.MethodPost, "/detect/video", bytes.NewReader(body), "application/json")
	if err != nil {
		if ctx.Err() != nil {
			return fileDetection{}, nil
		}
		return fileDetection{}, unavailableFrom(reqCtx, err, timeout)
	}
	defer res.Body.Close()
	var parsed wireDetect
	decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&parsed)
	switch {
	case res.StatusCode == http.StatusForbidden && parsed.Code == "path_not_allowed":
		return fileDetection{}, errVideoUnreadable
	case res.StatusCode == http.StatusUnauthorized:
		return fileDetection{}, &facesUnavailableError{msg: facesUnauthorized, fatal: true}
	case statusUnavailable(res.StatusCode):
		return fileDetection{}, &facesUnavailableError{msg: fmt.Sprintf("sidecar returned %d", res.StatusCode)}
	case res.StatusCode != http.StatusOK:
		logf("detect video %s: sidecar returned %d", path, res.StatusCode)
		return fileDetection{}, nil
	case decodeErr != nil:
		if ctx.Err() != nil {
			return fileDetection{}, nil
		}
		return fileDetection{}, unavailableFrom(reqCtx, decodeErr, timeout)
	case parsed.Error == "file_not_found":
		return fileDetection{}, errVideoUnreadable
	case parsed.Error != "":
		logf("detect video %s: sidecar soft-error=%q", path, parsed.Error)
		return fileDetection{faces: []detectedFace{}, answered: true}, nil
	}
	return fileDetection{faces: parseWireFaces(parsed.Faces, false), answered: true}, nil
}

// Proxy forwards a small GET/POST to the sidecar and returns its status and
// JSON body (provider probe, model preload).
func (c *facesClient) Proxy(ctx context.Context, method, path string, timeout time.Duration) (int, any, error) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := c.request(reqCtx, method, path, nil, "")
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	var body any
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return res.StatusCode, nil, fmt.Errorf("sidecar returned HTTP %d without JSON", res.StatusCode)
	}
	return res.StatusCode, body, nil
}

// facesProbe is the dashboard's "Test" button for a typed URL
// (sidecar-remote.js probeSidecar). It never fails.
type facesProbe struct {
	OK           bool
	Reachable    bool
	Version      any
	Features     []string
	Health       map[string]any
	Auth         string // ok | failed | open | unknown
	AuthRequired any
	Error        any
}

func probeFacesSidecar(ctx context.Context, client *http.Client, base, token string) facesProbe {
	out := facesProbe{Auth: "unknown", Features: []string{}}
	do := func(method, path string, body []byte) (*http.Response, error) {
		reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, method, base+path, bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set(facesTokenHeader, token)
		}
		res, err := client.Do(req)
		if err != nil {
			cancel()
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, errors.New("timeout")
			}
			return nil, err
		}
		res.Body = &cancelOnClose{ReadCloser: res.Body, cancel: cancel, release: func() {}}
		return res, nil
	}
	res, err := do(http.MethodGet, "/health", nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Reachable = true
	var health map[string]any
	decodeErr := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&health)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || decodeErr != nil || health == nil {
		if res.StatusCode == http.StatusOK {
			out.Error = "not a sidecar (" + firstNonEmpty(res.Header.Get("Content-Type"), "no content-type") + ")"
		} else {
			out.Error = "http_" + strconv.Itoa(res.StatusCode)
		}
		return out
	}
	out.Health, out.Version, out.Features = health, health["version"], stringValues(health["features"])
	if required, ok := health["auth_required"].(bool); ok {
		out.AuthRequired = required
	}
	// An empty /detect is a cheap token check: 401 = rejected, 400 = accepted.
	if res, err := do(http.MethodPost, "/detect", []byte("{}")); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusUnauthorized:
			out.Auth = "failed"
			if out.AuthRequired == nil {
				out.AuthRequired = true
			}
		case token != "":
			out.Auth = "ok"
		default:
			out.Auth = "open"
		}
	}
	if out.Auth == "failed" {
		out.Error = "token_required"
		if token != "" {
			out.Error = "token_rejected"
		}
	}
	out.OK = health["ok"] == true && out.Auth != "failed"
	if !out.OK && out.Error == nil {
		out.Error = "unhealthy"
	}
	return out
}
