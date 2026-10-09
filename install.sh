#!/bin/sh
# Installs kubectl-skyline from a GitHub release.
#   VERSION=v0.1.4   pin a release (default: latest)
#   INSTALL_DIR=...  where to put the binary (default: /usr/local/bin, else ~/.local/bin)
set -eu

# Wrapped in a function so a cut-off download cannot run half a script.
main() {
  repo=zdk/kubectl-skyline
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case $os in
    linux | darwin) ;;
    *) echo "unsupported OS: $os. On Windows, use krew or the release zip." >&2; exit 1 ;;
  esac
  case $arch in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  base=https://github.com/$repo/releases/latest/download
  [ -n "${VERSION:-}" ] && base=https://github.com/$repo/releases/download/$VERSION
  archive=kubectl-skyline_${os}_${arch}.tar.gz

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$archive" "$base/$archive"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"

  want=$(grep " $archive\$" "$tmp/checksums.txt" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
  else
    got=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
  fi
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "checksum mismatch for $archive" >&2
    exit 1
  fi

  tar -xzf "$tmp/$archive" -C "$tmp" kubectl-skyline

  dir=${INSTALL_DIR:-/usr/local/bin}
  # No sudo: fall back to a user directory when the default is not writable.
  if [ -z "${INSTALL_DIR:-}" ] && [ ! -w "$dir" ]; then
    dir=$HOME/.local/bin
  fi
  mkdir -p "$dir"
  install -m 755 "$tmp/kubectl-skyline" "$dir/kubectl-skyline"

  echo "Installed $("$dir/kubectl-skyline" --version) to $dir"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "Add $dir to your PATH." ;;
  esac
  echo "Run: kubectl skyline"
}

main "$@"
