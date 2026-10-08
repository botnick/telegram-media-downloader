package front

import (
	"io"
	"net/http"
	"os"
)

// ServeContent sends an already-open regular file with the existing media
// HTTP contract. It does not use the front server or its reverse proxy.
// The caller owns f and is responsible for authorizing and bounding its path.
func ServeContent(w http.ResponseWriter, r *http.Request, f *os.File, name string) (int, error) {
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	var headers hdrList
	for name, values := range w.Header() {
		for _, value := range values {
			headers = append(headers, hdr{name, value})
		}
	}
	plan, ok := planSend(r, headers, info.Size(), info.ModTime(), name)
	if !ok {
		http.Error(w, "Invalid media request headers", http.StatusBadRequest)
		return http.StatusBadRequest, nil
	}
	clear(w.Header())
	plan.headers.writeTo(w)
	w.WriteHeader(plan.status)
	if r.Method == http.MethodHead {
		return plan.status, nil
	}
	if plan.text != "" {
		_, err = io.WriteString(w, plan.text)
	}
	if plan.body && plan.length > 0 {
		_, err = io.Copy(w, io.NewSectionReader(f, plan.start, plan.length))
	}
	return plan.status, err
}
