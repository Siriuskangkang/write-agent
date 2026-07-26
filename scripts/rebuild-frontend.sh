#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly FRONTEND_DIR="${REPO_ROOT}/frontend"
readonly PM2_APP_NAME="write-agent-web"

cd "${FRONTEND_DIR}"
npm run build
pm2 restart "${PM2_APP_NAME}" --update-env
