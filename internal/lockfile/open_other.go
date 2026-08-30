//go:build !windows

// Package lockfile provides the platform-specific file creation primitive used
// by HandoffGraph's pathname locks.
package lockfile

import (
	"os"
)

// OpenExclusive creates path without replacing an existing lock. The returned
// descriptor remains open through release so its file identity cannot be
// recycled while ownership is verified.
func OpenExclusive(path string, mode os.FileMode) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, mode)
}
