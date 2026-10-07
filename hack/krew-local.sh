#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null | sed 's/^v//')}"
rm -rf dist && mkdir -p dist
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
manifest=$(cat plugins/skyline.yaml)
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os=${target%/*} arch=${target#*/}
  bin=kubectl-skyline; [ "$os" = windows ] && bin=kubectl-skyline.exe
  stage=dist/stage_${os}_${arch}; mkdir -p "$stage"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$stage/$bin" ./cmd/kubectl-skyline
  cp LICENSE README.md "$stage/"
  if [ "$os" = windows ]; then
    archive=dist/kubectl-skyline_${os}_${arch}.zip; (cd "$stage" && zip -q -r "../../$archive" .)
  else
    archive=dist/kubectl-skyline_${os}_${arch}.tar.gz; tar -C "$stage" -czf "$archive" .
  fi
  rm -rf "$stage"
  manifest=${manifest//SHA_${os}_${arch}/$(sha "$archive")}
  echo "built $archive"
done
manifest=${manifest//VERSION/$VERSION}
printf '%s\n' "$manifest" > dist/skyline.yaml
(cd dist && shasum -a 256 kubectl-skyline_* > checksums.txt)
host_os=$(uname -s | tr '[:upper:]' '[:lower:]'); host_arch=$(uname -m)
case $host_arch in x86_64) host_arch=amd64;; aarch64|arm64) host_arch=arm64;; esac
echo
echo "manifest: dist/skyline.yaml (version $VERSION)"
echo "install locally with:"
echo "  kubectl krew install --manifest=dist/skyline.yaml --archive=dist/kubectl-skyline_${host_os}_${host_arch}.tar.gz"
