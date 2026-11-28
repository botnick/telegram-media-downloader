package main

import "testing"

func TestSupervisedRestart(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		file string
		want bool
	}{
		{"plain terminal", nil, "", false},
		{"systemd", map[string]string{"INVOCATION_ID": "abc"}, "", true},
		{"pm2", map[string]string{"pm_id": "3"}, "", true},
		{"docker", nil, "/.dockerenv", true},
		{"podman", nil, "/run/.containerenv", true},
		{"opt in", map[string]string{"TGDL_RESTART_ON_EXIT": "1"}, "", true},
		{"opt out in docker", map[string]string{"TGDL_RESTART_ON_EXIT": "0"}, "/.dockerenv", false},
	}
	for _, c := range cases {
		got := supervisedRestart(func(k string) string { return c.env[k] }, func(p string) bool { return p == c.file })
		if got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
