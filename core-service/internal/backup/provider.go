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
	if name == "s3" {
		out["sessionToken"] = true
	}
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
	var p Provider
	var err error
	switch name {
	case "local":
		p, err = newLocal(cfg)
	case "s3":
		p, err = newS3(cfg)
	case "sftp":
		p, err = newSFTP(cfg, nil)
	default:
		return nil, fmt.Errorf("native backup provider %q is not available yet", name)
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (m *Manager) provider(ctx context.Context, d destination, cfg map[string]any) (Provider, error) {
	if m.opts.Factory != nil {
		p, err := m.opts.Factory(ctx, d.Provider, cfg)
		if err != nil {
			return nil, err
		}
		return p, nil
	}
	journal := &transferJournal{m, d.ID, d.Provider, append([]byte(nil), d.Blob...)}
	if d.Provider == "sftp" {
		p, err := newSFTP(cfg, m.checkSSHHost)
		if err != nil {
			return nil, err
		}
		p.journal = journal
		return p, nil
	}
	p, err := nativeProvider(ctx, d.Provider, cfg)
	if err != nil {
		return nil, err
	}
	if s3, ok := p.(*s3Provider); ok {
		s3.journal = journal
	}
	return p, err
}
