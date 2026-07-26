#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="${0##*/}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME}

Read-only storage-authority readiness check. This script never changes the
database, filesystem ownership/modes, Docker services, or PM2 processes.
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 78
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "REQUIRED_COMMAND_MISSING:$1"
}

canonical_root() {
  local root="$1"
  [[ "$root" == /* ]] || fail "STORAGE_ROOT_NOT_ABSOLUTE"
  [[ "$root" != "/" && "$root" != *"/../"* && "$root" != *"/./"* ]] ||
    fail "STORAGE_ROOT_NOT_NORMALIZED"
  printf '%s\n' "${root%/}"
}

directory_contract() {
  local root="$1"
  local expected_owner="$2"
  local expected_group="$3"
  local expected_mode="$4"
  local actual=""

  [[ -d "$root" && ! -L "$root" ]] || fail "STORAGE_ROOT_UNPROVEN:$root"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    actual="$(stat -f '%Su:%Sg:%Lp' "$root")"
  else
    actual="$(stat -c '%U:%G:%a' "$root")"
  fi
  [[ "$actual" == "${expected_owner}:${expected_group}:${expected_mode}" ]] ||
    fail "STORAGE_ROOT_OWNER_MODE_UNPROVEN:$root"
}

mysql_scalar() {
  local sql="$1"
  local password="${STORAGE_PREFLIGHT_DATABASE_PASSWORD:-}"
  local -a args=(
    --batch
    --skip-column-names
    --protocol=TCP
    --host="${STORAGE_BROKER_DATABASE_HOST:-127.0.0.1}"
    --port="${STORAGE_BROKER_DATABASE_PORT:-3306}"
    --user="${STORAGE_PREFLIGHT_DATABASE_USER:-}"
    "${STORAGE_BROKER_DATABASE_NAME:-textweaver}"
    --execute="$sql"
  )
  MYSQL_PWD="$password" mysql "${args[@]}"
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi
  [[ $# -eq 0 ]] || fail "UNKNOWN_ARGUMENT"

  [[ "${STORAGE_AUTHORITY_MODE:-legacy}" == "broker" ]] ||
    fail "STORAGE_AUTHORITY_MODE_NOT_BROKER"
  [[ "${STORAGE_BROKER_CONTRACT:-storage-broker.v1}" == "storage-broker.v1" ]] ||
    fail "STORAGE_BROKER_CONTRACT_MISMATCH"

  local protected_root
  local quarantine_root
  protected_root="$(canonical_root "${STORAGE_PROTECTED_ROOT:-}")"
  quarantine_root="$(canonical_root "${STORAGE_QUARANTINE_ROOT:-}")"
  [[ "$protected_root" != "$quarantine_root" ]] ||
    fail "STORAGE_ROOTS_MUST_BE_DISTINCT"

  local api_user="${STORAGE_API_OS_USER:-_twapi}"
  local worker_user="${STORAGE_WORKER_OS_USER:-_twworker}"
  local broker_user="${STORAGE_BROKER_OS_USER:-_twfs}"
  [[ "$api_user" != "$worker_user" &&
    "$api_user" != "$broker_user" &&
    "$worker_user" != "$broker_user" ]] ||
    fail "STORAGE_RUNTIME_IDENTITIES_NOT_DISTINCT"

  require_command docker
  require_command mysql
  require_command node
  require_command stat
  docker compose -f "${REPO_ROOT}/docker-compose.yml" config --quiet ||
    fail "DOCKER_COMPOSE_CONFIG_INVALID"
  if grep -F -- "${protected_root}:" "${REPO_ROOT}/docker-compose.yml" \
    >/dev/null 2>&1; then
    fail "PROTECTED_ROOT_APPLICATION_MOUNT_PRESENT"
  fi

  directory_contract \
    "$protected_root" \
    "${STORAGE_PROTECTED_OWNER:-_twfs}" \
    "${STORAGE_PROTECTED_GROUP:-_twread}" \
    "${STORAGE_PROTECTED_ROOT_MODE:-710}"
  directory_contract \
    "$quarantine_root" \
    "${STORAGE_QUARANTINE_OWNER:-_twapi}" \
    "${STORAGE_QUARANTINE_GROUP:-_twingest}" \
    "${STORAGE_QUARANTINE_ROOT_MODE:-2730}"

  local database="${STORAGE_BROKER_DATABASE_NAME:-textweaver}"
  [[ "$database" =~ ^[A-Za-z0-9_]+$ ]] ||
    fail "STORAGE_DATABASE_NAME_INVALID"
  [[ -n "${STORAGE_PREFLIGHT_DATABASE_USER:-}" &&
    -n "${STORAGE_PREFLIGHT_DATABASE_PASSWORD:-}" ]] ||
    fail "STORAGE_PREFLIGHT_DATABASE_CREDENTIALS_MISSING"

  local schema_contract
  schema_contract="$(mysql_scalar "
    SELECT CONCAT(
      (SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME IN
            ('storage_control','storage_objects','storage_operation_intents')),
      '|',
      (SELECT COUNT(*) FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='PROCEDURE'
          AND ROUTINE_NAME IN
            ('sp_storage_request_promote_v1',
             'sp_storage_request_delete_quarantine_v1',
             'sp_storage_request_delete_blob_v1',
             'sp_storage_request_abort_promotion_v1',
             'sp_storage_claim_v1','sp_storage_complete_v1')),
      '|',
      (SELECT COUNT(*) FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='v_storage_intent_execution_v1'),
      '|',
      (SELECT COUNT(*) FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA=DATABASE()
          AND TRIGGER_NAME='trg_storage_operation_intents_terminal_bu'),
      '|',
      (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'
          AND CONSTRAINT_NAME IN
            ('chk_storage_control_singleton',
             'chk_storage_control_contract',
             'chk_storage_objects_state',
             'chk_storage_operation_intents_kind',
             'chk_storage_operation_intents_status',
             'chk_storage_operation_intents_authorization',
             'chk_storage_operation_intents_shape',
             'chk_source_files_tombstone',
             'chk_file_upload_outbox_storage_intent')),
      '|',
      (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE()
          AND CONSTRAINT_NAME IN
            ('storage_objects_project_fkey',
             'storage_objects_project_file_fkey',
             'storage_operation_intents_project_fkey',
             'storage_operation_intents_storage_epoch_fkey',
             'storage_operation_intents_object_fkey',
             'source_files_deleted_by_fkey',
             'file_upload_outbox_storage_intent_fkey'))
    )")" || fail "STORAGE_SCHEMA_INSPECTION_FAILED"
  [[ "$schema_contract" == "3|6|1|1|9|7" ]] ||
    fail "STORAGE_SCHEMA_CONTRACT_UNPROVEN"

  local control_contract
  control_contract="$(mysql_scalar "
    SELECT CONCAT(
      COUNT(*),'|',
      SUM(broker_contract_version='storage-broker.v1'
          AND CHAR_LENGTH(active_epoch)=36))
    FROM storage_control")" || fail "STORAGE_CONTROL_INSPECTION_FAILED"
  [[ "$control_contract" == "0|NULL" || "$control_contract" == "1|1" ]] ||
    fail "STORAGE_CONTROL_CONTRACT_UNPROVEN"

  local pending
  pending="$(mysql_scalar "
    SELECT
      (SELECT COUNT(*) FROM source_files
        WHERE parse_status IN ('pending','parsing'))
      +(SELECT COUNT(*) FROM file_upload_outbox
        WHERE status<>'published')
      +(SELECT COUNT(*) FROM file_move_intents
        WHERE status IN ('ACTIVE','UNCERTAIN'))
      +(SELECT COUNT(*) FROM file_cleanup_records
        WHERE status='pending')")" || fail "STORAGE_QUEUE_INSPECTION_FAILED"
  [[ "$pending" == "0" ]] || fail "STORAGE_QUEUES_NOT_DRAINED"

  local invalid_sources
  invalid_sources="$(mysql_scalar "
    SELECT COUNT(*) FROM source_files
     WHERE checksum_sha256 IS NULL OR file_size IS NULL OR file_size<0")" ||
    fail "SOURCE_FILE_INSPECTION_FAILED"
  [[ "$invalid_sources" == "0" ]] || fail "SOURCE_FILE_PROOF_INCOMPLETE"

  [[ -z "$(find "$quarantine_root" -mindepth 1 -print -quit)" ]] ||
    fail "QUARANTINE_NOT_EMPTY"

  printf '%s\n' "STORAGE_AUTHORITY_PREFLIGHT_OK"
}

main "$@"
