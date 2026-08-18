#!/usr/bin/env bash
# Starts `wrangler dev` on the Node version pinned in .nvmrc.
#
# Editors and tooling that launch this project often inherit the machine's
# default Node rather than a shell that has already run `nvm use`. Wrangler
# requires >= 22, so this activates the pinned version first instead of failing
# with a version error.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || nvm install
fi

exec npx wrangler dev "$@"
