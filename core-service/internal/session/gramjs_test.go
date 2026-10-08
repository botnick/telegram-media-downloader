package session

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	gotdSession "github.com/gotd/td/session"
)

const fixturePlain = "1AgAOMTQ5LjE1NC4xNjcuNTABuwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8="

const fixtureSecure = `{"v":2,"salt":"00112233445566778899aabbccddeeff","iv":"ffeeddccbbaa99887766554433221100","data":"87a8c08322d6fb35c2917d08c9c7a2e086c4fc112fd04fcca6fd0368fefe54efa785b4a36324d3c4474a2469a1f667cf6df55182bf019ea77dfc89bfb2c127a5d325015cde1e13faa077007c217ff406f9473ff091627f111561d9dbba294003f01b19ea969aa682ffb37c234bffd90cb5f3b2c1212b2fd20235265aa569c29cabb12465884dd763670e78ec7a5e4fe924f672ee55702b42bbc74a39cbcc4a19d9df336be0bec818a74242520ba8bb55e3dee65332f21b1c03d87c5c250887517bb848f9f6ad7a6d09887011f217d00f7819e30aeb89f17bdd3f15c6c7cadb5aceacdb61314b3a6b89bd4717a02accdb969a83921ef49f93662891733f0d2ba75613c5a1aaad05d2dd7b7c53deeb2d9161608ec928cfac1f3b0945c00c51daf4a4fcd9c4cb5e8220d1b5001af530ecfae0272e6dccd3f62947f0ff118e7c4f31e6617793e6a24987f5ce1f05b4c578264d11e3c1bfcf033a309ac23bb196e6f346c1821b217e0fd9de5ce3ee4479185300","tag":"0260f9426b816b7f87dcc912e96b0987"}`

const fixtureLegacySecure = `{"v":1,"iv":"07070707070707070707070707070707","data":"333e0bfc17a0e380fccc8bc356ec","tag":"469a070b28d5cbfb9f74198e851b72ba"}`

func TestDecryptSecureSessionMatchesNodeSecureSession(t *testing.T) {
	plain, err := DecryptSecureSession([]byte(fixtureSecure), "unit-test-secret")
	if err != nil {
		t.Fatal(err)
	}
	if plain != fixturePlain {
		t.Fatalf("plain mismatch: got %q", plain)
	}
	if _, err := DecryptSecureSession([]byte(fixtureSecure), "wrong"); err == nil {
		t.Fatal("wrong secret unexpectedly decrypted")
	}
}

func TestGramJSPortUsesUnsignedWireInteger(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(fixturePlain[1:])
	if err != nil {
		t.Fatal(err)
	}
	offset := 3 + int(binary.BigEndian.Uint16(raw[1:3]))
	binary.BigEndian.PutUint16(raw[offset:offset+2], 65535)
	data, err := ParseGramJSStringSession("1" + base64.StdEncoding.EncodeToString(raw))
	if err != nil || data.Port != 65535 {
		t.Fatalf("valid wire port rejected: %d %v", data.Port, err)
	}
}

func TestDecryptSecureSessionAcceptsLegacyV1(t *testing.T) {
	plain, err := DecryptSecureSession([]byte(fixtureLegacySecure), "unit-test-secret")
	if err != nil {
		t.Fatal(err)
	}
	if plain != "legacy-session" {
		t.Fatalf("legacy plain = %q", plain)
	}
}

func TestParseGramJSStringSession(t *testing.T) {
	got, err := ParseGramJSStringSession(fixturePlain)
	if err != nil {
		t.Fatal(err)
	}
	if got.DC != 2 || got.Addr != "149.154.167.50:443" || got.Port != 443 {
		t.Fatalf("metadata mismatch: %+v", got)
	}
	if len(got.AuthKey) != 256 || got.AuthKey[0] != 0 || got.AuthKey[255] != 255 {
		t.Fatalf("auth key mismatch")
	}
	if len(got.AuthKeyID) != 8 {
		t.Fatalf("auth key id length = %d", len(got.AuthKeyID))
	}
}

func TestWriteGotdSessionIsReadableAndAtomic(t *testing.T) {
	data, err := ParseGramJSStringSession(fixturePlain)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "sessions", "account.json")
	if err := WriteGotd(context.Background(), path, "test-secret", data); err != nil {
		t.Fatal(err)
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(buf), base64.StdEncoding.EncodeToString(data.AuthKey)) {
		t.Fatal("auth key stored in plaintext")
	}
	storage, err := NewEncryptedStorage(path, "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	buf, err = storage.LoadSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var decoded gotdSession.Data
	var envelope struct {
		Version int
		Data    gotdSession.Data
	}
	if err := json.Unmarshal(buf, &envelope); err != nil {
		t.Fatal(err)
	}
	decoded = envelope.Data
	if envelope.Version != 1 || decoded.DC != data.DC || decoded.Addr != data.Addr || string(decoded.AuthKey) != string(data.AuthKey) {
		t.Fatalf("gotd session mismatch: version=%d data=%+v", envelope.Version, decoded)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary session leaked: %v", err)
	}
}

func TestLoadEncryptedDoesNotRewriteSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "account.enc")
	if err := os.WriteFile(path, []byte(fixtureSecure), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadEncrypted(path, "unit-test-secret")
	if err != nil {
		t.Fatal(err)
	}
	if got.DC != 2 || got.Addr != "149.154.167.50:443" {
		t.Fatalf("converted metadata mismatch: %+v", got)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != fixtureSecure {
		t.Fatal("source encrypted session was modified")
	}
}
