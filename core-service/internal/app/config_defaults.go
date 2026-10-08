package app

import (
	_ "embed"
	"encoding/json"
)

// defaultConfigJSON is generated from the released Node configuration manager
// and kept beside the Go service so a fresh read has the same shape during the
// migration. The stored row remains the source of operator values.
//
//go:embed default_config.json
var defaultConfigJSON []byte

func effectiveConfig(raw map[string]any) map[string]any {
	var defaults map[string]any
	if err := json.Unmarshal(defaultConfigJSON, &defaults); err != nil || defaults == nil {
		defaults = map[string]any{}
	}
	mergeConfig(defaults, raw)
	// The released dashboard only materialises the seekbar tuning defaults
	// after that block is saved. Preserve the compact legacy seed shape until
	// then; this matters to clients that distinguish an unset knob from its
	// default. Advanced saves persist the complete block and therefore retain
	// every field below.
	if rawAdvanced, ok := raw["advanced"].(map[string]any); ok {
		if rawSeekbar, ok := rawAdvanced["seekbar"].(map[string]any); ok {
			if seekbar, ok := defaults["advanced"].(map[string]any)["seekbar"].(map[string]any); ok {
				for _, key := range []string{"enabled", "autoOnDownload", "intervalSec", "tileWidth", "columns", "maxTiles", "format", "quality", "concurrency", "maxRetries", "hwaccel"} {
					if _, present := rawSeekbar[key]; !present {
						delete(seekbar, key)
					}
				}
			}
		}
	}
	if advanced, ok := defaults["advanced"].(map[string]any); ok {
		if ai, ok := advanced["ai"].(map[string]any); ok {
			if faces, ok := ai["faces"].(map[string]any); ok {
				if _, present := ai["facesDetectorModel"]; !present {
					ai["facesDetectorModel"] = faces["detectorModel"]
				}
				if _, present := ai["facesLabelMatchEps"]; !present {
					ai["facesLabelMatchEps"] = faces["labelMatchEps"]
				}
			}
		}
		delete(advanced, "goCore")
	}
	if groups, ok := defaults["groups"].([]any); ok {
		for _, item := range groups {
			if group, ok := item.(map[string]any); ok {
				group["filters"] = normalizedGroupFilters(group["filters"])
			}
		}
	}
	return defaults
}

func rawRedactedConfig(config map[string]any) map[string]any {
	safe := cloneConfigValue(config).(map[string]any)
	const redacted = "••••••• (redacted)"
	for _, path := range [][]string{
		{"telegram", "apiHash"},
		{"web", "passwordHash"},
		{"web", "password"},
		{"web", "guestPasswordHash"},
		{"web", "shareSecret"},
		{"proxy", "password"},
		{"proxy", "secret"},
		{"advanced", "nsfw", "apiToken"},
		{"advanced", "seekbar", "apiToken"},
		{"advanced", "ai", "faces", "sidecarToken"},
	} {
		parent := objectAt(safe, path[:len(path)-1]...)
		if parent == nil {
			continue
		}
		key := path[len(path)-1]
		if value, ok := parent[key]; ok && value != nil && value != "" {
			parent[key] = redacted
		}
	}
	return safe
}
