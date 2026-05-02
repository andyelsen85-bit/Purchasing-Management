#!/bin/sh
# Container entrypoint. If SESSION_SECRET wasn't supplied via the
# environment (e.g. compose .env, k8s secret), generate a strong one
# and persist it inside the state volume so it survives container
# restarts and rebuilds. Operators who want to manage the secret
# themselves can simply set SESSION_SECRET in their environment and
# this block is skipped.
set -eu

SECRET_FILE="${SESSION_SECRET_FILE:-/app/state/session_secret}"

if [ -z "${SESSION_SECRET:-}" ]; then
  if [ -s "$SECRET_FILE" ]; then
    SESSION_SECRET="$(cat "$SECRET_FILE")"
  else
    mkdir -p "$(dirname "$SECRET_FILE")"
    # node is always present in this image; use crypto.randomBytes for
    # a cryptographically strong 64-char hex string.
    SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
    umask 077
    printf '%s' "$SESSION_SECRET" > "$SECRET_FILE"
    echo "entrypoint: generated new SESSION_SECRET and stored it at $SECRET_FILE" >&2
  fi
  export SESSION_SECRET
fi

exec "$@"
