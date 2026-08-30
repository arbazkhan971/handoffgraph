//go:build windows

package hostedsync

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

type stateLock struct {
	file       *os.File
	overlapped windows.Overlapped
}

func acquireStateLock(path string) (*stateLock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create hosted sync lock directory: %w", err)
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("hosted sync lock must not be a symlink")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect hosted sync lock: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open hosted sync lock: %w", err)
	}
	lock := &stateLock{file: file}
	err = windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &lock.overlapped,
	)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("another hosted sync is already running")
	}
	return lock, nil
}

func (l *stateLock) release() {
	if l == nil || l.file == nil {
		return
	}
	_ = windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, &l.overlapped)
	_ = l.file.Close()
}
