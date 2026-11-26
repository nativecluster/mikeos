#!/usr/bin/env bash
# Builds Mike's NativeCluster package into a stage folder outside the
# repository:
#
#   nativecluster/build/build.sh <stage folder>/MikeOSS
#
# The stage folder is named as the app (nc-app.json's name), MikeOSS: the
# Store takes a package whose one folder has the app's name.
#
# The stage holds, and nothing else (a package holds no link):
#   mike, nc-app.json, assets/icon.png   the program, its manifest and icon
#   LICENSE, NOTICE                      Mike's AGPL-3.0, and this build's commit and source
#   runtime/bin/node                     official Node 24, darwin-arm64, SHA-256 pinned
#   launcher/                            main.mjs, pglite-server.mjs, lib/, its node_modules
#                                        (PGlite, pglite-socket, pg), local/ (desktop/src/local's
#                                        schema step) and schema-version
#   backend/                             dist (no source maps), production node_modules without
#                                        the hosted models' SDKs, schema.sql, migrations
#   web/                                 the frontend's Next standalone build (NEXT_PUBLIC_MIKE_NC_APP=1),
#                                        its static files and public/, without sharp
#   stack/                               PostgREST and GoTrue (build/stage-stack.mjs)
#
# Environment:
#   STACK_BIN              upstream desktop/local-stack/bin (default ~/code/mikeos-upstream's)
#   MIKE_WORKFLOW_CATALOG  a bundled workflow catalog folder to use instead of downloading
#                          one (desktop/scripts/bundle-workflows.js, network at build time)
#   MIKE_NC_BUILD_CACHE    where Node's tarball is kept between builds
#   SKIP_FRONTEND=1        reuse frontend/.next from the last build (development only)
set -euo pipefail

NODE_VERSION=v24.22.3
NODE_SHA256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
# Packages the backend loads only for a hosted model's provider, which
# MIKE_INFERENCE_PROVIDER=nativecluster refuses (each is a dynamic import in
# backend/src/lib/llm/providers.ts): left out of the package.
HOSTED_MODEL_SDKS="@ai-sdk/amazon-bedrock @ai-sdk/anthropic @ai-sdk/azure @ai-sdk/google @ai-sdk/google-vertex @ai-sdk/mistral @ai-sdk/openai @ai-sdk/xai @openrouter/ai-sdk-provider"

REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?usage: nativecluster/build/build.sh <stage folder outside the repository, named MikeOSS>}
# NativeCluster's Store publishes a package whose one folder is named as the
# app (its publish-app.sh checks it), so the stage folder has the app's name.
APP_NAME=$(sed -n 's/^  "name": "\(.*\)",$/\1/p' "$REPO/nativecluster/nc-app.json" | head -1)
[ -n "$APP_NAME" ] || { echo "build.sh: no name in nativecluster/nc-app.json" >&2; exit 2; }
[ "$(basename "$OUT")" = "$APP_NAME" ] || {
  echo "build.sh: name the stage folder $APP_NAME, not $(basename "$OUT") (for example $(dirname "$OUT")/$APP_NAME): NativeCluster's Store takes a package whose one folder is named as the app" >&2
  exit 2
}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$(cd "$REPO" && pwd -P)"/*) echo "build.sh: the stage folder must be outside the repository" >&2; exit 2 ;; esac
if [ -n "$(ls -A "$OUT")" ] && ! { [ -f "$OUT/launcher/main.mjs" ] && grep -q '"id": "mikeos"' "$OUT/nc-app.json" 2>/dev/null; }; then
  echo "build.sh: $OUT is not empty and is not a stage of Mike's" >&2
  exit 2
fi
STACK_BIN=${STACK_BIN:-$HOME/code/mikeos-upstream/desktop/local-stack/bin}
CACHE=${MIKE_NC_BUILD_CACHE:-$HOME/Library/Caches/mike-nc-build}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mike-nc-build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
t0=$(date +%s)
say() { printf '==> %s (%ss)\n' "$1" "$(( $(date +%s) - t0 ))"; }

find "$OUT" -mindepth 1 -delete

say "Node $NODE_VERSION"
mkdir -p "$CACHE"
TARBALL="$CACHE/node-$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$TARBALL" ] || ! echo "$NODE_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null 2>&1; then
  curl -fsSL -o "$TARBALL.part" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "$NODE_SHA256  $TARBALL" | shasum -a 256 -c -
tar -xzf "$TARBALL" -C "$WORK"
mkdir -p "$OUT/runtime/bin"
cp "$WORK/node-$NODE_VERSION-darwin-arm64/bin/node" "$OUT/runtime/bin/node"
cp "$WORK/node-$NODE_VERSION-darwin-arm64/LICENSE" "$OUT/runtime/LICENSE"
chmod 755 "$OUT/runtime/bin/node"

say "backend (tsc)"
(cd "$REPO/backend" && [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error)
(cd "$REPO/backend" && rm -rf dist && npx tsc)
if [ -n "${MIKE_WORKFLOW_CATALOG:-}" ]; then
  say "workflow catalog (from $MIKE_WORKFLOW_CATALOG)"
  rm -rf "$REPO/backend/dist/workflow-catalog"
  cp -R "$MIKE_WORKFLOW_CATALOG" "$REPO/backend/dist/workflow-catalog"
else
  say "workflow catalog (downloaded, installed offline at first start)"
  if (cd "$REPO" && node desktop/scripts/bundle-workflows.js); then
    rm -rf "$CACHE/workflow-catalog" && cp -R "$REPO/backend/dist/workflow-catalog" "$CACHE/workflow-catalog"
  elif [ -f "$CACHE/workflow-catalog/catalog.json" ]; then
    echo "build.sh: the download failed; using the catalog the last build kept" >&2
    cp -R "$CACHE/workflow-catalog" "$REPO/backend/dist/workflow-catalog"
  else
    exit 1
  fi
fi

say "backend (production modules)"
mkdir -p "$WORK/backend"
cp "$REPO/backend/package.json" "$REPO/backend/package-lock.json" "$WORK/backend/"
(cd "$WORK/backend" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
# shellcheck disable=SC2086
(cd "$WORK/backend" && npm uninstall --omit=dev --no-audit --no-fund --loglevel=error $HOSTED_MODEL_SDKS)
mkdir -p "$OUT/backend"
cp -RL "$WORK/backend/node_modules" "$OUT/backend/node_modules"
cp "$REPO/backend/package.json" "$OUT/backend/package.json"
(cd "$REPO/backend" && find dist -type f ! -name '*.map' ! -name '*.tsbuildinfo' -print0 | while IFS= read -r -d '' f; do mkdir -p "$OUT/backend/$(dirname "$f")"; cp "$f" "$OUT/backend/$f"; done)
cp "$REPO/backend/schema.sql" "$OUT/backend/schema.sql"
cp -R "$REPO/backend/migrations" "$OUT/backend/migrations"

if [ "${SKIP_FRONTEND:-}" != "1" ]; then
  say "frontend (Next standalone, NEXT_PUBLIC_MIKE_NC_APP=1)"
  (cd "$REPO/frontend" && [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error)
  (cd "$REPO/frontend" && rm -rf .next && \
    env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    NEXT_OUTPUT_STANDALONE=1 NEXT_PUBLIC_MIKE_NC_APP=1 \
    SENTRY_DISABLED=true NEXT_PUBLIC_SENTRY_DISABLED=true \
    SENTRY_AUTH_TOKEN= SENTRY_ORG= SENTRY_PROJECT= \
    NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=4096 \
    npm run build -- --webpack)
fi
say "frontend (staged)"
# Traced from the repository root: the server and its .next live under
# standalone/frontend, the hoisted node_modules beside it.
cp -RL "$REPO/frontend/.next/standalone" "$OUT/web"
cp -RL "$REPO/frontend/.next/static" "$OUT/web/frontend/.next/static"
[ -d "$REPO/frontend/public" ] && cp -RL "$REPO/frontend/public" "$OUT/web/frontend/public"
find "$OUT/web/frontend" -maxdepth 1 -name '.env*' -type f -delete
# Every image Mike shows is an SVG or unoptimized: no image optimizer, so no sharp.
rm -rf "$OUT/web/node_modules/sharp" "$OUT/web/node_modules/@img" "$OUT/web/frontend/node_modules/sharp" "$OUT/web/frontend/node_modules/@img"

say "launcher"
mkdir -p "$OUT/launcher/local" "$WORK/launcher"
cp "$REPO/nativecluster/launcher/main.mjs" "$REPO/nativecluster/launcher/pglite-server.mjs" "$REPO/nativecluster/launcher/package.json" "$OUT/launcher/"
cp -R "$REPO/nativecluster/launcher/lib" "$OUT/launcher/lib"
cp "$REPO/nativecluster/launcher/package.json" "$REPO/nativecluster/launcher/package-lock.json" "$WORK/launcher/"
(cd "$WORK/launcher" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
cp -RL "$WORK/launcher/node_modules" "$OUT/launcher/node_modules"
cp "$REPO/desktop/src/local/schema.js" "$REPO/desktop/src/local/sql.js" "$REPO/desktop/src/local/workflows.js" "$OUT/launcher/local/"

say "stack (PostgREST, GoTrue)"
node "$REPO/nativecluster/build/stage-stack.mjs" "$STACK_BIN" "$OUT"

say "manifest and program"
cp "$REPO/nativecluster/nc-app.json" "$REPO/nativecluster/mike" "$OUT/"
chmod 755 "$OUT/mike"
mkdir -p "$OUT/assets"
cp "$REPO/nativecluster/assets/icon.png" "$OUT/assets/icon.png"

# Mike's licence, and a notice saying this build is modified and where its
# exact source is (AGPL-3.0 §4, §5(a), §6): the commit it was built from,
# marked when the tree had uncommitted changes (sign.sh refuses such a build).
cp "$REPO/LICENSE" "$OUT/LICENSE"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/nativecluster/nc-app.json")
commit=$(git -C "$REPO" rev-parse HEAD)
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then commit="$commit, with uncommitted changes"; fi
sed -e "s|@VERSION@|$version|" -e "s|@DATE@|$(date -u +%Y-%m-%d)|" -e "s|@COMMIT@|$commit|" \
  "$REPO/nativecluster/NOTICE.in" > "$OUT/NOTICE"

# The schema version: what the schema step installs. A start whose version
# differs from the data folder's runs the step again (lib/stack.mjs).
(cd "$OUT" && { find stack/gotrue-migrations backend/migrations launcher/local -type f; echo backend/schema.sql; echo backend/dist/workflow-catalog/catalog.json; } \
  | LC_ALL=C sort | while read -r f; do printf '%s ' "$f"; shasum -a 256 < "$f"; done) \
  | shasum -a 256 | cut -d' ' -f1 > "$OUT/launcher/schema-version"

say "pruning"
find "$OUT" -name '*.map' -type f -delete
find "$OUT" -type d -name '.bin' -prune -exec rm -rf {} +
find "$OUT" -name '.package-lock.json' -type f -delete

say "checking"
links=$(find "$OUT" -type l | head -5)
if [ -n "$links" ]; then echo "build.sh: links left in the stage:" >&2; echo "$links" >&2; exit 1; fi
cmp <("$OUT/mike" manifest) "$OUT/nc-app.json"
size=$(du -sh "$OUT" | cut -f1)
files=$(find "$OUT" | wc -l | tr -d ' ')
say "built $OUT: $size in $files files and folders"
