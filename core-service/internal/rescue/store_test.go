package rescue

import (
	"testing"
	"time"
)

func TestRetentionUsesOverridesAndBounds(t *testing.T) {
	cases := []struct {
		name  string
		group map[string]any
		cfg   map[string]any
		want  time.Duration
	}{
		{"disabled", nil, map[string]any{"rescue": map[string]any{"enabled": false, "retentionHours": 24.0}}, 0},
		{"configured default", nil, map[string]any{"rescue": map[string]any{"enabled": true, "retentionHours": 12.0}}, 12 * time.Hour},
		{"group override", map[string]any{"rescueRetentionHours": "6"}, map[string]any{"rescue": map[string]any{"enabled": true, "retentionHours": 12.0}}, 6 * time.Hour},
		{"group force on", map[string]any{"rescueMode": "on"}, nil, 48 * time.Hour},
		{"group force off", map[string]any{"rescueMode": "off"}, map[string]any{"rescue": map[string]any{"enabled": true}}, 0},
		{"minimum", map[string]any{"rescueRetentionHours": 0.1}, map[string]any{"rescue": map[string]any{"enabled": true}}, time.Hour},
		{"maximum", map[string]any{"rescueRetentionHours": 900.0}, map[string]any{"rescue": map[string]any{"enabled": true}}, 720 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Retention(tc.group, tc.cfg); got != tc.want {
				t.Fatalf("Retention() = %v, want %v", got, tc.want)
			}
		})
	}
}
