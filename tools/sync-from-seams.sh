#!/usr/bin/env bash
# FabMo Loom — sync the foundation code from the private seams workspace repo.
#
# Loom is a curated public snapshot of the ShopBot Labs "seams" repo. This
# script is how the snapshot is produced, kept public for transparency:
#
#   1. exports seams' committed HEAD (never its working tree — a dev session
#      may be mid-feature there)
#   2. prunes what is not distributed: .claude/, and every STEP fixture NOT
#      on the explicit allowlist (default-deny: new fixtures are often real
#      customer parts and must be green-lit individually)
#   3. scans the import for secrets
#   4. rsyncs the synced paths over this checkout
#   5. warns on package.json dependency drift and unwired test files
#   6. runs the public test suite — a red suite aborts before any commit
#   7. commits with the source SHA; pushing stays manual unless --push
#
# Usage:  tools/sync-from-seams.sh [--push]
# Env:    SEAMS_DIR (default /var/opt/apps/contributors/brian.o/seams)
#
# Workspace-only: does nothing useful outside the ShopBot Labs server.

set -euo pipefail

SEAMS="${SEAMS_DIR:-/var/opt/apps/contributors/brian.o/seams}"
LOOM="$(cd "$(dirname "$0")/.." && pwd)"
SYNC_PATHS=(ir strategies adapters intent vendor test)
FIXTURE_ALLOW=(test-part-v2.stp)
PUSH=no
[[ "${1:-}" == "--push" ]] && PUSH=yes

[[ -d "$SEAMS/.git" ]] || { echo "seams repo not found at $SEAMS (set SEAMS_DIR)"; exit 1; }
cd "$LOOM"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "loom checkout is not clean — commit or stash first"; exit 1
fi

SRC_SHA=$(git -C "$SEAMS" rev-parse --short HEAD)
SRC_SUBJECT=$(git -C "$SEAMS" log -1 --format=%s)
echo "syncing from seams $SRC_SHA: $SRC_SUBJECT"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$SEAMS" archive HEAD | tar -x -C "$TMP"

# --- prune: private harness config + default-deny STEP fixtures ---
rm -rf "$TMP/.claude"
shopt -s nullglob
for f in "$TMP"/test/fixtures/*; do
  base=$(basename "$f")
  keep=no
  for a in "${FIXTURE_ALLOW[@]}"; do [[ "$base" == "$a" ]] && keep=yes; done
  if [[ $keep == no ]]; then
    rm -f "$f"
    echo "  excluded fixture (not on allowlist): $base"
  fi
done

# --- secret scan on the pruned import ---
if grep -rInE 'sk-ant-[A-Za-z0-9_-]{8,}|BEGIN [A-Z ]*PRIVATE KEY' "$TMP"; then
  echo "ABORT: the lines above look like secrets"; exit 1
fi

# --- sync ---
for p in "${SYNC_PATHS[@]}"; do
  rsync -a --delete "$TMP/$p/" "$LOOM/$p/"
done

# --- drift warnings (manual reconciliation, never automated) ---
node - "$TMP/package.json" "$LOOM/package.json" <<'EOF'
const fs = require('fs');
const [seams, loom] = process.argv.slice(2).map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
for (const k of ['dependencies', 'devDependencies']) {
  const a = JSON.stringify(seams[k] ?? {}), b = JSON.stringify(loom[k] ?? {});
  if (a !== b) console.log(`  WARN ${k} drift — seams: ${a}\n                        loom:  ${b}`);
}
const wired = (loom.scripts.test + ' ' + (loom.scripts['test:workspace'] ?? ''));
for (const f of fs.readdirSync('test').filter(f => f.endsWith('-test.mjs')))
  if (!wired.includes(f)) console.log(`  WARN test/${f} is wired into neither test script`);
EOF

if [[ -z "$(git status --porcelain)" ]]; then
  echo "already in sync with seams $SRC_SHA"; exit 0
fi

# --- gate: the public suite must be green before anything is committed ---
echo "running public test suite..."
if ! npm test >/tmp/loom-sync-test.log 2>&1; then
  echo "ABORT: npm test FAILED (log: /tmp/loom-sync-test.log)"
  echo "working tree left as-is for inspection; reset with: git checkout -- ."
  exit 1
fi
node examples/first-job.mjs >/dev/null 2>&1 || {
  echo "ABORT: examples/first-job.mjs failed — quickstart would be broken"
  echo "working tree left as-is; reset with: git checkout -- ."
  exit 1
}

git add -A
git status --short
git commit -m "Sync from seams $SRC_SHA: $SRC_SUBJECT

Produced by tools/sync-from-seams.sh (fixtures allowlisted, secret-scanned,
public suite green).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
echo "committed."
if [[ $PUSH == yes ]]; then git push; echo "pushed."; else echo "review, then: git push"; fi
