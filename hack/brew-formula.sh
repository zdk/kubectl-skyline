#!/usr/bin/env bash
# Prints the Homebrew formula for a released version: hack/brew-formula.sh v0.1.4
set -euo pipefail
tag=$1
base=https://github.com/zdk/kubectl-skyline/releases/download/$tag
sums=$(curl -fsSL "$base/checksums.txt")
sha() {
  local s
  s=$(awk -v f="kubectl-skyline_$1.tar.gz" '$2 == f {print $1}' <<<"$sums")
  [ -n "$s" ] || { echo "no checksum for $1 in $tag" >&2; exit 1; }
  echo "$s"
}
for p in darwin_arm64 darwin_amd64 linux_arm64 linux_amd64; do
  declare "sha_$p=$(sha $p)"
done

cat <<EOF
class KubectlSkyline < Formula
  desc "Explore a Kubernetes cluster as an interactive 3D city"
  homepage "https://github.com/zdk/kubectl-skyline"
  version "${tag#v}"
  license "MIT"

  on_macos do
    on_arm do
      url "$base/kubectl-skyline_darwin_arm64.tar.gz"
      sha256 "$sha_darwin_arm64"
    end
    on_intel do
      url "$base/kubectl-skyline_darwin_amd64.tar.gz"
      sha256 "$sha_darwin_amd64"
    end
  end

  on_linux do
    on_arm do
      url "$base/kubectl-skyline_linux_arm64.tar.gz"
      sha256 "$sha_linux_arm64"
    end
    on_intel do
      url "$base/kubectl-skyline_linux_amd64.tar.gz"
      sha256 "$sha_linux_amd64"
    end
  end

  def install
    bin.install "kubectl-skyline"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kubectl-skyline --version")
  end
end
EOF
