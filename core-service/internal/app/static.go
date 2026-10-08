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
	modTime          time.Time
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
		setStaticCacheHeaders(w, name, r.URL.Query().Get("v") != "")
		if strings.Contains(r.URL.Path, "..") && (strings.HasPrefix(r.URL.Path, "/js/") || strings.HasPrefix(r.URL.Path, "/css/") || strings.HasPrefix(r.URL.Path, "/locales/") || strings.HasPrefix(r.URL.Path, "/icons/")) {
			if strings.HasPrefix(r.URL.Path, "/js/") {
				w.Header().Set("Cache-Control", "public, max-age=3600")
			}
			writeNotFound(w, r)
			return
		}
		cached, ok := cache.Load(name)
		if !ok {
			data, err := fs.ReadFile(files, name)
			if err != nil {
				writeNotFound(w, r)
				return
			}
			if strings.HasPrefix(name, "icons/") {
				w.Header().Del("Vary")
			}
			body := staticBody{data: data, modTime: time.Now().UTC()}
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
			if name == "CHANGELOG.md" {
				body.rewritten = true
			}
			if body.contentType == "" {
				body.contentType = staticContentType(name)
			}
			if body.rewritten {
				body.tag = weakETag(body.data)
			} else {
				body.tag = `W/"` + strconv.FormatInt(int64(len(body.data)), 16) + `-` + strconv.FormatInt(body.modTime.UnixMilli(), 16) + `"`
			}
			cached = body
			cache.Store(name, body)
		}
		body := cached.(staticBody)
		if strings.HasPrefix(name, "icons/") {
			w.Header().Del("Vary")
		}
		w.Header().Set("ETag", body.tag)
		if !body.rewritten {
			w.Header().Set("Accept-Ranges", "bytes")
		}
		if !body.rewritten {
			w.Header().Set("Last-Modified", body.modTime.Format(http.TimeFormat))
		}
		if body.contentType != "" {
			w.Header().Set("Content-Type", body.contentType)
		}
		if r.Header.Get("If-None-Match") == body.tag {
			w.Header().Del("Vary")
			w.WriteHeader(304)
			return
		}
		if body.rewritten {
			if r.Method != "HEAD" {
				_, _ = w.Write(body.data)
			}
			return
		}
		http.ServeContent(w, r, name, body.modTime, bytes.NewReader(body.data))
	})
}

func setStaticCacheHeaders(w http.ResponseWriter, name string, immutable bool) {
	switch {
	case name == "sw.js":
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Service-Worker-Allowed", "/")
	case name == "share-error.html":
		w.Header().Set("Cache-Control", "public, max-age=0")
	case name == "CHANGELOG.md":
		w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	case strings.HasPrefix(name, "locales/"):
		w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	case strings.HasPrefix(name, "js/") || strings.HasPrefix(name, "css/") || strings.HasPrefix(name, "icons/") || name == "manifest.webmanifest" || name == "CHANGELOG.md":
		if immutable {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
	}
}

func staticContentType(name string) string {
	switch {
	case name == "sw.js":
		return "application/javascript; charset=utf-8"
	case name == "manifest.webmanifest":
		return "application/manifest+json; charset=utf-8"
	case name == "CHANGELOG.md":
		return "text/markdown; charset=utf-8"
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=UTF-8"
	case strings.HasSuffix(name, ".js"):
		return "application/javascript; charset=UTF-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=UTF-8"
	case strings.HasSuffix(name, ".json"):
		return "application/json; charset=UTF-8"
	case strings.HasSuffix(name, ".webmanifest"):
		return "application/manifest+json; charset=UTF-8"
	case strings.HasSuffix(name, ".md"):
		return "text/markdown; charset=UTF-8"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".jpg") || strings.HasSuffix(name, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(name, ".ico"):
		return "image/x-icon"
	default:
		return "application/octet-stream"
	}
}
