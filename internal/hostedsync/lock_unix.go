//go:build darwin || linux

package hostedsync

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type stateLock struct {
	file *os.File
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
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("protect hosted sync lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("another hosted sync is already running")
	}
	return &stateLock{file: file}, nil
}

func (l *stateLock) release() {
	if l == nil || l.file == nil {
		return
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	_ = l.file.Close()
}
