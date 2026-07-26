//go:build darwin

package fsstore

import "golang.org/x/sys/unix"

func renameNoReplace(
	oldDirFD int,
	oldPath string,
	newDirFD int,
	newPath string,
) error {
	return unix.RenameatxNp(
		oldDirFD,
		oldPath,
		newDirFD,
		newPath,
		unix.RENAME_EXCL,
	)
}
