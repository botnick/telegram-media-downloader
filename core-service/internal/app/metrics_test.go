package app

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/gotd/td/tg"
)

func TestMetricsReportQueueFromEngine(t *testing.T) {
	a, srv := socketTestApp(t)
	work := engine.NewWorkStore(a.db.Writer, a.db.Reader)
	for id := 1; id <= 2; id++ {
		message := &tg.Message{ID: id, Date: 1, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: int64(id), Size: 4, DCID: 2}}}
		if _, _, err := work.Enqueue(context.Background(), "one", engine.Target{ID: "-100042", Name: "G"}, message); err != nil {
			t.Fatal(err)
		}
	}
	res, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	body := string(data)
	for _, line := range []string{"tgdl_queue_size 2\n", "tgdl_accounts_loaded 0\n", "tgdl_workers 0\n", "tgdl_active_downloads 0\n", "# TYPE tgdl_workers gauge\n"} {
		if !strings.Contains(body, line) {
			t.Fatalf("metrics lack %q:\n%s", line, body)
		}
	}
}
