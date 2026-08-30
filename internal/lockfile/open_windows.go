//go:build windows

// Package lockfile provides the platform-specific file creation primitive used
// by HandoffGraph's pathname locks.
package lockfile

import (
	"os"

	"golang.org/x/sys/windows"
)

// OpenExclusive creates path without replacing an existing lock. FILE_SHARE_DELETE
// lets release remove the pathname while the ownership descriptor stays open.
func OpenExclusive(path string, _ os.FileMode) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	handle, err := windows.CreateFile(
		name,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.CREATE_NEW,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(handle), path), nil
}
