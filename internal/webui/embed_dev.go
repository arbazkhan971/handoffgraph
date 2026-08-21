//go:build dev

package webui

import (
	"io/fs"
	"os"
)

// In dev builds the assets are served straight from web/dist on disk so UI
// work does not require a rebuild-and-reembed cycle. When web/dist has not
// been built, distAssets returns nil and the server falls back to the inline
// placeholder page.
func distAssets() fs.FS {
	for _, dir := range []string{"web/dist", "../web/dist"} {
		if f, err := os.Open(dir + "/index.html"); err == nil {
			f.Close()
			return os.DirFS(dir)
		}
	}
	return nil
}
