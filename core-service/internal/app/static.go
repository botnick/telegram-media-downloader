package app

import (
	"bytes"
	"crypto/sha1" // #nosec G505 -- HTTP cache validators only.
	"encoding/base64"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

var htmlAsset = regexp.MustCompile(`\b(src|href)="(/(?:js|locales|css)/[^"?]+\.(?:js|json|css))"`)
var jsImport = regexp.MustCompile(`(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}/[^'"?]+\.js)(['"])`)

type staticBody struct {
	data             []byte
	tag, contentType string
	rewritten        bool
}

func weakETag(data []byte) string {
	sum := sha1.Sum(data) // #nosec G401 -- matches existing HTTP ETags.
	return `W/"` + strconv.FormatInt(int64(len(data)), 16) + `-` + base64.RawStdEncoding.EncodeToString(sum[:]) + `"`
}

func newStaticHandler(files fs.FS) http.Handler {
	var cache sync.Map
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method != "GET" && r.Method != "HEAD") || strings.HasPrefix(r.URL.Path, "/api/") || files == nil {
			writeNotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		cached, ok := cache.Load(name)
		if !ok {
			data, err := fs.ReadFile(files, name)
			if err != nil {
				writeNotFound(w, r)
				return
			}
			body := staticBody{data: data}
			switch name {
			case "index.html", "login.html", "setup-needed.html", "add-account.html":
				body.rewritten = true
				body.contentType = "text/html; charset=utf-8"
				body.data = htmlAsset.ReplaceAll(data, []byte(`${1}="${2}?v=`+version.AppVersion+`"`))
			}
			if strings.HasPrefix(name, "js/") && strings.HasSuffix(name, ".js") {
				body.rewritten = true
				body.contentType = "application/javascript; charset=utf-8"
				body.data = jsImport.ReplaceAllFunc(data, func(match []byte) []byte {
					parts := jsImport.FindSubmatch(match)
					if !bytes.Equal(parts[2], parts[4]) {
						return match
					}
					return []byte(string(parts[1]) + string(parts[2]) + string(parts[3]) + "?v=" + version.AppVersion + string(parts[4]))
				})
			}
			body.tag = weakETag(body.data)
			cached = body
			cache.Store(name, body)
		}
		body := cached.(staticBody)
		if strings.HasPrefix(name, "js/") || strings.HasPrefix(name, "css/") || strings.HasPrefix(name, "locales/") {
			w.Header().Set("Cache-Control", "public, max-age=3600")
			if r.URL.Query().Get("v") != "" {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
		}
		w.Header().Set("ETag", body.tag)
		if body.contentType != "" {
			w.Header().Set("Content-Type", body.contentType)
		}
		if r.Header.Get("If-None-Match") == body.tag {
			w.WriteHeader(304)
			return
		}
		if body.rewritten {
			if r.Method != "HEAD" {
				_, _ = w.Write(body.data)
			}
			return
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body.data))
	})
}
