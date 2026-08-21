//go:build !dev

package webui

import (
	"embed"
	"io/fs"
)

// embedded carries the built web bundle. The committed placeholder
// index.html guarantees this file compiles even before the frontend has
// been built; running `npm run build` in web/ replaces the directory
// wholesale with the real bundle (see the postbuild script in
// web/package.json, which copies web/dist here).
//
//go:embed all:dist
var embedded embed.FS

// distAssets returns the embedded bundle filesystem, or nil when unavailable.
func distAssets() fs.FS {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil // unreachable: dist always contains at least the placeholder
	}
	return sub
}
