#!/bin/sh
# Runs the ui-lab Playwright harness in the SAME pinned image as the CI `ui-e2e` job (F-001
# design §8.2, §5.4), so browsers, fonts and rendering match CI:
#   pnpm --filter @ralysa/ui-lab e2e:container [playwright args]      e.g. -- --project=chromium
#
# The image digest below must equal the one in .github/workflows/ci.yml; check-ci-invariants
# (ci/playwright-digest) fails the build when they differ. Bump both together.
#
# How it runs: the host lists the working-tree files git knows about (tracked and untracked, not
# ignored), and the container copies exactly those into its own /work, installs with the frozen
# lockfile, builds ui-lab and web, and runs Playwright. Nothing from the host's node_modules or
# dist/ is used (they hold macOS binaries). The pnpm store lives in a named Docker volume so
# later runs are quicker. The HTML report is copied back to apps/ui-lab/playwright-report/.
#
# E2E_WRITE_SNAPSHOTS=1 also copies apps/ui-lab/e2e/__screenshots__/ back (e2e-update.sh sets it).
# E2E_PLATFORM (default linux/amd64, what CI runs) can be set to linux/arm64 for a quicker local
# run on Apple silicon; snapshots are then refused, because baselines must come from CI's platform.
set -eu

PLAYWRIGHT_IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
PLATFORM="${E2E_PLATFORM:-linux/amd64}"
WRITE_SNAPSHOTS="${E2E_WRITE_SNAPSHOTS:-0}"

if [ "$WRITE_SNAPSHOTS" = 1 ] && [ "$PLATFORM" != linux/amd64 ]; then
  echo "e2e-container: snapshots can only be written on linux/amd64 (CI's platform), not $PLATFORM" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || {
  echo 'e2e-container: docker is required' >&2
  exit 2
}

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
lab="$repo/apps/ui-lab"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT INT TERM

# NUL-separated, so any file name survives; deleted-but-tracked files are skipped by tar below.
git -C "$repo" ls-files -z --cached --others --exclude-standard >"$scratch/files"
mkdir -p "$scratch/out"

docker run --rm --platform "$PLATFORM" --ipc=host --init \
  -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e TURBO_TELEMETRY_DISABLED=1 -e DO_NOT_TRACK=1 \
  -e WRITE_SNAPSHOTS="$WRITE_SNAPSHOTS" \
  -v "$repo:/src:ro" \
  -v "$scratch/files:/files:ro" \
  -v "$scratch/out:/out" \
  -v ralysa-e2e-pnpm-store:/pnpm-store \
  "$PLAYWRIGHT_IMAGE" \
  sh -eu -c '
    mkdir -p /work
    tar -C /src --null --ignore-failed-read -T /files -cf - 2>/dev/null | tar -C /work -xf -
    cd /work
    node tooling/repo-scripts/src/pre-install-gate.ts
    corepack enable
    pnpm config set store-dir /pnpm-store >/dev/null
    pnpm install --frozen-lockfile --reporter=append-only >/dev/null
    pnpm exec turbo run build --filter=@ralysa/ui-lab... --filter=@ralysa/web --output-logs=errors-only
    status=0
    (cd apps/ui-lab && pnpm exec playwright test "$@") || status=$?
    cp -R apps/ui-lab/playwright-report /out/ 2>/dev/null || true
    if [ "$WRITE_SNAPSHOTS" = 1 ]; then cp -R apps/ui-lab/e2e/__screenshots__ /out/ 2>/dev/null || true; fi
    exit "$status"
  ' e2e-container "$@" || status=$?

rm -rf "$lab/playwright-report"
if [ -d "$scratch/out/playwright-report" ]; then cp -R "$scratch/out/playwright-report" "$lab/"; fi
if [ "$WRITE_SNAPSHOTS" = 1 ] && [ -d "$scratch/out/__screenshots__" ]; then
  rm -rf "$lab/e2e/__screenshots__"
  cp -R "$scratch/out/__screenshots__" "$lab/e2e/"
  echo "e2e-container: baselines written to apps/ui-lab/e2e/__screenshots__/; review the image diff before committing."
fi
exit "${status:-0}"
