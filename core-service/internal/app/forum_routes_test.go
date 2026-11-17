package app

import (
	"context"
	"errors"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"os"
	"path/filepath"
	"testing"
)

func TestForumRouteValidation(t *testing.T) {
	route := func(topic any) map[string]any {
		return map[string]any{"sourceTopicId": topic, "destinationGroupId": "-10042", "destinationTopicId": float64(7)}
	}
	t.Run("different source topics same destination", func(t *testing.T) {
		_, err := normalizedAutoForward(nil, map[string]any{"routes": []any{route(float64(10)), route(float64(20))}})
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("invalid topic cannot become wildcard", func(t *testing.T) {
		for _, value := range []any{"oops", true, -1.0, 1.5, 2147483648.0} {
			if _, err := normalizedAutoForward(nil, map[string]any{"routes": []any{route(value)}}); err == nil {
				t.Errorf("accepted topic %#v", value)
			}
		}
	})
	t.Run("invalid route collection", func(t *testing.T) {
		if _, err := normalizedAutoForward(nil, map[string]any{"routes": "invalid"}); err == nil {
			t.Fatal("accepted invalid routes")
		}
	})
	t.Run("duplicate rejected", func(t *testing.T) {
		if _, err := normalizedAutoForward(nil, map[string]any{"routes": []any{route(float64(10)), route(float64(10))}}); err == nil {
			t.Fatal("accepted duplicate")
		}
	})
}

func TestEnabledForwardingCanBeSavedBeforeRoutesAreChosen(t *testing.T) {
	got, err := normalizedAutoForward(nil, map[string]any{
		"enabled": true,
		"routes":  []any{map[string]any{"sourceTopicId": float64(0), "destinationGroupId": ""}},
	})
	if err != nil {
		t.Fatalf("enabled forwarding should save while routes are being configured: %v", err)
	}
	if got["enabled"] != true || len(got["routes"].([]any)) != 0 {
		t.Fatalf("enabled forwarding without a destination should remain enabled and unrouted: %#v", got)
	}
	if _, err := normalizedAutoForward(nil, map[string]any{
		"enabled": true,
		"routes":  []any{map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "storage"}},
	}); err != nil {
		t.Fatalf("explicit storage destination rejected: %v", err)
	}
}

func TestForwardRoutingSignatureDetectsDestinationChanges(t *testing.T) {
	settings := map[string]any{"routes": []any{
		map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "storage", "destinationTopicId": float64(0)},
	}}
	unchanged := map[string]any{"routes": []any{
		map[string]any{"sourceTopicId": 0, "destinationGroupId": "storage", "destinationTopicId": 0},
	}}
	changed := map[string]any{"routes": []any{
		map[string]any{"sourceTopicId": 0, "destinationGroupId": "me", "destinationTopicId": 0},
	}}
	if forwardRoutingSignature(settings) != forwardRoutingSignature(unchanged) {
		t.Fatal("equivalent route settings produced different signatures")
	}
	if forwardRoutingSignature(settings) == forwardRoutingSignature(changed) {
		t.Fatal("destination change was not detected")
	}
}

func TestForumEmptyRoutesDoNotReactivateLegacyDestination(t *testing.T) {
	settings := map[string]any{"enabled": true, "destination": "@old", "routes": []any{}}
	if routes := matchingForwardRoutes(settings, 10); len(routes) != 0 {
		t.Fatalf("empty routes forwards to legacy destination: %#v", routes)
	}
	delete(settings, "routes")
	if len(matchingForwardRoutes(settings, 10)) != 1 {
		t.Fatal("legacy forwarding broken")
	}
	normalized, err := normalizedAutoForward(settings, map[string]any{"deleteAfterForward": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(matchingForwardRoutes(normalized, 10)) != 1 {
		t.Fatal("legacy partial update disabled forwarding")
	}
}

func TestForumExactRouteOverridesOnlyItsDestination(t *testing.T) {
	settings := map[string]any{"routes": []any{
		map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "@archive"},
		map[string]any{"sourceTopicId": float64(10), "destinationGroupId": "@special"},
		map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "@special"},
	}}
	if got := matchingForwardRoutes(settings, 10); len(got) != 2 {
		t.Fatalf("want exact plus unrelated wildcard, got %#v", got)
	}
	if got := matchingForwardRoutes(settings, 20); len(got) != 2 {
		t.Fatalf("want two wildcards, got %#v", got)
	}
}

func TestForumRouteCaptionInheritance(t *testing.T) {
	group := map[string]any{"captionMode": "override", "caption": "global"}
	route := map[string]any{"destinationGroupId": "@archive", "captionMode": "inherit"}
	caption, _, err := routeCaption(inheritCaptionSettings(route, group), forwardJob{text: "original"})
	if err != nil || caption != "global" {
		t.Fatalf("caption=%q err=%v", caption, err)
	}
	route["captionMode"] = "none"
	caption, _, err = routeCaption(inheritCaptionSettings(route, group), forwardJob{text: "original"})
	if err != nil || caption != "" {
		t.Fatalf("override caption=%q err=%v", caption, err)
	}
}

// A successful first destination must never authorize deletion if a later one fails.
type routeFailureForwarder struct {
	calls []string
	fail  string
}

func (f *routeFailureForwarder) Observing() bool { return true }
func (f *routeFailureForwarder) SendFile(_ context.Context, _ string, req telegram.SendFileRequest) (string, int, error) {
	f.calls = append(f.calls, req.Destination)
	if req.Destination == f.fail {
		return "", 0, errors.New("destination unavailable")
	}
	return "account", 42, nil
}
func TestForumRoutesDeleteOnlyAfterEveryDestinationSucceeds(t *testing.T) {
	for _, fail := range []string{"@second", ""} {
		t.Run("failure="+fail, func(t *testing.T) {
			a, _ := forwardTestApp(t, map[string]any{"enabled": true, "deleteAfterForward": true, "routes": []any{
				map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "@first"},
				map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "@second"},
			}})
			f := &routeFailureForwarder{fail: fail}
			a.forwarder = f
			if err := os.MkdirAll(a.downloadsDir, 0700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(a.downloadsDir, "route.bin")
			if err := os.WriteFile(file, []byte("media"), 0600); err != nil {
				t.Fatal(err)
			}
			a.forward(context.Background(), forwardJob{groupID: "-1000000000123", path: "route.bin"})
			if len(f.calls) != 2 {
				t.Fatalf("calls=%v", f.calls)
			}
			if fail != "" {
				if _, err := os.Stat(file); err != nil {
					t.Fatalf("file deleted after partial failure: %v", err)
				}
			}
		})
	}
}
