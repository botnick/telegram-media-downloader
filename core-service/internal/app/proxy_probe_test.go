package app

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestProxyProbeRejectsPrivateDNSBeforeAnyDial(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "192.168.0.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.1.2.3", "::1", "::ffff:127.0.0.1", "fd01::1", "fe80::1", "ff02::1"} {
		t.Run(ip, func(t *testing.T) {
			_, err := proxyProbe(context.Background(), "proxy.example", 1080, func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("203.0.113.5"), netip.MustParseAddr(ip)}, nil
			}, func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("private DNS reached dial")
				return nil, nil
			})
			if !errors.Is(err, errPrivateProbe) {
				t.Fatal(err)
			}
		})
	}
	for _, host := range []string{"LOCALHOST.", "other.localhost", "NAS.LOCAL.", "box.internal.", "::ffff:10.0.0.1"} {
		if _, err := probeHost(host); !errors.Is(err, errPrivateProbe) {
			t.Fatalf("host=%s %v", host, err)
		}
	}
}

func TestProxyProbePinsResolutionAndClosesSocket(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()
	calls := 0
	_, err := proxyProbe(context.Background(), "proxy.example", 1080, func(context.Context, string, string) ([]netip.Addr, error) {
		calls++
		return []netip.Addr{netip.MustParseAddr("203.0.113.5")}, nil
	}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "203.0.113.5:1080" || calls != 1 {
			t.Fatalf("%s %s lookups=%d", network, address, calls)
		}
		if d, ok := ctx.Deadline(); !ok || time.Until(d) > 5*time.Second {
			t.Fatal("unbounded probe")
		}
		return client, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = server.Write([]byte("x")); err == nil {
		t.Fatal("probe connection not closed")
	}
}

func TestProxyProbeCancelsDNSAndSocket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := proxyProbe(ctx, "proxy.example", 1080, func(ctx context.Context, _, _ string) ([]netip.Addr, error) { return nil, ctx.Err() }, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	_, err = proxyProbe(ctx, "203.0.113.5", 1080, nil, func(ctx context.Context, _, _ string) (net.Conn, error) { return nil, ctx.Err() })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
