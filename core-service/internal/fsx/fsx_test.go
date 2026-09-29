package fsx

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func write(t *testing.T, p string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, bytes.Repeat([]byte("x"), size), 0o644); err != nil {
		t.Fatal(err)
	}
}

// dirLink makes a directory link at `at` → `target`: a symlink where
// allowed, else a junction (Windows without the symlink privilege).
func dirLink(t *testing.T, target, at string) {
	t.Helper()
	if err := os.Symlink(target, at); err == nil {
		return
	}
	if runtime.GOOS != "windows" {
		t.Skip("cannot create a directory link here")
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", at, target).CombinedOutput()
	if err != nil {
		t.Skipf("cannot create a junction: %v %s", err, out)
	}
}

func roots(t *testing.T, dirs ...string) *hash.Roots {
	t.Helper()
	r, _ := hash.NewRoots(dirs)
	return r
}

func TestNodeStringMatchesV8Decoding(t *testing.T) {
	cases := []struct {
		in   []byte
		want string
	}{
		{[]byte("plain.jpg"), "plain.jpg"},
		{[]byte("ไฟล์😀"), "ไฟล์😀"},
		// Lone surrogate as WTF-8: three U+FFFD, like V8's WHATWG decoder.
		{[]byte{'a', 0xED, 0xA0, 0x80, 'b'}, "a���b"},
		// Truncated 3-byte sequence: one U+FFFD for the maximal subpart.
		{[]byte{0xE2, 0x82, 'A'}, "�A"},
		{[]byte{0xFF, 'x'}, "�x"},
		{[]byte{0xC0, 0x80}, "��"},
		{[]byte{0xF0, 0x9F, 0x98}, "�"},
	}
	for _, c := range cases {
		if got := nodeString(c.in); got != c.want {
			t.Errorf("nodeString(%x) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMsFromTimeSpec(t *testing.T) {
	// Node: sec * 1e3 + nsec / 1e6, in doubles.
	if got := msFromTimeSpec(1700000000, 123456700); got != 1700000000*1e3+123456700/1e6 {
		t.Fatalf("got %v", got)
	}
}

func TestStatPathBasics(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.bin")
	write(t, f, 1234)
	st, code, link := StatPath(f)
	if code != "" || !st.IsFile || st.IsDir || st.Size != 1234 || link {
		t.Fatalf("file: %+v %q %v", st, code, link)
	}
	info, _ := os.Stat(f)
	if d := st.MtimeMs - float64(info.ModTime().UnixNano())/1e6; d > 1 || d < -1 {
		t.Fatalf("mtime %v vs %v", st.MtimeMs, info.ModTime())
	}

	st, code, _ = StatPath(dir)
	if code != "" || !st.IsDir || st.IsFile {
		t.Fatalf("dir: %+v %q", st, code)
	}
	if runtime.GOOS == "windows" && st.Size != 0 {
		// libuv reports 0 for a directory on Windows (integrity prunes a
		// row whose "file" is a directory there, because size <= 0).
		t.Fatalf("dir size on Windows = %d, want 0", st.Size)
	}

	if _, code, _ = StatPath(filepath.Join(dir, "missing")); code != "ENOENT" {
		t.Fatalf("missing: %q", code)
	}
	if _, code, _ = StatPath(filepath.Join(dir, "nope", "missing")); code != "ENOENT" {
		t.Fatalf("missing parent: %q", code)
	}
	// A file used as a directory: ENOENT on Windows, ENOTDIR elsewhere —
	// both mean "gone" to integrity.js, and both are what Node reports.
	want := "ENOTDIR"
	if runtime.GOOS == "windows" {
		want = "ENOENT"
	}
	if _, code, _ = StatPath(filepath.Join(f, "child")); code != want {
		t.Fatalf("file as dir: %q, want %q", code, want)
	}
}

func TestStatPathFollowsLinks(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "real", "x.txt"), 7)
	dirLink(t, filepath.Join(dir, "real"), filepath.Join(dir, "link"))
	st, code, link := StatPath(filepath.Join(dir, "link"))
	if code != "" || !st.IsDir || !link {
		t.Fatalf("dir link: %+v %q link=%v", st, code, link)
	}
	st, code, _ = StatPath(filepath.Join(dir, "link", "x.txt"))
	if code != "" || st.Size != 7 {
		t.Fatalf("through link: %+v %q", st, code)
	}
	if err := os.Remove(filepath.Join(dir, "real", "x.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "real")); err != nil {
		t.Fatal(err)
	}
	if _, code, _ = StatPath(filepath.Join(dir, "link")); code != "ENOENT" {
		t.Fatalf("dangling link: %q", code)
	}
}

func TestReadDirOrderAndKinds(t *testing.T) {
	dir := t.TempDir()
	names := []string{"b.jpg", "A.jpg", "_x.jpg", "a10.jpg", "a9.jpg", "Zed", "ไฟล์.mp4"}
	for _, n := range names {
		write(t, filepath.Join(dir, n), 1)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	dirLink(t, filepath.Join(dir, "sub"), filepath.Join(dir, "sublink"))

	ents, code := ReadDir(dir)
	if code != "" {
		t.Fatal(code)
	}
	got := make([]string, len(ents))
	kinds := map[string]string{}
	for i, e := range ents {
		got[i] = e.Name
		kinds[e.Name] = e.Kind
	}
	// Order: libuv sorts with strcmp on Unix; on Windows it is the file
	// system's own order, which (*os.File).ReadDir also returns unsorted.
	var want []string
	if runtime.GOOS == "windows" {
		f, err := os.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		des, err := f.ReadDir(-1)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range des {
			want = append(want, d.Name())
		}
	} else {
		want = append(append([]string{}, names...), "sub", "sublink")
		sort.Strings(want)
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("order:\n got %v\nwant %v", got, want)
	}
	if kinds["sub"] != KindDir || kinds["sublink"] != KindLink || kinds["b.jpg"] != KindFile {
		t.Fatalf("kinds: %v", kinds)
	}

	if _, code := ReadDir(filepath.Join(dir, "missing")); code != "ENOENT" {
		t.Fatalf("missing dir: %q", code)
	}
	if _, code := ReadDir(filepath.Join(dir, "b.jpg")); code != "ENOTDIR" {
		t.Fatalf("file as dir: %q", code)
	}
}

func TestStatBatchContainment(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	write(t, filepath.Join(root, "g", "images", "a.jpg"), 10)
	write(t, filepath.Join(outside, "secret.txt"), 3)
	dirLink(t, outside, filepath.Join(root, "escape"))
	dirLink(t, filepath.Join(root, "g"), filepath.Join(root, "alias"))

	paths := []string{
		filepath.Join(root, "g", "images", "a.jpg"),        // ok
		filepath.Join(root, "g", "images", "nope.jpg"),     // ENOENT
		filepath.Join(outside, "secret.txt"),               // EOUTSIDE, as written
		filepath.Join(root, "escape", "secret.txt"),        // EOUTSIDE, parent resolves outside
		filepath.Join(root, "escape"),                      // EOUTSIDE, the link itself
		filepath.Join(root, "alias", "images", "a.jpg"),    // ok: link inside the root
		filepath.Join(root, "..", "outside", "secret.txt"), // EOUTSIDE (cleaned)
		"relative/path.jpg",                                // EINVAL
		filepath.Join(root, "g", "bad\x00name"),            // ERR_INVALID_ARG_VALUE
		filepath.Join(root, "g", "images", "a.jpg", "x"),   // file as dir
	}
	res, err := StatBatch(context.Background(), roots(t, root), paths, 4, nil)
	if err != nil {
		t.Fatal(err)
	}
	fileAsDir := "ENOTDIR"
	if runtime.GOOS == "windows" {
		fileAsDir = "ENOENT"
	}
	want := []string{"", "ENOENT", "EOUTSIDE", "EOUTSIDE", "EOUTSIDE", "", "EOUTSIDE", "EINVAL", "ERR_INVALID_ARG_VALUE", fileAsDir}
	for i, w := range want {
		if res[i].Code != w {
			t.Errorf("%d %s: code %q, want %q", i, paths[i], res[i].Code, w)
		}
	}
	if !res[0].OK || res[0].Size != 10 || !res[5].OK || res[5].Size != 10 {
		t.Fatalf("ok results: %+v %+v", res[0], res[5])
	}

	// No roots at all: nothing is answered.
	res, _ = StatBatch(context.Background(), roots(t), paths[:1], 1, nil)
	if res[0].Code != "EOUTSIDE" {
		t.Fatalf("no roots: %+v", res[0])
	}
}

func TestStatBatchOrderUnderParallelism(t *testing.T) {
	root := t.TempDir()
	var paths []string
	for i := 0; i < 300; i++ {
		p := filepath.Join(root, "d", strings.Repeat("n", i%7+1)+"-"+itoa3(i)+".bin")
		if i%3 != 0 {
			write(t, p, i)
		}
		paths = append(paths, p)
	}
	res, err := StatBatch(context.Background(), roots(t, root), paths, 16, NewDirCache(DirCacheTTL))
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range res {
		if i%3 == 0 {
			if r.Code != "ENOENT" {
				t.Fatalf("%d: %+v", i, r)
			}
		} else if !r.OK || r.Size != int64(i) {
			t.Fatalf("%d: %+v", i, r)
		}
	}
}

func itoa3(i int) string {
	return string([]byte{byte('0' + i/100%10), byte('0' + i/10%10), byte('0' + i%10)})
}

func collect(t *testing.T, r *hash.Roots, root string, opts WalkOptions) ([]Event, Summary, error) {
	t.Helper()
	var evs []Event
	sum, err := Walk(context.Background(), r, root, opts, func(ev Event) error {
		evs = append(evs, ev)
		return nil
	})
	return evs, sum, err
}

func TestWalkOrderDepthAndStat(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "dl")
	outside := filepath.Join(base, "out")
	write(t, filepath.Join(root, "g1", "images", "1.jpg"), 5)
	write(t, filepath.Join(root, "g1", "images", "2.jpg.part"), 3)
	write(t, filepath.Join(root, "g1", "loose.bin"), 2)
	write(t, filepath.Join(root, "g1", "videos", "deep", "x.mp4"), 9)
	write(t, filepath.Join(root, ".hidden"), 4)
	write(t, filepath.Join(outside, "big.bin"), 100)
	dirLink(t, outside, filepath.Join(root, "g1", "linked"))

	evs, sum, err := collect(t, roots(t, root), root, WalkOptions{Stat: StatNonDir})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]Event{}
	var order []string
	for _, ev := range evs {
		seen[ev.P] = ev
		order = append(order, ev.T+":"+ev.P)
	}
	// Pre-order: a directory's contents come right after it.
	idx := func(s string) int {
		for i, o := range order {
			if o == s {
				return i
			}
		}
		t.Fatalf("missing %s in %v", s, order)
		return -1
	}
	if !(idx("d:g1") < idx("d:g1/images") && idx("d:g1/images") < idx("f:g1/images/1.jpg")) {
		t.Fatalf("not pre-order: %v", order)
	}
	if e := seen["g1/images/2.jpg.part"]; !e.Stated || e.Stat.Size != 3 {
		t.Fatalf(".part files are listed and stat'ed like any file: %+v", e)
	}
	if e := seen[".hidden"]; !e.Stated || e.Stat.Size != 4 {
		t.Fatalf("hidden files are listed: %+v", e)
	}
	// The directory link is an entry, not entered; its target is outside.
	if e := seen["g1/linked"]; e.Kind != KindLink || e.Code != CodeOutside {
		t.Fatalf("link: %+v", e)
	}
	if _, entered := seen["g1/linked/big.bin"]; entered {
		t.Fatal("walk followed a directory link")
	}
	if sum.Bytes != 5+3+2+9+4 || len(sum.Outside) != 1 || sum.Outside[0] != "g1/linked" {
		t.Fatalf("summary: %+v", sum)
	}

	// maxDepth 2 from a group folder: the type folders' files, no deeper.
	evs, _, err = collect(t, roots(t, root), filepath.Join(root, "g1"), WalkOptions{MaxDepth: 2, Stat: StatFiles})
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if strings.Count(ev.P, "/") > 1 {
			t.Fatalf("went past maxDepth: %+v", ev)
		}
		if ev.T == "f" && ev.Kind == KindLink && ev.Stated {
			t.Fatalf("stat=files stat'ed a link: %+v", ev)
		}
	}
}

func TestWalkErrors(t *testing.T) {
	root := t.TempDir()
	r := roots(t, root)
	evs, _, err := collect(t, r, filepath.Join(root, "missing"), WalkOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].T != "e" || evs[0].P != "" || evs[0].Code != "ENOENT" {
		t.Fatalf("missing root: %+v", evs)
	}
	if _, _, err := collect(t, r, t.TempDir(), WalkOptions{}); err == nil {
		t.Fatal("walk outside the roots must fail")
	}
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		locked := filepath.Join(root, "locked")
		write(t, filepath.Join(locked, "x"), 1)
		if err := os.Chmod(locked, 0); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(locked, 0o755)
		evs, sum, err := collect(t, r, root, WalkOptions{})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, ev := range evs {
			if ev.T == "e" && ev.P == "locked" && ev.Code == "EACCES" {
				found = true
			}
		}
		if !found || sum.Errors != 1 {
			t.Fatalf("unreadable dir not reported: %+v", evs)
		}
	}
}

func TestHandlers(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "g", "a.jpg"), 11)
	r := roots(t, root)
	mux := http.NewServeMux()
	mux.Handle("POST /v1/fs/stat-batch", &StatBatchHandler{Roots: r, Stats: &Stats{}})
	mux.Handle("POST /v1/fs/walk", &WalkHandler{Roots: r, Stats: &Stats{}})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	post := func(path string, body any) *http.Response {
		t.Helper()
		b, _ := json.Marshal(body)
		resp, err := http.Post(ts.URL+path, "application/json", bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp := post("/v1/fs/stat-batch", map[string]any{"paths": []string{filepath.Join(root, "g", "a.jpg"), filepath.Join(root, "x")}})
	var out struct {
		Results []map[string]any `json:"results"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(out.Results) != 2 || out.Results[0]["ok"] != true || out.Results[0]["size"] != float64(11) || out.Results[1]["code"] != "ENOENT" {
		t.Fatalf("stat-batch: %d %+v", resp.StatusCode, out)
	}
	if _, has := out.Results[1]["size"]; has {
		t.Fatalf("an error result carries only its code: %+v", out.Results[1])
	}

	many := make([]string, MaxBatch+1)
	for i := range many {
		many[i] = filepath.Join(root, "x")
	}
	if resp := post("/v1/fs/stat-batch", map[string]any{"paths": many}); resp.StatusCode != 400 {
		t.Fatalf("oversized batch: %d", resp.StatusCode)
	}
	resp, _ = http.Post(ts.URL+"/v1/fs/stat-batch", "application/json", strings.NewReader("{"))
	if resp.StatusCode != 400 {
		t.Fatalf("bad json: %d", resp.StatusCode)
	}

	resp = post("/v1/fs/walk", map[string]any{"root": root, "stat": "files"})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("walk: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var lines []map[string]any
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("bad line %q", sc.Text())
		}
		lines = append(lines, m)
	}
	resp.Body.Close()
	last := lines[len(lines)-1]
	if last["t"] != "end" || last["bytes"] != float64(11) || len(lines) != 3 {
		t.Fatalf("walk lines: %+v", lines)
	}
	if lines[1]["p"] != "g/a.jpg" || lines[1]["size"] != float64(11) || lines[1]["k"] != "file" {
		t.Fatalf("file line: %+v", lines[1])
	}

	resp = post("/v1/fs/walk", map[string]any{"root": root, "stat": "nondir", "entries": false})
	body, _ := readAll(resp)
	if strings.Count(body, "\n") != 1 || !strings.Contains(body, `"t":"end"`) {
		t.Fatalf("entries=false: %q", body)
	}
	if resp := post("/v1/fs/walk", map[string]any{"root": t.TempDir()}); resp.StatusCode != 403 {
		t.Fatalf("walk outside: %d", resp.StatusCode)
	}
}

func readAll(resp *http.Response) (string, error) {
	defer resp.Body.Close()
	var b strings.Builder
	_, err := bufio.NewReader(resp.Body).WriteTo(&b)
	return b.String(), err
}

func TestWalkStopsWhenCancelled(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		write(t, filepath.Join(root, itoa3(i), "f"), 1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	start := time.Now()
	_, err := Walk(ctx, roots(t, root), root, WalkOptions{}, func(Event) error {
		n++
		if n == 5 {
			cancel()
		}
		return nil
	})
	if err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("walk not cancelled: %v after %d events", err, n)
	}
}
