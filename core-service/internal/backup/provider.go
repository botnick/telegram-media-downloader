package backup

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

//go:embed providers.json
var providerJSON []byte

type ProviderInfo struct {
	Name         string           `json:"name"`
	DisplayName  string           `json:"displayName"`
	ConfigSchema []map[string]any `json:"configSchema"`
}

func Providers() []ProviderInfo { var p []ProviderInfo; _ = json.Unmarshal(providerJSON, &p); return p }
func providerInfo(name string) (ProviderInfo, bool) {
	for _, p := range Providers() {
		if p.Name == name {
			return p, true
		}
	}
	return ProviderInfo{}, false
}
func secretFields(name string) map[string]bool {
	p, _ := providerInfo(name)
	out := map[string]bool{}
	for _, f := range p.ConfigSchema {
		if f["secret"] == true {
			if n, ok := f["name"].(string); ok {
				out[n] = true
			}
		}
	}
	return out
}

type Object struct {
	Path     string
	Size     int64
	Modified time.Time
}
type UploadResult struct {
	Bytes   int64
	ETag    string
	Skipped bool
}

// Providers receive a stable, already-open source. They must publish complete
// objects atomically and must never infer equality solely from object size.
type Provider interface {
	Test(context.Context) (string, error)
	Upload(context.Context, string, io.ReadSeeker, int64, func(int64)) (UploadResult, error)
	List(context.Context, string) ([]Object, error)
	Delete(context.Context, string) error
	Close() error
}
type Factory func(context.Context, string, map[string]any) (Provider, error)

func nativeProvider(_ context.Context, name string, cfg map[string]any) (Provider, error) {
	switch name {
	case "local":
		return newLocal(cfg)
	}
	return nil, fmt.Errorf("native backup provider %q is not available yet", name)
}
