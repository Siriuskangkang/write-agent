package fsstore

import (
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"

	"write-agent/storage-broker/internal/contract"
)

const (
	testIntentID  = "22222222-2222-4222-8222-222222222222"
	testProjectID = "33333333-3333-4333-8333-333333333333"
	testFileID    = "44444444-4444-4444-8444-444444444444"
	testObjectID  = "55555555-5555-4555-8555-555555555555"
	testEpoch     = "77777777-7777-4777-8777-777777777777"
	testLease     = "88888888-8888-4888-8888-888888888888"
)

var testPayload = []byte("教材素材")

type roots struct {
	protected  string
	quarantine string
	store      *Store
}

func newRoots(t *testing.T) roots {
	t.Helper()
	base := t.TempDir()
	protected := filepath.Join(base, "protected")
	quarantine := filepath.Join(base, "quarantine")
	if err := os.Mkdir(protected, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(quarantine, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := New(protected, quarantine)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return roots{protected: protected, quarantine: quarantine, store: store}
}

func validPromoteIntent() contract.Intent {
	digest := sha256.Sum256(testPayload)
	quarantineKey := testIntentID + ".upload"
	return contract.Intent{
		IntentID:         testIntentID,
		Kind:             contract.KindPromote,
		ProjectID:        testProjectID,
		SourceFileID:     testFileID,
		ObjectID:         testObjectID,
		ObjectGeneration: 1,
		StorageKey: "p/" + testProjectID + "/f/" + testFileID +
			"/g/1/" + hexDigest(digest) + ".blob",
		QuarantineKey:  &quarantineKey,
		ExpectedSHA256: digest,
		ExpectedSize:   uint64(len(testPayload)),
		StorageEpoch:   testEpoch,
		ExecutionFence: 1,
		LeaseToken:     testLease,
	}
}

func validDeleteIntent() contract.Intent {
	intent := validPromoteIntent()
	intent.Kind = contract.KindDeleteBlob
	intent.QuarantineKey = nil
	return intent
}

func writeQuarantine(t *testing.T, roots roots, intent contract.Intent, data []byte) string {
	t.Helper()
	if intent.QuarantineKey == nil {
		t.Fatal("missing quarantine key")
	}
	path := filepath.Join(roots.quarantine, *intent.QuarantineKey)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func finalPath(roots roots, intent contract.Intent) string {
	return filepath.Join(roots.protected, filepath.FromSlash(intent.StorageKey))
}

func TestPromoteVerifiesHashSizeAndCreatesReadOnlyBlob(t *testing.T) {
	roots := newRoots(t)
	intent := validPromoteIntent()
	source := writeQuarantine(t, roots, intent, testPayload)

	result := roots.store.Execute(context.Background(), intent)

	if result.Code != "STORAGE_PROMOTED" || result.State != "SUCCEEDED" {
		t.Fatalf("unexpected outcome: %+v", result)
	}
	info, err := os.Stat(finalPath(roots, intent))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o440 {
		t.Fatalf("mode = %o", info.Mode().Perm())
	}
	content, err := os.ReadFile(finalPath(roots, intent))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(testPayload) {
		t.Fatalf("content = %q", content)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("quarantine still exists: %v", err)
	}
	if result.ObservedSHA256 != hexDigest(intent.ExpectedSHA256) ||
		result.ObservedSize != intent.ExpectedSize {
		t.Fatalf("observed mismatch: %+v", result)
	}
}

func TestPromoteRejectsHashSizeMismatchAndFsyncsDurabilityBoundaries(t *testing.T) {
	t.Run("hash", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		intent.ExpectedSHA256 = sha256.Sum256([]byte("different"))
		intent.StorageKey = "p/" + testProjectID + "/f/" + testFileID +
			"/g/1/" + hexDigest(intent.ExpectedSHA256) + ".blob"
		writeQuarantine(t, roots, intent, testPayload)
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_INTEGRITY_MISMATCH" ||
			result.State != "REJECTED" {
			t.Fatalf("%+v", result)
		}
		if _, err := os.Stat(finalPath(roots, intent)); !os.IsNotExist(err) {
			t.Fatalf("final unexpectedly exists: %v", err)
		}
	})

	t.Run("size", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		intent.ExpectedSize++
		writeQuarantine(t, roots, intent, testPayload)
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_INTEGRITY_MISMATCH" {
			t.Fatalf("%+v", result)
		}
	})

	t.Run("fsync file staging and final parent", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		writeQuarantine(t, roots, intent, testPayload)
		n := 0
		nativeFsync := roots.store.fsync
		roots.store.fsync = func(fd int) error {
			n++
			return nativeFsync(fd)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_PROMOTED" {
			t.Fatalf("%+v", result)
		}
		if n < 3 {
			t.Fatalf("fsync calls = %d, want file and both directories", n)
		}
	})
}

func TestRejectsSymlinkTraversalHardlinkAndCollision(t *testing.T) {
	t.Run("symlink directory", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		writeQuarantine(t, roots, intent, testPayload)
		if err := os.Mkdir(filepath.Join(roots.protected, "p"), 0o700); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		if err := os.Symlink(
			outside,
			filepath.Join(roots.protected, "p", testProjectID),
		); err != nil {
			t.Fatal(err)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_PATH_UNSAFE" {
			t.Fatalf("%+v", result)
		}
	})

	t.Run("traversal and identity mismatch", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		intent.StorageKey = "p/" + testProjectID + "/f/" + testFileID +
			"/g/1/../" + hexDigest(intent.ExpectedSHA256) + ".blob"
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_PATH_UNSAFE" {
			t.Fatalf("%+v", result)
		}
	})

	t.Run("hardlink source", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		source := writeQuarantine(t, roots, intent, testPayload)
		if err := os.Link(source, source+".alias"); err != nil {
			t.Fatal(err)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_PATH_UNSAFE" {
			t.Fatalf("%+v", result)
		}
	})

	t.Run("final collision", func(t *testing.T) {
		roots := newRoots(t)
		intent := validPromoteIntent()
		writeQuarantine(t, roots, intent, testPayload)
		path := finalPath(roots, intent)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("collision"), 0o440); err != nil {
			t.Fatal(err)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_COLLISION" {
			t.Fatalf("%+v", result)
		}
	})
}

func TestDeleteENOENTIsIdempotentSuccess(t *testing.T) {
	roots := newRoots(t)
	result := roots.store.Execute(context.Background(), validDeleteIntent())
	if result.Code != "STORAGE_ALREADY_ABSENT" || result.State != "SUCCEEDED" {
		t.Fatalf("%+v", result)
	}
}

func TestDeleteRejectsSymlinkAndRemovesVerifiedRegularBlob(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		roots := newRoots(t)
		intent := validDeleteIntent()
		path := finalPath(roots, intent)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(t.TempDir(), path); err != nil {
			t.Fatal(err)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_PATH_UNSAFE" {
			t.Fatalf("%+v", result)
		}
	})

	t.Run("regular", func(t *testing.T) {
		roots := newRoots(t)
		intent := validDeleteIntent()
		path := finalPath(roots, intent)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, testPayload, 0o440); err != nil {
			t.Fatal(err)
		}
		result := roots.store.Execute(context.Background(), intent)
		if result.Code != "STORAGE_DELETED" {
			t.Fatalf("%+v", result)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("blob remains: %v", err)
		}
	})
}

func hexDigest(value [32]byte) string {
	const digits = "0123456789abcdef"
	result := make([]byte, 64)
	for i, b := range value {
		result[i*2] = digits[b>>4]
		result[i*2+1] = digits[b&0x0f]
	}
	return string(result)
}
