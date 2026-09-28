package front

import (
	"regexp"
	"strings"
)

var mimeTypes = parseMimeData(mimeData)

func parseMimeData(data string) map[string]string {
	m := make(map[string]string, 1100)
	for _, line := range strings.Split(data, "\n") {
		if ext, typ, ok := strings.Cut(line, " "); ok {
			m[ext] = typ
		}
	}
	return m
}

// mimeLookup mirrors mime 1.x lookup(path): the extension is everything
// after the last '.', '/' or '\', lower-cased; unknown extensions get the
// default type. (Callers only pass printable-ASCII paths, where
// JavaScript's `.` in /^.*[./\\]/ and toLowerCase agree with this.)
func mimeLookup(p string) string {
	ext := p
	if i := strings.LastIndexAny(p, `./\`); i >= 0 {
		ext = p[i+1:]
	}
	if t, ok := mimeTypes[strings.ToLower(ext)]; ok {
		return t
	}
	return defaultMimeType
}

var charsetRE = regexp.MustCompile(`^text/|^application/(javascript|json)`)

// sendContentType is the Content-Type send sets for a file path:
// type + "; charset=UTF-8" for text, JavaScript and JSON.
func sendContentType(p string) string {
	t := mimeLookup(p)
	if charsetRE.MatchString(t) {
		return t + "; charset=UTF-8"
	}
	return t
}
