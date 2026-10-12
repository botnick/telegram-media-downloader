package app

import (
	"context"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Face clustering defaults of the released Node app (src/core/ai/faces.js
// FACE_DEFAULTS, scan-runner.js and faces-client.js).
const (
	facesDefaultEpsilon      = 1.05
	facesDefaultMinPoints    = 2
	facesDefaultMinScore     = 0.5
	facesDefaultMinBoxPx     = 60
	facesDefaultBatchSize    = 16
	facesDefaultThrottle     = 0.5
	facesDefaultSidecarWait  = 5 * time.Minute
	facesDefaultRequestTime  = time.Minute
	facesDefaultMaxRetries   = 3
	facesDefaultVideoFrames  = 120
	facesLocalUnavailableMsg = "no face sidecar is configured: this server cannot start a local sidecar, so set an External sidecar URL in Safety & AI → Faces (or FACES_SERVICE_URL / TGDL_FACES_SIDECAR_URL) pointing at a running tgdl-faces service"
)

// facesSettings is advanced.ai resolved the way the Node app resolved it:
// TGDL_FACES_* env overrides, the nested advanced.ai.faces block and the
// legacy flat advanced.ai aliases, then the hardcoded defaults.
type facesSettings struct {
	Enabled        bool
	FaceClustering bool

	URL        string // sidecar base URL, "" when none is configured
	Mode       string // external | docker | override | ""
	URLSource  string // env | config
	Token      string
	TokenEnv   bool
	PathMapRaw string
	PathMapEnv bool
	PathMap    []facesPathRule

	MinScore float64
	MinBoxPx int
	ARRange  [2]float64

	ScanTypes       []string // photo phase of the scan (faces.fileTypes first)
	BackgroundTypes []string // per-download hook (advanced.ai.fileTypes)
	ScanVideos      bool
	VideoMaxFrames  int
	ExcludeExts     map[string]bool

	BatchSize      int
	ThrottleRatio  float64
	SidecarWait    time.Duration
	RequestTimeout time.Duration
	MaxRetries     int
	RetryBackoff   []time.Duration
	MaxConcurrency int

	Epsilon       float64
	MinPoints     float64
	LabelMatchEps float64

	AutoScan         string
	AutoScanInterval time.Duration
	AutoScanBatch    int
	AutoScanCeiling  int

	Providers     string
	DetectorModel string
	FacesModel    string
	FederateFaces bool
}

// statusTypes are the file types the status counters and auto-scan cover:
// advanced.ai.fileTypes plus video when video scanning is on.
func (s facesSettings) statusTypes() []string {
	types := append([]string(nil), s.BackgroundTypes...)
	if s.ScanVideos && !containsString(types, "video") {
		types = append(types, "video")
	}
	return types
}

func (s facesSettings) detectParams() facesDetectParams {
	return facesDetectParams{MinScore: s.MinScore, MinBoxPx: s.MinBoxPx, ARRange: s.ARRange}
}

func (a *App) facesSettings(ctx context.Context) (facesSettings, error) {
	raw, err := a.config.Load(ctx)
	if err != nil {
		return facesSettings{}, err
	}
	return resolveFacesSettings(effectiveConfig(raw), os.Getenv), nil
}

func resolveFacesSettings(cfg map[string]any, getenv func(string) string) facesSettings {
	ai := objectAt(cfg, "advanced", "ai")
	if ai == nil {
		ai = map[string]any{}
	}
	faces, _ := ai["faces"].(map[string]any)
	if faces == nil {
		faces = map[string]any{}
	}
	env := func(name string) any {
		value := strings.TrimSpace(getenv(name))
		if value == "" {
			return nil
		}
		n, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return nil
		}
		return n
	}
	envList := func(name string) []string {
		value := strings.TrimSpace(getenv(name))
		if value == "" {
			return nil
		}
		return splitList(value)
	}
	s := facesSettings{
		Enabled:        ai["enabled"] == true,
		FaceClustering: ai["faceClustering"] != false,
		ScanVideos:     faces["scanVideos"] == true,
		Providers:      strings.ToLower(stringOr(faces["providers"], "auto")),
		FacesModel:     stringOr(ai["facesModel"], ""),
		FederateFaces:  ai["federateFaces"] == true,
		AutoScan:       normalizeAutoScan(ai["autoScan"]),
	}
	if s.Providers == "" {
		s.Providers = "auto"
	}
	s.DetectorModel = firstNonEmpty(stringOr(faces["detectorModel"], ""), stringOr(ai["facesDetectorModel"], ""), "buffalo_l")

	// Sidecar location, in faces-spawn.js order: the dashboard's external
	// URL (TGDL_FACES_SIDECAR_URL overrides it), the compose/docker
	// FACES_SERVICE_URL, then the legacy flat facesServiceUrl.
	if value := normalizeSidecarURL(getenv("TGDL_FACES_SIDECAR_URL")); value != "" {
		s.URL, s.Mode, s.URLSource = value, "external", "env"
	} else if value := normalizeSidecarURL(stringOr(faces["sidecarUrl"], "")); value != "" {
		s.URL, s.Mode, s.URLSource = value, "external", "config"
	} else if value := normalizeSidecarURL(getenv("FACES_SERVICE_URL")); value != "" {
		s.URL, s.Mode, s.URLSource = value, "docker", "env"
	} else if value := normalizeSidecarURL(stringOr(ai["facesServiceUrl"], "")); value != "" {
		s.URL, s.Mode, s.URLSource = value, "override", "config"
	}
	if value := strings.TrimSpace(getenv("TGDL_FACES_SIDECAR_TOKEN")); value != "" {
		s.Token, s.TokenEnv = value, true
	} else {
		s.Token = stringOr(faces["sidecarToken"], "")
	}
	if value := strings.TrimSpace(getenv("TGDL_FACES_PATH_MAP")); value != "" {
		s.PathMapRaw, s.PathMapEnv = value, true
	} else {
		s.PathMapRaw = stringOr(faces["pathMap"], "")
	}
	s.PathMap = parseFacesPathMap(s.PathMapRaw)

	// Detection thresholds (faces-client.js: flat alias first, then nested).
	s.MinScore = pickFinite(facesDefaultMinScore, env("TGDL_FACES_MIN_DETECTION_SCORE"), ai["minDetectionScore"], faces["minDetectionScore"])
	s.MinBoxPx = int(math.Round(pickFinite(facesDefaultMinBoxPx, env("TGDL_FACES_MIN_FACE_SIZE_PX"), ai["minFaceSizePx"], faces["minFaceSizePx"])))
	if s.MinBoxPx < 1 {
		s.MinBoxPx = 1
	}
	s.ARRange = [2]float64{0.5, 2.0}
	if ar, ok := faces["arRange"].([]any); ok && len(ar) == 2 {
		lo, hi := number(ar[0], math.NaN()), number(ar[1], math.NaN())
		if lo > 0 && hi > lo {
			s.ARRange = [2]float64{lo, hi}
		}
	}

	// File types: faces.fileTypes > advanced.ai.fileTypes > env > photo.
	s.BackgroundTypes = stringList(ai["fileTypes"])
	if len(s.BackgroundTypes) == 0 {
		s.BackgroundTypes = []string{"photo"}
	}
	switch {
	case len(stringList(faces["fileTypes"])) > 0:
		s.ScanTypes = stringList(faces["fileTypes"])
	case len(stringList(ai["fileTypes"])) > 0:
		s.ScanTypes = stringList(ai["fileTypes"])
	case len(envList("TGDL_FACES_FILE_TYPES")) > 0:
		s.ScanTypes = envList("TGDL_FACES_FILE_TYPES")
	default:
		s.ScanTypes = []string{"photo"}
	}
	exclude := stringList(faces["excludeExtensions"])
	if len(exclude) == 0 {
		exclude = envList("TGDL_FACES_EXCLUDE_EXTENSIONS")
	}
	s.ExcludeExts = map[string]bool{}
	for _, ext := range exclude {
		ext = strings.ToLower(ext)
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		s.ExcludeExts[ext] = true
	}
	s.VideoMaxFrames = int(pickFinite(facesDefaultVideoFrames, faces["videoMaxFrames"], ai["videoMaxFrames"]))
	s.VideoMaxFrames = min(max(s.VideoMaxFrames, 1), 500)

	batch := pickFinite(facesDefaultBatchSize, faces["batchSize"], ai["batchSize"], env("TGDL_FACES_BATCH_SIZE"))
	s.BatchSize = min(max(int(batch), 1), 200)
	s.ThrottleRatio = math.Max(0, math.Min(5, pickFinite(facesDefaultThrottle, faces["cpuThrottleRatio"], ai["cpuThrottleRatio"], env("TGDL_FACES_CPU_THROTTLE_RATIO"))))
	s.SidecarWait = time.Duration(math.Max(0, pickFinite(float64(facesDefaultSidecarWait.Milliseconds()), env("TGDL_FACES_SIDECAR_WAIT_MS"), faces["sidecarWaitMs"]))) * time.Millisecond
	s.RequestTimeout = time.Duration(math.Max(1000, pickFinite(float64(facesDefaultRequestTime.Milliseconds()), env("TGDL_FACES_REQUEST_TIMEOUT_MS"), faces["requestTimeoutMs"]))) * time.Millisecond
	s.MaxRetries = max(1, int(pickFinite(facesDefaultMaxRetries, env("TGDL_FACES_MAX_RETRIES"), faces["maxRetries"])))
	for _, raw := range anyList(faces["retryBackoffMs"]) {
		if ms := number(raw, -1); ms >= 0 {
			s.RetryBackoff = append(s.RetryBackoff, time.Duration(ms)*time.Millisecond)
		}
	}
	if len(s.RetryBackoff) == 0 {
		s.RetryBackoff = []time.Duration{300 * time.Millisecond, 600 * time.Millisecond, 1200 * time.Millisecond}
	}
	s.MaxConcurrency = max(0, int(pickFinite(0, env("TGDL_FACES_MAX_CONCURRENCY"), faces["sidecarMaxConcurrency"])))

	// Clustering knobs (scan-runner.js Phase B).
	s.Epsilon = pickFinite(facesDefaultEpsilon, env("TGDL_FACES_EPSILON"), faces["epsilon"], ai["facesEpsilon"])
	s.MinPoints = math.Max(2, pickFinite(facesDefaultMinPoints, env("TGDL_FACES_MIN_POINTS"), faces["minPoints"], ai["facesMinPoints"]))
	s.LabelMatchEps = pickFinite(math.Max(0.2, math.Min(0.6, s.Epsilon*0.9)), faces["labelMatchEps"], ai["facesLabelMatchEps"], env("TGDL_FACES_LABEL_MATCH_EPS"))

	s.AutoScanInterval = time.Duration(min(max(number(ai["autoScanIntervalMs"], 60000), 5000), 3600000)) * time.Millisecond
	s.AutoScanBatch = max(1, int(number(ai["autoScanBatchSize"], 10)))
	s.AutoScanCeiling = max(1, int(number(ai["autoScanQueueCeiling"], 50)))
	return s
}

// pickFinite returns the first candidate that is a finite JSON number.
// Strings are not numbers here, as in the Node Number.isFinite checks.
func pickFinite(fallback float64, candidates ...any) float64 {
	for _, candidate := range candidates {
		if n, ok := candidate.(float64); ok && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	}
	return fallback
}

func anyList(value any) []any {
	list, _ := value.([]any)
	return list
}

func stringList(value any) []string {
	var out []string
	for _, item := range anyList(value) {
		if text := strings.ToLower(strings.TrimSpace(toString(item))); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func splitList(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if part = strings.ToLower(strings.TrimSpace(part)); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// normalizeSidecarURL trims whitespace and trailing slashes; only http(s)
// URLs are accepted.
func normalizeSidecarURL(value string) string {
	value = strings.TrimSpace(value)
	end := len(value)
	for end > 0 && value[end-1] == '/' {
		end--
	}
	value = value[:end]
	lower := strings.ToLower(value)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return ""
	}
	return value
}

// facesPathRule maps an app path prefix to the path an external sidecar
// sees (sidecar-remote.js parsePathMap / toSidecarPath).
type facesPathRule struct{ From, To string }

// parseFacesPathMap reads `appPath=sidecarPath` rules separated by
// newlines or `;` (`=>` also works), longest prefix first.
func parseFacesPathMap(raw string) []facesPathRule {
	var rules []facesPathRule
	for _, line := range strings.FieldsFunc(raw, func(r rune) bool { return r == '\n' || r == '\r' || r == ';' }) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		sep, width := strings.Index(line, "=>"), 2
		if sep < 0 {
			sep, width = strings.Index(line, "="), 1
		}
		if sep <= 0 {
			continue
		}
		from, to := strings.TrimSpace(line[:sep]), strings.TrimSpace(line[sep+width:])
		if from != "" && to != "" {
			rules = append(rules, facesPathRule{From: from, To: to})
		}
	}
	sort.SliceStable(rules, func(i, j int) bool { return len(canonPath(rules[i].From)) > len(canonPath(rules[j].From)) })
	return rules
}

func isWindowsPath(p string) bool {
	if strings.HasPrefix(p, `\\`) {
		return true
	}
	return len(p) >= 2 && p[1] == ':' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) && (len(p) == 2 || p[2] == '/' || p[2] == '\\')
}

func canonPath(p string) string {
	c := strings.ReplaceAll(p, `\`, "/")
	for len(c) > 1 && strings.HasSuffix(c, "/") && !(len(c) == 3 && c[1] == ':') {
		c = c[:len(c)-1]
	}
	return c
}

// toSidecarPath rewrites a local path with the first matching rule.
func toSidecarPath(p string, rules []facesPathRule) string {
	for _, rule := range rules {
		src, base := canonPath(p), canonPath(rule.From)
		a, b := src, base
		if isWindowsPath(rule.From) || isWindowsPath(p) {
			a, b = strings.ToLower(src), strings.ToLower(base)
		}
		var rest string
		prefix := b
		if !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		switch {
		case a == b:
		case strings.HasPrefix(a, prefix):
			rest = strings.TrimLeft(src[len(base):], "/")
		default:
			continue
		}
		target := canonPath(rule.To)
		out := target
		if rest != "" {
			if !strings.HasSuffix(target, "/") {
				target += "/"
			}
			out = target + rest
		}
		if isWindowsPath(rule.To) {
			out = strings.ReplaceAll(out, "/", `\`)
		}
		return out
	}
	return p
}
