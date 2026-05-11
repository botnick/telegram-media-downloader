// Package config is the single source of truth for the seekbar service.
//
// Loader priority: defaults → YAML file (path from --config or
// $SEEKBAR_CONFIG) → environment overrides. Validation runs after the
// last layer.
//
// Env-var convention: VTS_ prefix, double-underscore for nested keys
// (e.g. VTS_THUMB__WIDTH=240, VTS_FFMPEG__HWACCEL=cuda). Matches the
// pattern Docker compose stacks already use for the rest of the
// telegram-media-downloader env surface (SEEKBAR_ENABLED, etc.).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	HTTP    HTTPConfig    `yaml:"http"`
	Storage StorageConfig `yaml:"storage"`
	FFmpeg  FFmpegConfig  `yaml:"ffmpeg"`
	Thumb   ThumbConfig   `yaml:"thumb"`
	Jobs    JobsConfig    `yaml:"jobs"`
	Log     LogConfig     `yaml:"log"`
	DB      DBConfig      `yaml:"db"`
}

type HTTPConfig struct {
	// Listen address. ":8089" by default. Set to "127.0.0.1:8089" for
	// local-only when the parent telegram-media-downloader process is
	// the only client.
	Listen string `yaml:"listen"`
	// Optional bearer token. When non-empty, requests must carry
	// `X-API-Token: <token>` (CLI mode bypasses; only HTTP enforces).
	APIToken string `yaml:"api_token"`
	// Public URL prefix the service prepends to sprite/meta paths in
	// the metadata JSON. Defaults to "" (same-origin); set to e.g.
	// "/seekbar" if the parent app reverse-proxies on a subpath.
	BasePath string `yaml:"base_path"`
}

type StorageConfig struct {
	// Where sprites + JSON sidecars are written. Filenames are
	// `<video-id>.webp` and `<video-id>.json` so a parent app can
	// reverse-proxy or read directly.
	OutputDir string `yaml:"output_dir"`
	// Scratch dir for atomic-write temp files. Defaults to output_dir.
	TempDir string `yaml:"temp_dir"`
	// 'never' | 'if-changed' | 'always'.
	// 'if-changed' compares source size + mtime against the stored
	// metadata and only regenerates when they differ.
	Overwrite string `yaml:"overwrite"`
}

type FFmpegConfig struct {
	Path        string `yaml:"path"`         // ffmpeg binary; empty = PATH lookup
	ProbePath   string `yaml:"probe_path"`   // ffprobe binary; empty = derive from Path
	HWAccel     string `yaml:"hwaccel"`      // auto|none|cuda|qsv|vaapi|videotoolbox|v4l2m2m
	VAAPIDevice string `yaml:"vaapi_device"` // /dev/dri/renderD128 on Linux
	ExtraArgs   string `yaml:"extra_args"`   // appended to every ffmpeg invocation
}

type ThumbConfig struct {
	IntervalSec float64 `yaml:"interval_sec"`
	Width       int     `yaml:"width"`
	Height      int     `yaml:"height"` // 0 = preserve aspect ratio
	Columns     int     `yaml:"columns"`
	MaxTiles    int     `yaml:"max_tiles"`
	Format      string  `yaml:"format"`  // webp|jpeg
	Quality     int     `yaml:"quality"` // 1..100
}

type JobsConfig struct {
	Concurrency int `yaml:"concurrency"`
	MaxRetries  int `yaml:"max_retries"`
	RetryDelay  int `yaml:"retry_delay_sec"`
}

type LogConfig struct {
	Level  string `yaml:"level"`  // debug|info|warn|error
	Format string `yaml:"format"` // text|json
}

type DBConfig struct {
	// SQLite file path for the job store. The service runs fine
	// without it (jobs become ephemeral / in-memory) but operators
	// shipping a long-running container want this on a mounted volume
	// so a restart preserves pause/resume state.
	Path string `yaml:"path"`
}

func Defaults() *Config {
	return &Config{
		HTTP: HTTPConfig{
			Listen:   ":8089",
			BasePath: "",
		},
		Storage: StorageConfig{
			OutputDir: "./data/output",
			TempDir:   "./data/tmp",
			Overwrite: "if-changed",
		},
		FFmpeg: FFmpegConfig{
			Path:        "ffmpeg",
			ProbePath:   "",
			HWAccel:     "auto",
			VAAPIDevice: "/dev/dri/renderD128",
		},
		Thumb: ThumbConfig{
			IntervalSec: 5,
			Width:       160,
			Height:      0,
			Columns:     10,
			MaxTiles:    200,
			Format:      "webp",
			Quality:     70,
		},
		Jobs: JobsConfig{
			Concurrency: 2,
			MaxRetries:  3,
			RetryDelay:  10,
		},
		Log: LogConfig{Level: "info", Format: "text"},
		DB:  DBConfig{Path: "./data/jobs.db"},
	}
}

// Load reads `path` (when non-empty) and layers env-var overrides on top
// of the defaults.
func Load(path string) (*Config, error) {
	cfg := Defaults()
	if path == "" {
		path = os.Getenv("SEEKBAR_CONFIG")
	}
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("read config: %w", err)
			}
		} else if err := yaml.Unmarshal(b, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}
	applyEnv(cfg)
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) Validate() error {
	if c.Thumb.IntervalSec <= 0 {
		return fmt.Errorf("thumb.interval_sec must be > 0")
	}
	if c.Thumb.Width <= 0 {
		return fmt.Errorf("thumb.width must be > 0")
	}
	if c.Thumb.Columns <= 0 {
		return fmt.Errorf("thumb.columns must be > 0")
	}
	if c.Thumb.MaxTiles < 4 {
		c.Thumb.MaxTiles = 200
	}
	switch c.Thumb.Format {
	case "webp", "jpeg", "jpg":
	default:
		return fmt.Errorf("thumb.format must be webp or jpeg, got %q", c.Thumb.Format)
	}
	switch c.Storage.Overwrite {
	case "never", "if-changed", "always":
	default:
		return fmt.Errorf("storage.overwrite must be never|if-changed|always")
	}
	switch c.FFmpeg.HWAccel {
	case "auto", "none", "cpu", "cuda", "nvdec", "qsv", "vaapi", "videotoolbox", "v4l2m2m":
	default:
		return fmt.Errorf("ffmpeg.hwaccel: unknown mode %q", c.FFmpeg.HWAccel)
	}
	if c.Jobs.Concurrency < 1 {
		c.Jobs.Concurrency = 1
	}
	if c.Jobs.MaxRetries < 0 {
		c.Jobs.MaxRetries = 0
	}
	if c.Storage.TempDir == "" {
		c.Storage.TempDir = c.Storage.OutputDir
	}
	if c.FFmpeg.ProbePath == "" {
		c.FFmpeg.ProbePath = deriveProbe(c.FFmpeg.Path)
	}
	return nil
}

func deriveProbe(ffmpeg string) string {
	if ffmpeg == "" {
		return "ffprobe"
	}
	if strings.HasSuffix(ffmpeg, "ffmpeg.exe") {
		return ffmpeg[:len(ffmpeg)-10] + "ffprobe.exe"
	}
	if strings.HasSuffix(ffmpeg, "ffmpeg") {
		return ffmpeg[:len(ffmpeg)-6] + "ffprobe"
	}
	return "ffprobe"
}

func applyEnv(c *Config) {
	setStr(&c.HTTP.Listen, "VTS_HTTP__LISTEN", "SEEKBAR_HTTP_LISTEN")
	setStr(&c.HTTP.APIToken, "VTS_HTTP__API_TOKEN", "SEEKBAR_API_TOKEN")
	setStr(&c.HTTP.BasePath, "VTS_HTTP__BASE_PATH", "SEEKBAR_BASE_PATH")

	setStr(&c.Storage.OutputDir, "VTS_STORAGE__OUTPUT_DIR", "SEEKBAR_OUTPUT_DIR")
	setStr(&c.Storage.TempDir, "VTS_STORAGE__TEMP_DIR", "SEEKBAR_TEMP_DIR")
	setStr(&c.Storage.Overwrite, "VTS_STORAGE__OVERWRITE", "SEEKBAR_OVERWRITE")

	setStr(&c.FFmpeg.Path, "VTS_FFMPEG__PATH", "SEEKBAR_FFMPEG", "FFMPEG_PATH")
	setStr(&c.FFmpeg.ProbePath, "VTS_FFMPEG__PROBE_PATH", "SEEKBAR_FFPROBE", "FFPROBE_PATH")
	setStr(&c.FFmpeg.HWAccel, "VTS_FFMPEG__HWACCEL", "SEEKBAR_HWACCEL", "FFMPEG_HWACCEL")
	setStr(&c.FFmpeg.VAAPIDevice, "VTS_FFMPEG__VAAPI_DEVICE", "SEEKBAR_VAAPI_DEVICE")
	setStr(&c.FFmpeg.ExtraArgs, "VTS_FFMPEG__EXTRA_ARGS", "SEEKBAR_FFMPEG_EXTRA")

	setFloat(&c.Thumb.IntervalSec, "VTS_THUMB__INTERVAL_SEC", "SEEKBAR_INTERVAL_SEC")
	setInt(&c.Thumb.Width, "VTS_THUMB__WIDTH", "SEEKBAR_WIDTH")
	setInt(&c.Thumb.Height, "VTS_THUMB__HEIGHT", "SEEKBAR_HEIGHT")
	setInt(&c.Thumb.Columns, "VTS_THUMB__COLUMNS", "SEEKBAR_COLUMNS")
	setInt(&c.Thumb.MaxTiles, "VTS_THUMB__MAX_TILES", "SEEKBAR_MAX_TILES")
	setStr(&c.Thumb.Format, "VTS_THUMB__FORMAT", "SEEKBAR_FORMAT")
	setInt(&c.Thumb.Quality, "VTS_THUMB__QUALITY", "SEEKBAR_QUALITY")

	setInt(&c.Jobs.Concurrency, "VTS_JOBS__CONCURRENCY", "SEEKBAR_CONCURRENCY")
	setInt(&c.Jobs.MaxRetries, "VTS_JOBS__MAX_RETRIES", "SEEKBAR_MAX_RETRIES")
	setInt(&c.Jobs.RetryDelay, "VTS_JOBS__RETRY_DELAY_SEC", "SEEKBAR_RETRY_DELAY")

	setStr(&c.Log.Level, "VTS_LOG__LEVEL", "SEEKBAR_LOG_LEVEL")
	setStr(&c.Log.Format, "VTS_LOG__FORMAT", "SEEKBAR_LOG_FORMAT")

	setStr(&c.DB.Path, "VTS_DB__PATH", "SEEKBAR_DB_PATH")
}

func setStr(dst *string, keys ...string) {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			*dst = v
			return
		}
	}
}
func setInt(dst *int, keys ...string) {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
				return
			}
		}
	}
}
func setFloat(dst *float64, keys ...string) {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				*dst = f
				return
			}
		}
	}
}
