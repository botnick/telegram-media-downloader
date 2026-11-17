package version

import "testing"

func TestBuildMetadataHasRequiredValues(t *testing.T) {
	if Service == "" || Version == "" {
		t.Fatalf("service/version must be set: %q %q", Service, Version)
	}
	want := map[string]bool{"hash": false, "tar-gz": false, "db": false}
	for _, feature := range Features {
		if _, ok := want[feature]; ok {
			want[feature] = true
		}
	}
	for feature, found := range want {
		if !found {
			t.Errorf("required feature %q is missing from %v", feature, Features)
		}
	}
}
