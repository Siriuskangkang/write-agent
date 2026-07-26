#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="${0##*/}"

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME}

Fail-closed activation gate. This repository build deliberately cannot mutate
storage authority. A future Task 11.2 release must replace the final disabled
gate only after procedure-only authoring authority is independently proven.
EOF
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi
  [[ $# -eq 0 ]] || {
    printf '%s\n' "UNKNOWN_ARGUMENT" >&2
    return 78
  }
  if [[ "${AUTHORING_AUTHORITY_FLOOR:-}" != \
    "task11.2-procedure-only.v1" ]]; then
    printf '%s\n' "TASK11_2_AUTHORITY_FLOOR_UNPROVEN" >&2
    return 78
  fi
  if [[ "${CONFIRM_STORAGE_ACTIVATION:-}" != \
    "activate-storage-broker-v1" ]]; then
    printf '%s\n' "EXPLICIT_STORAGE_ACTIVATION_CONFIRMATION_REQUIRED" >&2
    return 78
  fi

  printf '%s\n' "STORAGE_AUTHORITY_ACTIVATION_DISABLED_CURRENT_BUILD" >&2
  return 78
}

main "$@"
