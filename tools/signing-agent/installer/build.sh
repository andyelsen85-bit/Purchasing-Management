#!/usr/bin/env bash
# Build the Purchasing Signing Agent Windows installer.
#
# Runs on Linux (uses NSIS' makensis cross-compiler). Produces an
# Authenticode-signed
#   dist/SigningAgent-Setup-<version>.exe
#
# Required environment variables: none (sane defaults).
# Optional environment variables:
#   VERSION             installer version string             (default: 0.2.0)
#   NODE_VERSION        Node.js LTS to bundle                (default: 20.18.1)
#   NSSM_VERSION        NSSM release to bundle               (default: 2.24)
#   NODE_SHA256         expected SHA-256 of node-*-win-x64.zip
#   NSSM_SHA256         expected SHA-256 of nssm-*.zip
#   SIGN_PFX            path to a real Authenticode PFX (production)
#   SIGN_PFX_PASS       password for SIGN_PFX
#   SIGN_TIMESTAMP_URL  RFC3161 timestamp URL                (default: Sectigo)
#   SIGN_PRODUCT_NAME   embedded "name" attribute            (default: derived)
#   SIGN_PRODUCT_URL    embedded "more info" URL             (default: empty)
#   ALLOW_UNSIGNED=1    skip signing entirely (last resort; not recommended)
#
# When SIGN_PFX is unset and ALLOW_UNSIGNED is unset, build.sh generates a
# self-signed *test* code-signing PFX in build-cache/ and signs the EXE with
# it. The resulting installer is Authenticode-signed but the publisher is
# untrusted by Windows — production releases MUST set SIGN_PFX to a real
# code-signing certificate so SmartScreen / AppLocker accept it.
#
# Tools required on PATH:
#   makensis, npm, curl, unzip, openssl, osslsigncode

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT="$(cd "$ROOT/.." && pwd)"
PAYLOAD="$ROOT/payload"
CACHE="$ROOT/build-cache"
DIST="$ROOT/dist"

VERSION="${VERSION:-0.2.0}"

NODE_VERSION="${NODE_VERSION:-20.18.1}"
NODE_ZIP="node-v${NODE_VERSION}-win-x64.zip"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}"
NODE_SHA256="${NODE_SHA256:-}"

NSSM_VERSION="${NSSM_VERSION:-2.24}"
NSSM_ZIP="nssm-${NSSM_VERSION}.zip"
NSSM_URL="https://nssm.cc/release/${NSSM_ZIP}"
NSSM_SHA256="${NSSM_SHA256:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required tool '$1' not found on PATH" >&2
    exit 1
  }
}

require makensis
require npm
require curl
require unzip

if [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  require osslsigncode
  if [ -z "${SIGN_PFX:-}" ]; then
    require openssl
  fi
fi

mkdir -p "$CACHE" "$DIST"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/node" "$PAYLOAD/bin"

echo "==> Staging agent source"
for f in index.js package.json config.example.json install-service.ps1 uninstall-service.ps1; do
  cp "$AGENT/$f" "$PAYLOAD/$f"
done

echo "==> Staging installer scripts"
for f in setup-service.ps1 unsetup-service.ps1 LICENSE.txt README.txt; do
  cp "$ROOT/$f" "$PAYLOAD/$f"
done

echo "==> Installing production node_modules in payload"
( cd "$PAYLOAD" && npm install --omit=dev --no-audit --no-fund --silent --no-package-lock )

# Drop dev-only artefacts that npm sometimes drops in.
rm -f "$PAYLOAD/package-lock.json"

fetch_with_cache() {
  local url="$1" dest="$2" expected_sha="$3"
  if [ ! -f "$dest" ]; then
    echo "  fetching $url"
    curl -fsSL --retry 3 --connect-timeout 15 -o "$dest.tmp" "$url"
    mv "$dest.tmp" "$dest"
  else
    echo "  cached: $dest"
  fi
  if [ -n "$expected_sha" ]; then
    echo "$expected_sha  $dest" | sha256sum -c -
  fi
}

echo "==> Bundling Node.js v${NODE_VERSION} (Windows x64)"
fetch_with_cache "$NODE_URL" "$CACHE/$NODE_ZIP" "$NODE_SHA256"
unzip -joq "$CACHE/$NODE_ZIP" "*/node.exe" -d "$PAYLOAD/node"

echo "==> Bundling NSSM v${NSSM_VERSION}"
fetch_with_cache "$NSSM_URL" "$CACHE/$NSSM_ZIP" "$NSSM_SHA256"
unzip -joq "$CACHE/$NSSM_ZIP" "nssm-${NSSM_VERSION}/win64/nssm.exe" -d "$PAYLOAD/bin"

echo "==> Compiling installer"
( cd "$ROOT" && makensis -V2 -DVERSION="$VERSION" installer.nsi )

OUT="$DIST/SigningAgent-Setup-${VERSION}.exe"
echo "==> Built: $OUT"
ls -lh "$OUT"

if [ "${ALLOW_UNSIGNED:-0}" = "1" ]; then
  echo "==> ALLOW_UNSIGNED=1 — skipping Authenticode signing."
  echo "==> Done (UNSIGNED build)."
  exit 0
fi

# Pick a signing PFX. SIGN_PFX wins; otherwise generate a self-signed test
# certificate cached in build-cache/ so iterative builds don't regenerate.
TEST_PFX="$CACHE/test-codesign.pfx"
TEST_PASS="purchasing-signing-agent-test"
if [ -z "${SIGN_PFX:-}" ]; then
  if [ ! -f "$TEST_PFX" ]; then
    echo "==> SIGN_PFX not set — generating a self-signed test code-signing PFX"
    echo "    (production builds MUST set SIGN_PFX to a real Authenticode cert)"
    TEST_KEY="$CACHE/test-codesign.key"
    TEST_CRT="$CACHE/test-codesign.crt"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$TEST_KEY" \
      -out    "$TEST_CRT" \
      -days   1825 \
      -subj   "/CN=Purchasing Management (Test Build, NOT FOR PRODUCTION)" \
      -addext "keyUsage=digitalSignature" \
      -addext "extendedKeyUsage=codeSigning" \
      2>/dev/null
    openssl pkcs12 -export \
      -inkey "$TEST_KEY" \
      -in    "$TEST_CRT" \
      -out   "$TEST_PFX" \
      -name  "Purchasing Management Test Build" \
      -password "pass:$TEST_PASS"
    rm -f "$TEST_KEY" "$TEST_CRT"
  else
    echo "==> Reusing cached test code-signing PFX: $TEST_PFX"
  fi
  SIGN_PFX="$TEST_PFX"
  SIGN_PFX_PASS="$TEST_PASS"
  TEST_BUILD=1
else
  : "${SIGN_PFX_PASS:?SIGN_PFX_PASS is required when SIGN_PFX is set}"
  TEST_BUILD=0
fi

TS_URL="${SIGN_TIMESTAMP_URL:-http://timestamp.sectigo.com}"
PROD_NAME="${SIGN_PRODUCT_NAME:-Purchasing Signing Agent ${VERSION}}"

echo "==> Authenticode signing $OUT"
SIGN_ARGS=(
  -pkcs12 "$SIGN_PFX"
  -pass   "$SIGN_PFX_PASS"
  -h sha256
  -t "$TS_URL"
  -n "$PROD_NAME"
)
if [ -n "${SIGN_PRODUCT_URL:-}" ]; then
  SIGN_ARGS+=(-i "$SIGN_PRODUCT_URL")
fi
SIGN_ARGS+=(-in "$OUT" -out "$OUT.signed")
osslsigncode sign "${SIGN_ARGS[@]}"
mv "$OUT.signed" "$OUT"

echo "==> Verifying signature"
osslsigncode verify "$OUT" || true

if [ "$TEST_BUILD" = "1" ]; then
  echo
  echo "WARNING: this installer is signed with a self-signed test certificate."
  echo "         SmartScreen and AppLocker will reject it on production hosts."
  echo "         Set SIGN_PFX / SIGN_PFX_PASS for a real release build."
fi

echo "==> Done: $OUT"
