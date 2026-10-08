// Package webassets embeds the browser bundle into tgdl-server so production
// serves one Go process. The JavaScript here is client code; no JavaScript
// runtime is started by the server.
package webassets

import "embed"

// FS contains the public SPA rooted at "public".
//
//go:embed public
var FS embed.FS
