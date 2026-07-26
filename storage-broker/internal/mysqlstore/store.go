package mysqlstore

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"

	"write-agent/storage-broker/internal/contract"
)

var (
	ErrNoWork               = errors.New("storage authority has no work")
	ErrAuthorityContract    = errors.New("storage authority contract violation")
	ErrAuthorityUnavailable = errors.New("storage authority unavailable")
)

const (
	claimSQL    = "CALL sp_storage_claim_v1(?,?,?)"
	completeSQL = "CALL sp_storage_complete_v1(?,?,?,?,?,?,?,?)"
)

type Store struct {
	db                *sql.DB
	retryAfterSeconds uint32
}

func New(db *sql.DB) *Store {
	return &Store{db: db, retryAfterSeconds: 5}
}

func (store *Store) Claim(
	ctx context.Context,
	instanceID string,
	leaseSeconds uint32,
	epoch string,
) (*contract.Intent, error) {
	if store == nil || store.db == nil ||
		instanceID == "" ||
		leaseSeconds < 5 ||
		leaseSeconds > 300 ||
		epoch == "" {
		return nil, ErrAuthorityContract
	}
	rows, err := store.db.QueryContext(
		ctx,
		claimSQL,
		instanceID,
		leaseSeconds,
		epoch,
	)
	if err != nil {
		return nil, ErrAuthorityUnavailable
	}
	defer rows.Close()
	if !rows.Next() {
		if rows.Err() != nil {
			return nil, ErrAuthorityUnavailable
		}
		return nil, ErrNoWork
	}

	var (
		intentID, kind, projectID, sourceFileID, objectID string
		generation, storageKey, expectedSHA, expectedSize string
		authorizationKind, authorizationID, storageEpoch  string
		status, executionFence, leaseToken, leaseExpires  string
		quarantine                                        sql.NullString
	)
	if err := rows.Scan(
		&intentID,
		&kind,
		&projectID,
		&sourceFileID,
		&objectID,
		&generation,
		&storageKey,
		&quarantine,
		&expectedSHA,
		&expectedSize,
		&authorizationKind,
		&authorizationID,
		&storageEpoch,
		&status,
		&executionFence,
		&leaseToken,
		&leaseExpires,
	); err != nil {
		return nil, ErrAuthorityContract
	}
	if rows.Next() {
		return nil, ErrAuthorityContract
	}
	if err := rows.Err(); err != nil {
		return nil, ErrAuthorityUnavailable
	}
	_ = authorizationKind
	_ = authorizationID
	_ = leaseExpires
	if status != "EXECUTING" || storageEpoch != epoch {
		return nil, ErrAuthorityContract
	}
	objectGeneration, err := parseUint64(generation)
	if err != nil {
		return nil, ErrAuthorityContract
	}
	size, err := parseUint64(expectedSize)
	if err != nil {
		return nil, ErrAuthorityContract
	}
	fence, err := parseUint64(executionFence)
	if err != nil {
		return nil, ErrAuthorityContract
	}
	decodedSHA, err := hex.DecodeString(expectedSHA)
	if err != nil || len(decodedSHA) != 32 {
		return nil, ErrAuthorityContract
	}
	var digest [32]byte
	copy(digest[:], decodedSHA)
	var quarantineKey *string
	if quarantine.Valid {
		value := quarantine.String
		quarantineKey = &value
	}
	intent := &contract.Intent{
		IntentID:         intentID,
		Kind:             contract.Kind(kind),
		ProjectID:        projectID,
		SourceFileID:     sourceFileID,
		ObjectID:         objectID,
		ObjectGeneration: objectGeneration,
		StorageKey:       storageKey,
		QuarantineKey:    quarantineKey,
		ExpectedSHA256:   digest,
		ExpectedSize:     size,
		StorageEpoch:     storageEpoch,
		ExecutionFence:   fence,
		LeaseToken:       leaseToken,
	}
	if err := intent.Validate(); err != nil {
		return nil, ErrAuthorityContract
	}
	return intent, nil
}

func (store *Store) Complete(
	ctx context.Context,
	claim contract.Intent,
	outcome contract.Outcome,
	epoch string,
) error {
	if store == nil || store.db == nil ||
		claim.IntentID == "" ||
		claim.LeaseToken == "" ||
		claim.ExecutionFence == 0 ||
		epoch == "" ||
		claim.StorageEpoch != epoch ||
		outcome.Validate() != nil {
		return ErrAuthorityContract
	}
	var resultCode, lastError any
	var retryAfter any
	switch outcome.State {
	case contract.StateSucceeded:
		resultCode = outcome.Code
	case contract.StateRetry:
		lastError = outcome.SanitizedError
		retryAfter = int64(store.retryAfterSeconds)
	case contract.StateRejected:
		resultCode = outcome.Code
		if outcome.SanitizedError != "" {
			lastError = outcome.SanitizedError
		}
	default:
		return ErrAuthorityContract
	}
	rows, err := store.db.QueryContext(
		ctx,
		completeSQL,
		claim.IntentID,
		claim.LeaseToken,
		claim.ExecutionFence,
		epoch,
		outcome.State,
		resultCode,
		lastError,
		retryAfter,
	)
	if err != nil {
		return ErrAuthorityUnavailable
	}
	defer rows.Close()
	if !rows.Next() {
		return ErrAuthorityContract
	}
	var (
		intentID, status, executionFence  string
		objectState, outboxStatus, result sql.NullString
	)
	if err := rows.Scan(
		&intentID,
		&status,
		&objectState,
		&outboxStatus,
		&executionFence,
		&result,
	); err != nil {
		return ErrAuthorityContract
	}
	if rows.Next() {
		return ErrAuthorityContract
	}
	if err := rows.Err(); err != nil {
		return ErrAuthorityUnavailable
	}
	fence, err := parseUint64(executionFence)
	if err != nil ||
		intentID != claim.IntentID ||
		status != outcome.State ||
		fence != claim.ExecutionFence ||
		(outcome.State == contract.StateRetry && result.Valid) ||
		(outcome.State != contract.StateRetry &&
			(!result.Valid || result.String != outcome.Code)) {
		return ErrAuthorityContract
	}
	return nil
}

func parseUint64(value string) (uint64, error) {
	if value == "" ||
		(len(value) > 1 && value[0] == '0') {
		return 0, ErrAuthorityContract
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, ErrAuthorityContract
	}
	return parsed, nil
}
