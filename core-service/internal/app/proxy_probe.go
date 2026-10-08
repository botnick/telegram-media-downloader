package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

var errPrivateProbe = errors.New("Private / loopback / link-local addresses are not allowed for proxy probes.")

type probeResolver func(context.Context, string, string) ([]netip.Addr, error)
type probeDialer func(context.Context, string, string) (net.Conn, error)

func privateProbeIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	if ip.Is4() {
		b := ip.As4()
		return b[0] == 0 || b[0] >= 224 || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)
	}
	return false
}

func probeHost(raw string) (string, error) {
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	if host == "" || len(host) > 253 {
		return "", errors.New("invalid host")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return "", errPrivateProbe
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if privateProbeIP(ip) {
			return "", errPrivateProbe
		}
		return ip.String(), nil
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errors.New("invalid host")
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return "", errors.New("invalid host")
			}
		}
	}
	return host, nil
}

// Resolve once, validate the entire answer and dial the selected literal IP.
// A second hostname lookup could turn a public answer into an internal target.
func proxyProbe(ctx context.Context, host string, port int, resolve probeResolver, dial probeDialer) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	start := time.Now()
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = []netip.Addr{ip}
	} else {
		var err error
		ips, err = resolve(ctx, "ip", host)
		if err != nil {
			return 0, err
		}
	}
	if len(ips) == 0 {
		return 0, errors.New("host resolved to no addresses")
	}
	for _, ip := range ips {
		if privateProbeIP(ip) {
			return 0, errPrivateProbe
		}
	}
	conn, err := dial(ctx, "tcp", net.JoinHostPort(ips[0].Unmap().String(), strconv.Itoa(port)))
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	return time.Since(start).Milliseconds(), ctx.Err()
}

func (a *App) handleProxyProbe(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	if body["host"] == nil || body["host"] == "" || body["port"] == nil || body["port"] == "" || body["port"] == float64(0) {
		writeJSONError(w, 400, "host and port required")
		return
	}
	raw, ok := body["host"].(string)
	if !ok || len(raw) > 253 {
		writeJSONError(w, 400, "invalid host")
		return
	}
	host, err := probeHost(raw)
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	portText := toString(body["port"])
	if f, ok := body["port"].(float64); ok {
		portText = strconv.FormatFloat(f, 'f', -1, 64)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		writeJSONError(w, 400, "port must be 1-65535")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	dialer := &net.Dialer{}
	ms, err := proxyProbe(ctx, host, port, net.DefaultResolver.LookupNetIP, dialer.DialContext)
	if errors.Is(err, errPrivateProbe) {
		writeJSONError(w, 400, err.Error())
		return
	}
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "ms": ms})
}
