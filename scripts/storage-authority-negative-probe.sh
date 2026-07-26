#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="${0##*/}"

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME}

Explicitly gated destructive-capability probe. It succeeds only when mkdir,
write, chmod, rename, unlink, and recursive delete are all denied for both the
configured API and worker identities. It never creates users or changes owner.

Required:
  CONFIRM_STORAGE_NEGATIVE_PROBE=probe-storage-authority-v1
  STORAGE_NEGATIVE_PROBE_FILE=<existing protected regular file>
  STORAGE_NEGATIVE_PROBE_DIR=<existing protected directory>
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 78
}

run_as_identity() {
  local identity="$1"
  shift
  if command -v sudo >/dev/null 2>&1; then
    sudo -n -u "$identity" -- "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$identity" -- "$@"
  else
    fail "IDENTITY_SWITCH_COMMAND_MISSING"
  fi
}

expect_denied() {
  local identity="$1"
  local operation="$2"
  shift 2
  if run_as_identity "$identity" "$@" >/dev/null 2>&1; then
    fail "NEGATIVE_PROBE_UNEXPECTEDLY_ALLOWED:${identity}:${operation}"
  fi
}

inside_root() {
  local candidate="$1"
  local root="$2"
  [[ "$candidate" == "${root}/"* ]]
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi
  [[ $# -eq 0 ]] || fail "UNKNOWN_ARGUMENT"
  [[ "${CONFIRM_STORAGE_NEGATIVE_PROBE:-}" == \
    "probe-storage-authority-v1" ]] ||
    fail "EXPLICIT_STORAGE_NEGATIVE_PROBE_CONFIRMATION_REQUIRED"

  local root="${STORAGE_PROTECTED_ROOT:-}"
  local fixture_file="${STORAGE_NEGATIVE_PROBE_FILE:-}"
  local fixture_dir="${STORAGE_NEGATIVE_PROBE_DIR:-}"
  [[ "$root" == /* && "$root" != "/" && -d "$root" && ! -L "$root" ]] ||
    fail "STORAGE_PROTECTED_ROOT_UNPROVEN"
  [[ -f "$fixture_file" && ! -L "$fixture_file" ]] ||
    fail "NEGATIVE_PROBE_FILE_UNPROVEN"
  [[ -d "$fixture_dir" && ! -L "$fixture_dir" ]] ||
    fail "NEGATIVE_PROBE_DIRECTORY_UNPROVEN"
  inside_root "$fixture_file" "$root" ||
    fail "NEGATIVE_PROBE_FILE_OUTSIDE_ROOT"
  inside_root "$fixture_dir" "$root" ||
    fail "NEGATIVE_PROBE_DIRECTORY_OUTSIDE_ROOT"

  local api_user="${STORAGE_API_OS_USER:-_twapi}"
  local worker_user="${STORAGE_WORKER_OS_USER:-_twworker}"
  local broker_user="${STORAGE_BROKER_OS_USER:-_twfs}"
  [[ "$api_user" != "$worker_user" &&
    "$api_user" != "$broker_user" &&
    "$worker_user" != "$broker_user" ]] ||
    fail "STORAGE_RUNTIME_IDENTITIES_NOT_DISTINCT"

  local identity=""
  local token="authority-probe-$$"
  for identity in "$api_user" "$worker_user"; do
    expect_denied "$identity" mkdir mkdir "${root}/${token}.dir"
    # shellcheck disable=SC2016  # $1 is expanded by the child shell.
    expect_denied \
      "$identity" write sh -c 'umask 077; : > "$1"' _ "${root}/${token}.file"
    expect_denied \
      "$identity" chmod chmod \
      "${STORAGE_PROTECTED_ROOT_MODE:-710}" "$root"
    expect_denied \
      "$identity" rename mv "$fixture_file" "${fixture_file}.${token}.moved"
    expect_denied "$identity" unlink rm -f "$fixture_file"
    expect_denied "$identity" recursive-delete rm -rf "$fixture_dir"
  done

  printf '%s\n' "STORAGE_AUTHORITY_NEGATIVE_PROBE_OK"
}

main "$@"
