package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestBackupOAuthCommandValidatesInputBeforeNetwork(t *testing.T) {
	var out, errs bytes.Buffer
	if code := backupOAuth([]string{"s3"}, strings.NewReader(""), &out, &errs); code != 2 || !strings.Contains(errs.String(), "usage") {
		t.Fatalf("unknown provider: %d %q", code, errs.String())
	}
	errs.Reset()
	if code := backupOAuth([]string{"dropbox"}, strings.NewReader("key\n\n"), &out, &errs); code != 2 || !strings.Contains(errs.String(), "required") {
		t.Fatalf("missing secret: %d %q", code, errs.String())
	}
	out.Reset()
	errs.Reset()
	// An empty pasted code fails locally without contacting the provider.
	if code := backupOAuth([]string{"gdrive"}, strings.NewReader("id\nsecret\n\n"), &out, &errs); code != 1 || !strings.Contains(out.String(), "accounts.google.com") || !strings.Contains(errs.String(), "no authorization code") {
		t.Fatalf("gdrive prompt: %d %q %q", code, out.String(), errs.String())
	}
}
