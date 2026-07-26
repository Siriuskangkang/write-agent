package mysqlstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
	"testing"

	"write-agent/storage-broker/internal/contract"
)

func TestClaimMapsExactExecutionViewOrderAndNoWork(t *testing.T) {
	state := &fakeState{
		rows: [][]driver.Value{claimRow()},
	}
	db := openFakeDB(t, state)
	store := New(db)

	intent, err := store.Claim(
		context.Background(),
		"broker-1",
		30,
		"77777777-7777-4777-8777-777777777777",
	)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Kind != contract.KindPromote ||
		intent.ObjectGeneration != 1 ||
		intent.ExpectedSize != 12 ||
		intent.LeaseToken != "88888888-8888-4888-8888-888888888888" {
		t.Fatalf("%+v", intent)
	}
	if state.query != "CALL sp_storage_claim_v1(?,?,?)" {
		t.Fatalf("query = %q", state.query)
	}

	state.rows = nil
	intent, err = store.Claim(
		context.Background(),
		"broker-1",
		30,
		"77777777-7777-4777-8777-777777777777",
	)
	if intent != nil || !errors.Is(err, ErrNoWork) {
		t.Fatalf("intent=%+v err=%v", intent, err)
	}
}

func TestClaimRejectsMalformedRowsWithoutReturningRawSQLError(t *testing.T) {
	state := &fakeState{rows: [][]driver.Value{claimRow()}}
	state.rows[0][1] = "UNKNOWN"
	db := openFakeDB(t, state)
	_, err := New(db).Claim(
		context.Background(),
		"broker-1",
		30,
		"77777777-7777-4777-8777-777777777777",
	)
	if !errors.Is(err, ErrAuthorityContract) {
		t.Fatalf("err = %v", err)
	}

	state.queryErr = errors.New("password=secret raw sql failure")
	state.rows = nil
	_, err = New(db).Claim(
		context.Background(),
		"broker-1",
		30,
		"77777777-7777-4777-8777-777777777777",
	)
	if !errors.Is(err, ErrAuthorityUnavailable) ||
		err.Error() == state.queryErr.Error() {
		t.Fatalf("unsafe error = %v", err)
	}
}

func TestCompleteMapsSucceededRetryAndRejected(t *testing.T) {
	tests := []struct {
		name    string
		outcome contract.Outcome
		want    []driver.NamedValue
	}{
		{
			name: "succeeded",
			outcome: contract.Outcome{
				State: "SUCCEEDED",
				Code:  "STORAGE_PROMOTED",
			},
			want: completionArgs("SUCCEEDED", "STORAGE_PROMOTED", nil, nil),
		},
		{
			name: "retry",
			outcome: contract.Outcome{
				State:          "RETRY",
				Code:           "STORAGE_IO_RETRY",
				SanitizedError: "STORAGE_IO_RETRY",
			},
			want: completionArgs("RETRY", nil, "STORAGE_IO_RETRY", int64(5)),
		},
		{
			name: "rejected",
			outcome: contract.Outcome{
				State:          "REJECTED",
				Code:           "STORAGE_PATH_UNSAFE",
				SanitizedError: "STORAGE_PATH_UNSAFE",
			},
			want: completionArgs(
				"REJECTED",
				"STORAGE_PATH_UNSAFE",
				"STORAGE_PATH_UNSAFE",
				nil,
			),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state := &fakeState{
				rows: [][]driver.Value{{
					"22222222-2222-4222-8222-222222222222",
					tt.outcome.State,
					"AVAILABLE",
					nil,
					uint64(3),
					nullableResult(tt.outcome),
				}},
			}
			db := openFakeDB(t, state)
			err := New(db).Complete(
				context.Background(),
				claimIntent(),
				tt.outcome,
				"77777777-7777-4777-8777-777777777777",
			)
			if err != nil {
				t.Fatal(err)
			}
			if state.query != "CALL sp_storage_complete_v1(?,?,?,?,?,?,?,?)" {
				t.Fatalf("query = %q", state.query)
			}
			assertArgs(t, state.args, tt.want)
		})
	}
}

func TestCompleteRejectsInvalidOutcomeBeforeDatabaseIO(t *testing.T) {
	state := &fakeState{}
	db := openFakeDB(t, state)
	err := New(db).Complete(
		context.Background(),
		claimIntent(),
		contract.Outcome{State: "SUCCEEDED"},
		"77777777-7777-4777-8777-777777777777",
	)
	if !errors.Is(err, ErrAuthorityContract) {
		t.Fatalf("err = %v", err)
	}
	if state.query != "" {
		t.Fatalf("database called: %q", state.query)
	}
}

func claimRow() []driver.Value {
	return []driver.Value{
		"22222222-2222-4222-8222-222222222222",
		"PROMOTE",
		"33333333-3333-4333-8333-333333333333",
		"44444444-4444-4444-8444-444444444444",
		"55555555-5555-4555-8555-555555555555",
		uint64(1),
		"p/33333333-3333-4333-8333-333333333333/f/" +
			"44444444-4444-4444-8444-444444444444/g/1/" +
			"2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae.blob",
		"22222222-2222-4222-8222-222222222222.upload",
		"2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		uint64(12),
		"UPLOAD_COMMIT",
		"66666666-6666-4666-8666-666666666666",
		"77777777-7777-4777-8777-777777777777",
		"EXECUTING",
		uint64(3),
		"88888888-8888-4888-8888-888888888888",
		"2026-07-27 12:00:00.000000",
	}
}

func claimIntent() contract.Intent {
	row := claimRow()
	digest := [32]byte{}
	for i := range digest {
		digest[i] = byte(i)
	}
	key := row[7].(string)
	return contract.Intent{
		IntentID:         row[0].(string),
		Kind:             contract.KindPromote,
		ProjectID:        row[2].(string),
		SourceFileID:     row[3].(string),
		ObjectID:         row[4].(string),
		ObjectGeneration: 1,
		StorageKey:       row[6].(string),
		QuarantineKey:    &key,
		ExpectedSHA256:   digest,
		ExpectedSize:     12,
		StorageEpoch:     row[12].(string),
		ExecutionFence:   3,
		LeaseToken:       row[15].(string),
	}
}

func completionArgs(
	state string,
	code any,
	lastError any,
	retry any,
) []driver.NamedValue {
	return []driver.NamedValue{
		{Ordinal: 1, Value: "22222222-2222-4222-8222-222222222222"},
		{Ordinal: 2, Value: "88888888-8888-4888-8888-888888888888"},
		{Ordinal: 3, Value: int64(3)},
		{Ordinal: 4, Value: "77777777-7777-4777-8777-777777777777"},
		{Ordinal: 5, Value: state},
		{Ordinal: 6, Value: code},
		{Ordinal: 7, Value: lastError},
		{Ordinal: 8, Value: retry},
	}
}

func nullableResult(outcome contract.Outcome) any {
	if outcome.State == "RETRY" {
		return nil
	}
	return outcome.Code
}

func assertArgs(t *testing.T, got, want []driver.NamedValue) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("args len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].Value != want[i].Value {
			t.Fatalf("arg %d = %#v, want %#v", i+1, got[i].Value, want[i].Value)
		}
	}
}

type fakeState struct {
	mu       sync.Mutex
	query    string
	args     []driver.NamedValue
	rows     [][]driver.Value
	queryErr error
}

type fakeDriver struct{ state *fakeState }
type fakeConnector struct{ state *fakeState }
type fakeConn struct{ state *fakeState }
type fakeRows struct {
	rows  [][]driver.Value
	index int
}

func openFakeDB(t *testing.T, state *fakeState) *sql.DB {
	t.Helper()
	db := sql.OpenDB(fakeConnector{state: state})
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close db: %v", err)
		}
	})
	return db
}

func (connector fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return fakeConn{state: connector.state}, nil
}
func (connector fakeConnector) Driver() driver.Driver {
	return fakeDriver{state: connector.state}
}
func (driver fakeDriver) Open(string) (driver.Conn, error) {
	return fakeConn{state: driver.state}, nil
}
func (conn fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare unsupported")
}
func (conn fakeConn) Close() error { return nil }
func (conn fakeConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transaction unsupported")
}
func (conn fakeConn) QueryContext(
	_ context.Context,
	query string,
	args []driver.NamedValue,
) (driver.Rows, error) {
	conn.state.mu.Lock()
	defer conn.state.mu.Unlock()
	conn.state.query = query
	conn.state.args = append([]driver.NamedValue(nil), args...)
	if conn.state.queryErr != nil {
		return nil, conn.state.queryErr
	}
	rows := make([][]driver.Value, len(conn.state.rows))
	for i := range conn.state.rows {
		rows[i] = append([]driver.Value(nil), conn.state.rows[i]...)
	}
	return &fakeRows{rows: rows}, nil
}
func (rows *fakeRows) Columns() []string {
	if len(rows.rows) == 0 || len(rows.rows[0]) == 17 {
		return []string{
			"intent_id", "kind", "project_id", "source_file_id",
			"object_id", "object_generation", "storage_key",
			"quarantine_key", "expected_sha256", "expected_size",
			"authorization_kind", "authorization_id", "storage_epoch",
			"status", "execution_fence", "lease_token", "lease_expires_at",
		}
	}
	return []string{
		"intent_id", "status", "object_state", "outbox_status",
		"execution_fence", "result_code",
	}
}
func (rows *fakeRows) Close() error { return nil }
func (rows *fakeRows) Next(dest []driver.Value) error {
	if rows.index >= len(rows.rows) {
		return io.EOF
	}
	copy(dest, rows.rows[rows.index])
	rows.index++
	return nil
}
