// Package cluster implements the persisted peer protocol used by the dashboard.
package cluster

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// Signature signs the escaped target, query order and raw body. Timestamps are
// Unix milliseconds, matching the released peer protocol.
func Signature(secret, method, target string, stamp int64, body []byte) string {
	hash := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.ToUpper(method) + "\n" + target + "\n" + strconv.FormatInt(stamp, 10) + "\n" + hex.EncodeToString(hash[:])))
	return hex.EncodeToString(mac.Sum(nil))
}
func signatureMatches(secret, method, target string, stamp int64, body []byte, signature string) bool {
	provided, err := hex.DecodeString(signature)
	if err != nil || len(provided) != sha256.Size || secret == "" {
		return false
	}
	expected, _ := hex.DecodeString(Signature(secret, method, target, stamp, body))
	return hmac.Equal(provided, expected)
}
func PairingKey(code string) string {
	mac := hmac.New(sha256.New, []byte("tgdl-cluster-pairing-code"))
	mac.Write([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return hex.EncodeToString(mac.Sum(nil))
}
func Fingerprint(token, peerID string) string {
	hash := sha256.Sum256([]byte(token + ":" + peerID))
	return hex.EncodeToString(hash[:])
}
