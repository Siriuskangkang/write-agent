package fsstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	"golang.org/x/sys/unix"

	"write-agent/storage-broker/internal/contract"
)

const (
	codePromoted         = "STORAGE_PROMOTED"
	codeDeleted          = "STORAGE_DELETED"
	codeAlreadyAbsent    = "STORAGE_ALREADY_ABSENT"
	codePathUnsafe       = "STORAGE_PATH_UNSAFE"
	codeCollision        = "STORAGE_COLLISION"
	codeIntegrity        = "STORAGE_INTEGRITY_MISMATCH"
	codeSourceMissing    = "STORAGE_SOURCE_MISSING"
	codeIO               = "STORAGE_IO_RETRY"
	codeCancelled        = "STORAGE_CANCELLED"
	directoryPermissions = 0o700
	stagingPermissions   = 0o600
	finalPermissions     = 0o440
)

type Store struct {
	protectedFD  int
	quarantineFD int
	fsync        func(int) error
	closeOnce    sync.Once
	closeErr     error
}

func New(protectedRoot, quarantineRoot string) (*Store, error) {
	protectedFD, protectedStat, err := openRoot(protectedRoot)
	if err != nil {
		return nil, errors.New("protected storage root is unavailable")
	}
	quarantineFD, quarantineStat, err := openRoot(quarantineRoot)
	if err != nil {
		_ = unix.Close(protectedFD)
		return nil, errors.New("quarantine storage root is unavailable")
	}
	if protectedStat.Dev == quarantineStat.Dev &&
		protectedStat.Ino == quarantineStat.Ino {
		_ = unix.Close(protectedFD)
		_ = unix.Close(quarantineFD)
		return nil, errors.New("storage roots must be distinct")
	}
	return &Store{
		protectedFD:  protectedFD,
		quarantineFD: quarantineFD,
		fsync:        unix.Fsync,
	}, nil
}

func (store *Store) Close() error {
	store.closeOnce.Do(func() {
		first := unix.Close(store.protectedFD)
		second := unix.Close(store.quarantineFD)
		if first != nil {
			store.closeErr = first
		} else {
			store.closeErr = second
		}
	})
	return store.closeErr
}

func (store *Store) Execute(
	ctx context.Context,
	intent contract.Intent,
) contract.Outcome {
	if err := intent.Validate(); err != nil {
		return rejected(codePathUnsafe)
	}
	if err := ctx.Err(); err != nil {
		return retry(codeCancelled)
	}
	switch intent.Kind {
	case contract.KindPromote:
		return store.promote(ctx, intent)
	case contract.KindDeleteQuarantine:
		return store.deleteQuarantine(ctx, intent)
	case contract.KindDeleteBlob:
		return store.deleteBlob(ctx, intent)
	case contract.KindAbortPromotion:
		return store.abortPromotion(ctx, intent)
	default:
		return rejected(codePathUnsafe)
	}
}

func openRoot(path string) (int, unix.Stat_t, error) {
	fd, err := unix.Open(
		path,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return -1, unix.Stat_t{}, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return -1, unix.Stat_t{}, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return -1, unix.Stat_t{}, unix.ENOTDIR
	}
	return fd, stat, nil
}

func (store *Store) promote(
	ctx context.Context,
	intent contract.Intent,
) contract.Outcome {
	segments, _ := intent.StorageSegments()
	finalParentFD, finalName, err := walkParent(
		store.protectedFD,
		segments,
		true,
	)
	if err != nil {
		return classifyPathError(err)
	}
	defer unix.Close(finalParentFD)

	if outcome, exists := verifyExistingFinal(finalParentFD, finalName, intent); exists {
		if outcome.State != contract.StateSucceeded {
			return outcome
		}
		deleted := store.unlinkQuarantine(intent)
		if deleted.State == contract.StateRetry ||
			deleted.State == contract.StateRejected {
			return deleted
		}
		return outcome
	}

	sourceFD, err := unix.Openat(
		store.quarantineFD,
		*intent.QuarantineKey,
		unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return rejected(codeSourceMissing)
		}
		return classifyPathError(err)
	}
	defer unix.Close(sourceFD)
	if err := requireRegularSingleLink(sourceFD); err != nil {
		return classifyPathError(err)
	}

	stagingFD, err := openOrCreateDir(finalParentFD, ".staging")
	if err != nil {
		return classifyPathError(err)
	}
	defer unix.Close(stagingFD)
	stagingName := intent.IntentID
	if err := removeSafeStaging(stagingFD, stagingName); err != nil {
		return classifyPathError(err)
	}
	targetFD, err := unix.Openat(
		stagingFD,
		stagingName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|
			unix.O_NOFOLLOW|unix.O_CLOEXEC,
		stagingPermissions,
	)
	if err != nil {
		return classifyCreateError(err)
	}
	targetOpen := true
	stagingPresent := true
	defer func() {
		if targetOpen {
			_ = unix.Close(targetFD)
		}
		if stagingPresent {
			_ = unix.Unlinkat(stagingFD, stagingName, 0)
			_ = store.fsync(stagingFD)
		}
	}()
	if err := store.fsync(stagingFD); err != nil {
		return retry(codeIO)
	}

	observedHash, observedSize, err := copyAndHash(
		ctx,
		sourceFD,
		targetFD,
		intent.ExpectedSize,
	)
	if err != nil {
		if errors.Is(err, context.Canceled) ||
			errors.Is(err, context.DeadlineExceeded) {
			return retry(codeCancelled)
		}
		return retry(codeIO)
	}
	if err := store.fsync(targetFD); err != nil {
		return retry(codeIO)
	}
	if observedSize != intent.ExpectedSize ||
		observedHash != intent.ExpectedSHA256 {
		return contract.Outcome{
			State:          contract.StateRejected,
			ObservedSHA256: hex.EncodeToString(observedHash[:]),
			ObservedSize:   observedSize,
			Code:           codeIntegrity,
			SanitizedError: codeIntegrity,
		}
	}
	if err := unix.Fchmod(targetFD, finalPermissions); err != nil {
		return retry(codeIO)
	}
	if err := store.fsync(targetFD); err != nil {
		return retry(codeIO)
	}
	if err := unix.Close(targetFD); err != nil {
		return retry(codeIO)
	}
	targetOpen = false

	err = renameNoReplace(stagingFD, stagingName, finalParentFD, finalName)
	if err != nil {
		if errors.Is(err, unix.EEXIST) {
			outcome, exists := verifyExistingFinal(
				finalParentFD,
				finalName,
				intent,
			)
			if exists && outcome.State == contract.StateSucceeded {
				if err := unix.Unlinkat(stagingFD, stagingName, 0); err != nil &&
					!errors.Is(err, unix.ENOENT) {
					return retry(codeIO)
				}
				stagingPresent = false
				if err := store.fsync(stagingFD); err != nil {
					return retry(codeIO)
				}
				return store.finishPromotion(intent, outcome)
			}
			return rejected(codeCollision)
		}
		return retry(codeIO)
	}
	stagingPresent = false
	if err := store.fsync(stagingFD); err != nil {
		return retry(codeIO)
	}
	if err := store.fsync(finalParentFD); err != nil {
		return retry(codeIO)
	}
	outcome, exists := verifyExistingFinal(finalParentFD, finalName, intent)
	if !exists || outcome.State != contract.StateSucceeded {
		if exists {
			return outcome
		}
		return retry(codeIO)
	}
	return store.finishPromotion(intent, outcome)
}

func (store *Store) finishPromotion(
	intent contract.Intent,
	outcome contract.Outcome,
) contract.Outcome {
	deleted := store.unlinkQuarantine(intent)
	if deleted.State == contract.StateRetry ||
		deleted.State == contract.StateRejected {
		return deleted
	}
	outcome.Code = codePromoted
	return outcome
}

func copyAndHash(
	ctx context.Context,
	sourceFD, targetFD int,
	expectedSize uint64,
) ([sha256.Size]byte, uint64, error) {
	digest := sha256.New()
	buffer := make([]byte, 64*1024)
	var size uint64
	for {
		if err := ctx.Err(); err != nil {
			return [sha256.Size]byte{}, size, err
		}
		n, err := unix.Read(sourceFD, buffer)
		if n > 0 {
			size += uint64(n)
			if size > expectedSize {
				_, _ = digest.Write(buffer[:n])
				var result [sha256.Size]byte
				copy(result[:], digest.Sum(nil))
				return result, size, nil
			}
			if _, hashErr := digest.Write(buffer[:n]); hashErr != nil {
				return [sha256.Size]byte{}, size, hashErr
			}
			written := 0
			for written < n {
				count, writeErr := unix.Write(targetFD, buffer[written:n])
				if writeErr != nil {
					return [sha256.Size]byte{}, size, writeErr
				}
				if count == 0 {
					return [sha256.Size]byte{}, size, unix.EIO
				}
				written += count
			}
		}
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return [sha256.Size]byte{}, size, err
		}
		if n == 0 {
			break
		}
	}
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result, size, nil
}

func verifyExistingFinal(
	parentFD int,
	name string,
	intent contract.Intent,
) (contract.Outcome, bool) {
	fd, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return contract.Outcome{}, false
		}
		return classifyPathError(err), true
	}
	defer unix.Close(fd)
	if err := requireRegularSingleLink(fd); err != nil {
		return classifyPathError(err), true
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return retry(codeIO), true
	}
	if stat.Mode&0o777 != finalPermissions {
		return rejected(codeCollision), true
	}
	digest, size, err := hashFD(fd)
	if err != nil {
		return retry(codeIO), true
	}
	if digest != intent.ExpectedSHA256 || size != intent.ExpectedSize {
		return rejected(codeCollision), true
	}
	return contract.Outcome{
		State:          contract.StateSucceeded,
		ObservedSHA256: hex.EncodeToString(digest[:]),
		ObservedSize:   size,
		Code:           codePromoted,
	}, true
}

func hashFD(fd int) ([sha256.Size]byte, uint64, error) {
	if _, err := unix.Seek(fd, 0, 0); err != nil {
		return [sha256.Size]byte{}, 0, err
	}
	digest := sha256.New()
	buffer := make([]byte, 64*1024)
	var size uint64
	for {
		n, err := unix.Read(fd, buffer)
		if n > 0 {
			size += uint64(n)
			_, _ = digest.Write(buffer[:n])
		}
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return [sha256.Size]byte{}, size, err
		}
		if n == 0 {
			break
		}
	}
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result, size, nil
}

func (store *Store) deleteBlob(
	_ context.Context,
	intent contract.Intent,
) contract.Outcome {
	segments, _ := intent.StorageSegments()
	parentFD, name, err := walkParent(store.protectedFD, segments, false)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return succeeded(codeAlreadyAbsent)
		}
		return classifyPathError(err)
	}
	defer unix.Close(parentFD)
	return store.deleteVerified(parentFD, name, intent)
}

func (store *Store) deleteQuarantine(
	_ context.Context,
	intent contract.Intent,
) contract.Outcome {
	return store.unlinkQuarantine(intent)
}

func (store *Store) unlinkQuarantine(
	intent contract.Intent,
) contract.Outcome {
	return store.deleteVerified(
		store.quarantineFD,
		*intent.QuarantineKey,
		intent,
	)
}

func (store *Store) abortPromotion(
	ctx context.Context,
	intent contract.Intent,
) contract.Outcome {
	blob := store.deleteBlob(ctx, intent)
	if blob.State != contract.StateSucceeded {
		return blob
	}
	quarantine := store.deleteQuarantine(ctx, intent)
	if quarantine.State != contract.StateSucceeded {
		return quarantine
	}
	if blob.Code == codeAlreadyAbsent &&
		quarantine.Code == codeAlreadyAbsent {
		return succeeded(codeAlreadyAbsent)
	}
	return succeeded(codeDeleted)
}

func (store *Store) deleteVerified(
	parentFD int,
	name string,
	intent contract.Intent,
) contract.Outcome {
	fd, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return succeeded(codeAlreadyAbsent)
		}
		return classifyPathError(err)
	}
	if err := requireRegularSingleLink(fd); err != nil {
		_ = unix.Close(fd)
		return classifyPathError(err)
	}
	digest, size, err := hashFD(fd)
	closeErr := unix.Close(fd)
	if err != nil || closeErr != nil {
		return retry(codeIO)
	}
	if digest != intent.ExpectedSHA256 || size != intent.ExpectedSize {
		return contract.Outcome{
			State:          contract.StateRejected,
			ObservedSHA256: hex.EncodeToString(digest[:]),
			ObservedSize:   size,
			Code:           codeIntegrity,
			SanitizedError: codeIntegrity,
		}
	}
	if err := unix.Unlinkat(parentFD, name, 0); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return succeeded(codeAlreadyAbsent)
		}
		return classifyPathError(err)
	}
	if err := store.fsync(parentFD); err != nil {
		return retry(codeIO)
	}
	return contract.Outcome{
		State:          contract.StateSucceeded,
		ObservedSHA256: hex.EncodeToString(digest[:]),
		ObservedSize:   size,
		Code:           codeDeleted,
	}
}

func walkParent(
	rootFD int,
	segments []string,
	create bool,
) (int, string, error) {
	if len(segments) < 2 {
		return -1, "", unix.EINVAL
	}
	currentFD := rootFD
	owned := false
	for _, segment := range segments[:len(segments)-1] {
		if segment == "" || segment == "." || segment == ".." {
			if owned {
				_ = unix.Close(currentFD)
			}
			return -1, "", unix.EINVAL
		}
		nextFD, err := openDirAt(currentFD, segment, create)
		if owned {
			_ = unix.Close(currentFD)
		}
		if err != nil {
			return -1, "", err
		}
		currentFD = nextFD
		owned = true
	}
	return currentFD, segments[len(segments)-1], nil
}

func openOrCreateDir(parentFD int, name string) (int, error) {
	return openDirAt(parentFD, name, true)
}

func openDirAt(parentFD int, name string, create bool) (int, error) {
	if create {
		err := unix.Mkdirat(parentFD, name, directoryPermissions)
		if err != nil && !errors.Is(err, unix.EEXIST) {
			return -1, err
		}
	}
	fd, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return -1, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return -1, unix.ENOTDIR
	}
	return fd, nil
}

func requireRegularSingleLink(fd int) error {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 {
		return unix.ELOOP
	}
	return nil
}

func removeSafeStaging(parentFD int, name string) error {
	fd, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	regularErr := requireRegularSingleLink(fd)
	closeErr := unix.Close(fd)
	if regularErr != nil {
		return regularErr
	}
	if closeErr != nil {
		return closeErr
	}
	return unix.Unlinkat(parentFD, name, 0)
}

func classifyCreateError(err error) contract.Outcome {
	if errors.Is(err, unix.EEXIST) {
		return rejected(codeCollision)
	}
	return classifyPathError(err)
}

func classifyPathError(err error) contract.Outcome {
	if errors.Is(err, unix.ELOOP) ||
		errors.Is(err, unix.ENOTDIR) ||
		errors.Is(err, unix.EINVAL) {
		return rejected(codePathUnsafe)
	}
	return retry(codeIO)
}

func succeeded(code string) contract.Outcome {
	return contract.Outcome{State: contract.StateSucceeded, Code: code}
}

func rejected(code string) contract.Outcome {
	return contract.Outcome{
		State:          contract.StateRejected,
		Code:           code,
		SanitizedError: code,
	}
}

func retry(code string) contract.Outcome {
	return contract.Outcome{
		State:          contract.StateRetry,
		Code:           code,
		SanitizedError: code,
	}
}
