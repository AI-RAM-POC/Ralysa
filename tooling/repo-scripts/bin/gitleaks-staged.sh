#!/bin/sh
# gitleaks-staged.sh: scans the staged changes for secrets before a commit exists (F-001 design
# §6.2.4; AC-2; SEC-F001-07). Run by .githooks/pre-commit; enable that with `pnpm hooks:install`.
#
# - The binary is re-hashed against tool-hashes.txt first (install-tool.sh --verify), so a
#   missing, stale or tampered copy fails closed (SEC-F001-20).
# - The repo config is passed explicitly, inline `gitleaks:allow` comments are ignored, and
#   findings are printed redacted (design §6.2.2).
# - Exit 0 is a pass, 1 is findings, and any other gitleaks exit code is a scanner error: both
#   block the commit.
set -eu

die() {
  echo "gitleaks-staged: $*" >&2
  exit 1
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../../.." && pwd)
config="$repo_root/.gitleaks.toml"

# --verify prints only the binary's path on stdout, and fails if it is missing or differs.
binary=$(sh "$script_dir/install-tool.sh" gitleaks --verify 2>/dev/null) ||
  die "gitleaks is missing or doesn't match tool-hashes.txt; run \`pnpm tools:install\` (the commit is blocked until then)"
[ -x "$binary" ] || die "gitleaks is missing; run \`pnpm tools:install\`"
[ -f "$config" ] || die "$config is missing"

# gitleaks reads <target>/.gitleaksignore whatever --gitleaks-ignore-path says, and that file
# would be an allow-list outside the config.
top=$(git rev-parse --show-toplevel)
[ ! -e "$top/.gitleaksignore" ] || die "$top/.gitleaksignore exists; remove it (the configs are the only allow-list)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir "$work/empty"

status=0
(
  cd "$top"
  GITLEAKS_CONFIG='' GITLEAKS_CONFIG_TOML='' "$binary" git --pre-commit --staged \
    --config "$config" --redact --ignore-gitleaks-allow --exit-code 1 \
    --report-format json --report-path "$work/report.json" \
    --gitleaks-ignore-path "$work/empty" --no-banner --log-level error --verbose .
) || status=$?

case $status in
  0) exit 0 ;;
  1)
    echo "gitleaks-staged: secrets found in the staged changes (values redacted above); the commit is blocked." >&2
    echo "gitleaks-staged: remove them and commit again. If one was ever pushed, rotate it first: docs/engineering/repo-conventions.md, \"Rotation runbook\"." >&2
    exit 1
    ;;
  *) die "gitleaks failed with exit code $status (scanner error); the commit is blocked" ;;
esac
