package app

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func TestHistoryDateBound(t *testing.T) {
	for in, want := range map[any]int64{
		nil: 0, "": 0, float64(1700000000): 1700000000, float64(1700000000123): 1700000000,
		"1700000000": 1700000000, "2024-03-01": 1709251200, "2024-03-01T07:00:00+07:00": 1709251200,
	} {
		if got, err := historyDateBound(in); err != nil || got != want {
			t.Errorf("historyDateBound(%v) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []any{"yesterday", float64(-1), float64(1e14), float64(1e10), true, "NaN"} {
		if _, err := historyDateBound(in); err == nil {
			t.Errorf("historyDateBound(%v) accepted", in)
		}
	}
}

func TestHistoryDateWindowReachesTelegramAndPersists(t *testing.T) {
	for _, mode := range []string{"pull-older", "catch-up"} {
		t.Run(mode, func(t *testing.T) {
			var transfers atomic.Int64
			requests := make(chan telegram.HistoryRequest, 1)
			page := func(_ context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
				requests <- r
				return historyMessages(), nil
			}
			a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, nil, &transfers)})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_name,file_path,file_type,file_size,status) VALUES('-1000000000042','Old',10,'b','b','document',4,'completed'),('-1000000000042','Old',20,'c','c','document',4,'completed')`); err != nil {
				t.Fatal(err)
			}
			res := historyHTTP(t, a, "POST", "/api/history", fmt.Sprintf(`{"groupId":"-1000000000042","limit":0,"mode":%q,"offsetDate":"2024-03-02","minDate":1709251200000}`, mode))
			if res["offsetDate"] != float64(1709337600) || res["minDate"] != float64(1709251200) {
				t.Fatalf("response %v", res)
			}
			j := historyFinished(t, a, res["jobId"].(string))
			if j.State != "done" || j.OffsetDate != 1709337600 || j.MinDate != 1709251200 {
				t.Fatalf("job=%+v", j)
			}
			r := <-requests
			// A dated pull-older walks the whole window; catch-up keeps its
			// newer-than-the-catalog bound.
			if r.OffsetDate != 1709337600 || r.MinDate != 1709251200 || mode == "pull-older" && (r.OffsetID != 0 || r.MinID != 0) || mode == "catch-up" && r.MinID != 20 {
				t.Fatalf("%s request=%+v", mode, r)
			}
			saved, err := a.historySaved(context.Background())
			if err != nil || len(saved) != 1 || saved[0].OffsetDate != 1709337600 || saved[0].MinDate != 1709251200 {
				t.Fatalf("saved %+v %v", saved, err)
			}
		})
	}
}

func TestHistoryRejectsInvalidDateWindow(t *testing.T) {
	a, _ := socketTestApp(t)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"groupId":"-1000000000042","offsetDate":"2024-03-01","minDate":"2024-03-01"}`,
		`{"groupId":"-1000000000042","offsetDate":"soon"}`,
		`{"groupId":"-1000000000042","minDate":-5}`,
	} {
		if rec := requestPurge(a, token, "POST", "/api/history", body); rec.Code != 400 {
			t.Fatalf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
}
