package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

var errClusterSyncBusy = errors.New("Cluster sync already running")

func (a *App) syncCluster(ctx context.Context) (int, int, error) {
	if !a.clusterSyncMu.TryLock() {
		return 0, 0, errClusterSyncBusy
	}
	defer a.clusterSyncMu.Unlock()
	peers, err := a.cluster.Peers(ctx)
	if err != nil {
		return 0, 0, err
	}
	queue := make(chan cluster.Peer)
	var wg sync.WaitGroup
	var total atomic.Int64
	var errs []error
	var mu sync.Mutex
	for range min(4, len(peers)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range queue {
				if ctx.Err() != nil {
					continue
				}
				n, err := a.clusterHTTP.SyncPeer(ctx, p)
				total.Add(int64(n))
				if err != nil && !errors.Is(err, cluster.ErrPeerChanged) {
					mu.Lock()
					errs = append(errs, err)
					mu.Unlock()
				}
			}
		}()
	}
	for _, p := range peers {
		if p.Status == "revoked" {
			continue
		}
		select {
		case queue <- p:
		case <-ctx.Done():
		}
	}
	close(queue)
	wg.Wait()
	if total.Load() > 0 {
		a.hub.Broadcast(ws.Event{Type: "peer_catalog_update", Payload: map[string]any{"count": total.Load()}})
	}
	return len(peers), int(total.Load()), errors.Join(append(errs, ctx.Err())...)
}
func (a *App) runClusterSync(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass, cancel := context.WithTimeout(ctx, time.Minute)
			_, _, err := a.syncCluster(pass)
			cancel()
			if err != nil && ctx.Err() == nil && !errors.Is(err, errClusterSyncBusy) && a.output != nil {
				fmt.Fprintf(a.output, "Cluster sync remains pending: %v\n", err)
			}
		}
	}
}
func (a *App) handleClusterSync(w http.ResponseWriter, r *http.Request) {
	peers, rows, err := a.syncCluster(r.Context())
	if errors.Is(err, errClusterSyncBusy) {
		writeJSONError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeJSONError(w, 500, "Cluster sync did not complete")
		return
	}
	writeJSON(w, 200, map[string]any{"peers": peers, "rows": rows})
}
func (a *App) handleClusterSyncState(w http.ResponseWriter, r *http.Request) {
	state, err := a.cluster.SyncState(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster sync state read failed")
		return
	}
	writeJSON(w, 200, state)
}
