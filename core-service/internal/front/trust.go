package front

import (
	"fmt"
	"math/bits"
	"net/netip"
	"strconv"
	"strings"
)

// trustProxy reproduces Express's `trust proxy` function — compileTrust
// in express/lib/utils.js on top of proxy-addr 2.0 — for the value the app
// uses (TRUST_PROXY, default "loopback").
//
// The front server needs it for one decision only: whether a request is
// already on HTTPS (req.secure) when config.web.forceHttps is on. Node
// computes req.ip / req.protocol itself for everything it answers (the
// client's socket address is passed along in X-Tgdl-Client-Addr and Node
// evaluates its own `trust proxy` setting against it), so a value this
// port doesn't understand only costs the fast path: exact is false and the
// request goes to Node.
type trustProxy struct {
	hops    int // >= 0: trust hop i when i < hops (numeric TRUST_PROXY)
	subnets []netip.Prefix
	exact   bool // false: the setting couldn't be reproduced
}

var ipRanges = map[string][]string{
	"linklocal":   {"169.254.0.0/16", "fe80::/10"},
	"loopback":    {"127.0.0.1/8", "::1/128"},
	"uniquelocal": {"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"},
}

// parseTrustProxy compiles the app's effective setting: "" (TRUST_PROXY
// set to empty = trust nothing), a hop count ("1"), or a comma-separated
// list of IPs, CIDRs and the names loopback / linklocal / uniquelocal.
func parseTrustProxy(v string) trustProxy {
	if v == "" {
		return trustProxy{hops: -1, exact: true}
	}
	if isDigits(v) {
		n, err := strconv.ParseFloat(v, 64) // parseInt: huge values still compare as numbers
		if err != nil && n == 0 {
			return trustProxy{hops: -1}
		}
		if n > 1<<30 {
			n = 1 << 30
		}
		return trustProxy{hops: int(n), exact: true}
	}
	t := trustProxy{hops: -1, exact: true}
	var items []string
	for _, it := range strings.Split(v, ",") {
		it = strings.TrimSpace(it)
		if r, ok := ipRanges[it]; ok {
			items = append(items, r...)
			continue
		}
		items = append(items, it)
	}
	for _, it := range items {
		p, err := parseSubnet(it)
		if err != nil {
			return trustProxy{hops: -1}
		}
		t.subnets = append(t.subnets, p)
	}
	return t
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// parseSubnet mirrors proxy-addr's parseipNotation for standard notation
// (dotted quad / RFC 4291 text; ipaddr.js also takes a few legacy IPv4
// spellings, which report an error here and disable the fast path).
func parseSubnet(note string) (netip.Prefix, error) {
	str, rng, hasRange := note, "", false
	if i := strings.LastIndexByte(note, '/'); i >= 0 {
		str, rng, hasRange = note[:i], note[i+1:], true
	}
	ip, err := netip.ParseAddr(str)
	if err != nil || ip.Zone() != "" {
		return netip.Prefix{}, fmt.Errorf("invalid IP address: %s", str)
	}
	if !hasRange && ip.Is4In6() {
		ip = ip.Unmap()
	}
	max := 32
	if ip.Is6() {
		max = 128
	}
	bitsN := max
	if hasRange {
		switch {
		case isDigits(rng):
			n, err := strconv.Atoi(rng)
			if err != nil {
				return netip.Prefix{}, fmt.Errorf("invalid range on address: %s", note)
			}
			bitsN = n
		case ip.Is4():
			mask, err := netip.ParseAddr(rng)
			if err != nil || !mask.Is4() {
				return netip.Prefix{}, fmt.Errorf("invalid range on address: %s", note)
			}
			b := mask.As4()
			m := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
			ones := bits.LeadingZeros32(^m)
			if m<<ones != 0 {
				return netip.Prefix{}, fmt.Errorf("invalid range on address: %s", note)
			}
			bitsN = ones
		default:
			return netip.Prefix{}, fmt.Errorf("invalid range on address: %s", note)
		}
	}
	if bitsN <= 0 || bitsN > max {
		return netip.Prefix{}, fmt.Errorf("invalid range on address: %s", note)
	}
	return netip.PrefixFrom(ip, bitsN), nil
}

// trusts is the compiled trust function: is the address at hop i (0 = the
// socket peer) a trusted proxy? addr is in Node's notation.
func (t trustProxy) trusts(addr string, i int) bool {
	if t.hops >= 0 {
		return i < t.hops
	}
	ip, err := netip.ParseAddr(addr)
	if err != nil {
		return false
	}
	ip = ip.WithZone("")
	for _, s := range t.subnets {
		cand := ip
		if ip.Is4() != s.Addr().Is4() {
			if s.Addr().Is4() {
				if !ip.Is4In6() {
					continue
				}
				cand = ip.Unmap()
			} else {
				cand = netip.AddrFrom16(ip.As16())
			}
		}
		if s.Contains(cand) {
			return true
		}
	}
	return false
}

// protocol is Express's req.protocol for a request on a plain-HTTP socket
// from peer: X-Forwarded-Proto (first value, trimmed) when the peer is
// trusted, else "http". ok is false when the result can't be reproduced.
func (t trustProxy) protocol(peer string, xfp string, xfpOK bool) (string, bool) {
	if !t.exact {
		return "", false
	}
	if !t.trusts(peer, 0) {
		return "http", true
	}
	if !xfpOK {
		return "", false
	}
	h := xfp
	if h == "" {
		h = "http"
	}
	if i := strings.IndexByte(h, ','); i >= 0 {
		h = h[:i]
	}
	return strings.Trim(h, " "), true
}
