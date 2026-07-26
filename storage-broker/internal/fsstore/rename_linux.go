//go:build linux

package fsstore

import "golang.org/x/sys/unix"

func renameNoReplace(
	oldDirFD int,
	oldPath string,
	newDirFD int,
	newPath string,
) error {
	return unix.Renameat2(
		oldDirFD,
		oldPath,
		newDirFD,
		newPath,
		unix.RENAME_NOREPLACE,
	)
}
