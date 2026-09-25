#!/bin/sh
# Rewrites the visual and shaping baselines (F-001 design §5.4; AC-9, T14):
#   pnpm --filter @ralysa/ui-lab e2e:update                   visual and shaping specs
#   pnpm --filter @ralysa/ui-lab e2e:update -- e2e/visual.spec.ts --grep "ar dark"
#
# It runs e2e-container.sh, so it uses the SAME pinned Playwright image digest as the CI ui-e2e
# job (check-ci-invariants, ci/playwright-digest) on CI's platform (linux/amd64; emulated on
# Apple silicon, slower but identical output). Only changed or missing baselines are written.
# Commit the PNGs; the reviewer approves the image diff in the PR. CI never writes baselines,
# because that would need contents: write on PR runs (RF-2).
set -eu
here="$(dirname "$0")"
if [ "$#" -eq 0 ]; then set -- e2e/visual.spec.ts e2e/shaping.spec.ts; fi
E2E_PLATFORM=linux/amd64 E2E_WRITE_SNAPSHOTS=1 exec sh "$here/e2e-container.sh" --update-snapshots=changed "$@"
