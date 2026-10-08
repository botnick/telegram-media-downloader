package config

import "testing"

func TestFromFullEnvRequiresDataDirAndNormalizesPort(t *testing.T) {
	env := map[string]string{"TGDL_DATA_DIR": "/tmp/tgdl", "PORT": "3010"}
	cfg, err := FromFullEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != "/tmp/tgdl" || cfg.Port != 3010 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if cfg.CookieName != "tg_dl_session" {
		t.Fatalf("unexpected cookie name: %q", cfg.CookieName)
	}
}

func TestFromFullEnvRejectsMissingDataDir(t *testing.T) {
	_, err := FromFullEnv(func(string) string { return "" })
	if err == nil {
		t.Fatal("expected missing data dir error")
	}
}
