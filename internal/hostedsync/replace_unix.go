//go:build darwin || linux

package hostedsync

import "os"

func replaceFile(source, target string) error {
	return os.Rename(source, target)
}
