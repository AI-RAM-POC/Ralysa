#!/bin/sh
# install-tool.sh: downloads a hash-pinned tool binary (F-001 design §6.2.1; SEC-F001-20).
#
#   install-tool.sh <tool>            install into <repo>/.tools/<tool>/<version>/<tool>, or verify
#                                     an existing copy (a restored cache or an earlier install)
#   install-tool.sh <tool> --verify   verify only; fail if the binary is missing or differs
#
# The archive and the extracted binary are both checked against tool-hashes.txt, which sits next
# to this script and is committed. A hash is never read from a downloaded checksums file. Any
# mismatch fails closed: nothing is installed, and an existing binary that doesn't match is
# reported, not replaced. On success the last line of output is the binary's path.
set -eu

die() {
  echo "install-tool: $*" >&2
  exit 1
}

[ $# -ge 1 ] || die "usage: install-tool.sh <tool> [--verify]"
tool=$1
mode=${2:-install}
[ "$mode" = install ] || [ "$mode" = --verify ] || die "unknown option: $mode"

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../../.." && pwd)
hash_file="$script_dir/tool-hashes.txt"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64) platform=linux_x64 ;;
  Darwin/arm64) platform=darwin_arm64 ;;
  Darwin/x86_64) platform=darwin_x64 ;;
  *) die "unsupported platform $(uname -s)/$(uname -m); tool-hashes.txt covers linux_x64, darwin_arm64 and darwin_x64" ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "neither sha256sum nor shasum is available"
  fi
}

# Exactly one line for <tool> <platform>; comments and blank lines are skipped.
entry=$(awk -v t="$tool" -v p="$platform" '$1 == t && $3 == p' "$hash_file")
[ -n "$entry" ] || die "no entry for $tool on $platform in tool-hashes.txt"
[ "$(printf '%s\n' "$entry" | wc -l | tr -d ' ')" = 1 ] || die "more than one entry for $tool on $platform in tool-hashes.txt"
set -- $entry
version=$2
url=$4
archive_sha=$5
binary_sha=$6
case "$archive_sha$binary_sha" in
  *[!0-9a-f]*) die "malformed hash for $tool on $platform in tool-hashes.txt" ;;
esac
[ ${#archive_sha} = 64 ] && [ ${#binary_sha} = 64 ] || die "malformed hash for $tool on $platform in tool-hashes.txt"

dest_dir="$repo_root/.tools/$tool/$version"
dest="$dest_dir/$tool"

if [ -e "$dest" ]; then
  actual=$(sha256 "$dest")
  if [ "$actual" != "$binary_sha" ]; then
    die "$dest does not match tool-hashes.txt (expected $binary_sha, got $actual). It may be a tampered or stale cache; delete $repo_root/.tools/$tool and run install-tool.sh $tool again."
  fi
  echo "install-tool: $tool $version verified" >&2
  echo "$dest"
  exit 0
fi
[ "$mode" = install ] || die "$dest is missing; run install-tool.sh $tool (pnpm tools:install)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
echo "install-tool: downloading $tool $version for $platform" >&2
curl --fail --silent --show-error --location --proto '=https,file' --output "$work/archive.tar.gz" "$url" || die "download failed: $url"
actual=$(sha256 "$work/archive.tar.gz")
[ "$actual" = "$archive_sha" ] || die "archive hash mismatch for $url (expected $archive_sha, got $actual); nothing installed"

mkdir "$work/x"
tar -xzf "$work/archive.tar.gz" -C "$work/x" "$tool" || die "archive has no $tool binary"
actual=$(sha256 "$work/x/$tool")
[ "$actual" = "$binary_sha" ] || die "binary hash mismatch for $tool (expected $binary_sha, got $actual); nothing installed"

mkdir -p "$dest_dir"
chmod 0755 "$work/x/$tool"
mv "$work/x/$tool" "$dest.partial"
mv "$dest.partial" "$dest"
echo "install-tool: installed $tool $version" >&2
echo "$dest"
