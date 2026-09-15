#!/bin/sh
# Container entrypoint. If runtime keys were not supplied through the
# environment, generate independent strong values and persist them in
# the state volume so they survive container restarts and rebuilds.
# Explicit environment values remain the supported option for multiple
# replicas or operator-managed secret stores.
set -eu

SESSION_SECRET_FILE="${SESSION_SECRET_FILE:-/app/state/session_secret}"
SETTINGS_KEY_FILE="${SETTINGS_ENCRYPTION_KEY_FILE:-/app/state/settings_encryption_key}"

if [ -z "${SESSION_SECRET:-}" ]; then
  if [ -s "$SESSION_SECRET_FILE" ]; then
    SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"
  else
    mkdir -p "$(dirname "$SESSION_SECRET_FILE")"
    # node is always present in this image; use crypto.randomBytes for
    # a cryptographically strong 64-char hex string.
    SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
    umask 077
    printf '%s' "$SESSION_SECRET" > "$SESSION_SECRET_FILE"
    echo "entrypoint: generated new SESSION_SECRET and stored it at $SESSION_SECRET_FILE" >&2
  fi
  export SESSION_SECRET
fi

if [ -z "${SETTINGS_ENCRYPTION_KEY:-}" ]; then
  if [ -s "$SETTINGS_KEY_FILE" ]; then
    SETTINGS_ENCRYPTION_KEY="$(cat "$SETTINGS_KEY_FILE")"
  else
    mkdir -p "$(dirname "$SETTINGS_KEY_FILE")"
    SETTINGS_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
    umask 077
    printf '%s' "$SETTINGS_ENCRYPTION_KEY" > "$SETTINGS_KEY_FILE"
    echo "entrypoint: generated new SETTINGS_ENCRYPTION_KEY and stored it at $SETTINGS_KEY_FILE" >&2
  fi
  export SETTINGS_ENCRYPTION_KEY
fi

# Apply the database schema. `drizzle-kit push` is idempotent — it
# diffs the live database against the schema definitions in /app/db/src
# and applies any missing tables/columns. On a fresh deployment this
# creates every table; on subsequent boots it's a no-op. We exit on
# failure so the container doesn't start serving against a half-migrated
# database.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "entrypoint: applying database schema (drizzle-kit push)…" >&2
  ( cd /app/db && node ./node_modules/drizzle-kit/bin.cjs push \
      --config ./drizzle.config.ts --force ) || {
    echo "entrypoint: drizzle-kit push failed" >&2
    exit 1
  }
fi

exec "$@"
