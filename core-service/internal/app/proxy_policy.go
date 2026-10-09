package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// An absent option trusts loopback proxies; an explicitly empty option trusts
// no proxy. Hop counts and CIDRs are operator policy, never request input.
type proxyPolicy struct {
	hops     int
	networks []netip.Prefix
}

func parseProxyPolicy(option *string) (proxyPolicy, error) {
	raw := "loopback"
	if option != nil {
		raw = strings.TrimSpace(*option)
	}
	p := proxyPolicy{hops: -1}
	if raw == "" {
		return p, nil
	}
	if n, err := strconv.Atoi(raw); err == nil {
		if n < 0 || n > 256 {
			return p, errors.New("TRUST_PROXY hop count must be 0-256")
		}
		p.hops = n
		return p, nil
	}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		var cidrs []string
		switch item {
		case "loopback":
			cidrs = []string{"127.0.0.0/8", "::1/128"}
		case "linklocal":
			cidrs = []string{"169.254.0.0/16", "fe80::/10"}
		case "uniquelocal":
			cidrs = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"}
		default:
			cidrs = []string{item}
		}
		for _, cidr := range cidrs {
			prefix, err := netip.ParsePrefix(cidr)
			if err != nil {
				addr, e := netip.ParseAddr(cidr)
				if e != nil {
					return p, errors.New("TRUST_PROXY must contain IP addresses, CIDRs, known network names or a hop count")
				}
				addr = addr.Unmap()
				prefix = netip.PrefixFrom(addr, addr.BitLen())
			}
			if prefix.Addr().Is4In6() {
				if prefix.Bits() < 96 {
					return p, errors.New("TRUST_PROXY mapped IPv4 prefix is too broad")
				}
				prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
			}
			p.networks = append(p.networks, prefix.Masked())
		}
	}
	return p, nil
}
func (p proxyPolicy) trusts(addr netip.Addr, hop int) bool {
	if !addr.IsValid() {
		return false
	}
	if p.hops >= 0 {
		return hop < p.hops
	}
	for _, prefix := range p.networks {
		if prefix.Contains(addr.Unmap()) {
			return true
		}
	}
	return false
}

type requestNetwork struct {
	client netip.Addr
	secure bool
}
type networkContextKey struct{}

func (p proxyPolicy) resolve(r *http.Request) (requestNetwork, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return requestNetwork{}, errors.New("invalid client address")
	}
	ip = ip.Unmap()
	n := requestNetwork{client: ip, secure: r.TLS != nil}
	if !p.trusts(ip, 0) {
		return n, nil
	}
	// Scheme is asserted by the immediate trusted hop. An actual TLS socket
	// remains secure even if a proxy supplies a contradictory header.
	proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if proto == "https" {
		n.secure = true
	}
	forwarded := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	if len(forwarded) > 8192 {
		return n, errors.New("forwarded address chain is too long")
	}
	if forwarded == "" {
		return n, nil
	}
	parts := strings.Split(forwarded, ",")
	if len(parts) > 256 {
		return n, errors.New("forwarded address chain has too many hops")
	}
	for i, hop := len(parts)-1, 0; i >= 0 && p.trusts(n.client, hop); i, hop = i-1, hop+1 {
		addr, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
		if err != nil || addr.Zone() != "" {
			return n, errors.New("invalid forwarded client address")
		}
		n.client = addr.Unmap()
	}
	return n, nil
}
func networkForRequest(r *http.Request) requestNetwork {
	if n, ok := r.Context().Value(networkContextKey{}).(requestNetwork); ok {
		return n
	}
	// Helpers used without the application wrapper retain the default boundary.
	p, _ := parseProxyPolicy(nil)
	n, _ := p.resolve(r)
	return n
}
func withNetwork(r *http.Request, n requestNetwork) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), networkContextKey{}, n))
}
