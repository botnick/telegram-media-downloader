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

func TestFullConfigBindAddress(t *testing.T) {
	for _, host := range []string{"", "127.0.0.1", "::1", "0.0.0.0", "::"} {
		t.Run(host, func(t *testing.T) {
			env := map[string]string{"TGDL_DATA_DIR": t.TempDir(), "TGDL_BIND_HOST": host}
			cfg, err := FromFullEnv(func(key string) string { return env[key] })
			if err != nil || cfg.BindHost != host {
				t.Fatalf("bind host=%q err=%v", cfg.BindHost, err)
			}
		})
	}
	for _, host := range []string{"localhost", "127.0.0.1:3000", "[::1]", "http://127.0.0.1", "not-an-ip"} {
		env := map[string]string{"TGDL_DATA_DIR": t.TempDir(), "TGDL_BIND_HOST": host}
		if _, err := FromFullEnv(func(key string) string { return env[key] }); err == nil {
			t.Errorf("invalid bind host accepted: %q", host)
		}
	}
}
