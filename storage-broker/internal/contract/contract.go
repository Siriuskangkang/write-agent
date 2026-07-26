package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type Kind string

const (
	KindPromote          Kind = "PROMOTE"
	KindDeleteQuarantine Kind = "DELETE_QUARANTINE"
	KindDeleteBlob       Kind = "DELETE_BLOB"
	KindAbortPromotion   Kind = "ABORT_PROMOTION"
)

const (
	StateSucceeded = "SUCCEEDED"
	StateRetry     = "RETRY"
	StateRejected  = "REJECTED"
)

var (
	ErrInvalidIntent  = errors.New("storage intent is invalid")
	ErrInvalidOutcome = errors.New("storage outcome is invalid")
	uuidPattern       = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	)
	storageKeyPattern = regexp.MustCompile(
		`^p/([0-9a-f-]{36})/f/([0-9a-f-]{36})/g/([1-9][0-9]*)/([0-9a-f]{64})\.blob$`,
	)
	codePattern = regexp.MustCompile(`^STORAGE_[A-Z0-9_]{1,120}$`)
)

type Intent struct {
	IntentID         string
	Kind             Kind
	ProjectID        string
	SourceFileID     string
	ObjectID         string
	ObjectGeneration uint64
	StorageKey       string
	QuarantineKey    *string
	ExpectedSHA256   [sha256.Size]byte
	ExpectedSize     uint64
	StorageEpoch     string
	ExecutionFence   uint64
	LeaseToken       string
}

type Outcome struct {
	State          string
	ObservedSHA256 string
	ObservedSize   uint64
	Code           string
	SanitizedError string
}

func (intent Intent) Validate() error {
	if !validUUID(intent.IntentID) ||
		!validUUID(intent.ProjectID) ||
		!validUUID(intent.SourceFileID) ||
		!validUUID(intent.ObjectID) ||
		!validUUID(intent.StorageEpoch) ||
		!validUUID(intent.LeaseToken) ||
		intent.ObjectGeneration == 0 ||
		intent.ExecutionFence == 0 {
		return ErrInvalidIntent
	}
	match := storageKeyPattern.FindStringSubmatch(intent.StorageKey)
	if len(match) != 5 ||
		!validUUID(match[1]) ||
		!validUUID(match[2]) ||
		match[1] != intent.ProjectID ||
		match[2] != intent.SourceFileID ||
		match[3] != strconv.FormatUint(intent.ObjectGeneration, 10) ||
		match[4] != hex.EncodeToString(intent.ExpectedSHA256[:]) {
		return ErrInvalidIntent
	}
	expectedQuarantine := intent.IntentID + ".upload"
	switch intent.Kind {
	case KindPromote, KindDeleteQuarantine, KindAbortPromotion:
		if intent.QuarantineKey == nil ||
			*intent.QuarantineKey != expectedQuarantine {
			return ErrInvalidIntent
		}
	case KindDeleteBlob:
		if intent.QuarantineKey != nil {
			return ErrInvalidIntent
		}
	default:
		return ErrInvalidIntent
	}
	return nil
}

func (intent Intent) StorageSegments() ([]string, error) {
	if err := intent.Validate(); err != nil {
		return nil, err
	}
	segments := strings.Split(intent.StorageKey, "/")
	if len(segments) != 7 {
		return nil, ErrInvalidIntent
	}
	return segments, nil
}

func (outcome Outcome) Validate() error {
	if !codePattern.MatchString(outcome.Code) ||
		len(outcome.SanitizedError) > 128 ||
		(outcome.SanitizedError != "" &&
			!codePattern.MatchString(outcome.SanitizedError)) {
		return ErrInvalidOutcome
	}
	switch outcome.State {
	case StateSucceeded:
		if outcome.SanitizedError != "" {
			return ErrInvalidOutcome
		}
	case StateRetry:
		if outcome.SanitizedError == "" {
			return ErrInvalidOutcome
		}
	case StateRejected:
	default:
		return ErrInvalidOutcome
	}
	if outcome.ObservedSHA256 != "" {
		if len(outcome.ObservedSHA256) != sha256.Size*2 {
			return ErrInvalidOutcome
		}
		if _, err := hex.DecodeString(outcome.ObservedSHA256); err != nil {
			return ErrInvalidOutcome
		}
	}
	return nil
}

func (intent Intent) String() string {
	return fmt.Sprintf("intent=%s kind=%s", intent.IntentID, intent.Kind)
}

func validUUID(value string) bool {
	return uuidPattern.MatchString(value)
}
