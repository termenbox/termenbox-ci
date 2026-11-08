#!/bin/sh
# Exits non-zero while a channel is frozen and the release being made would not replace the freeze.
#   check_not_frozen.sh CHANNEL VERSION
# The channel's current manifest is the one its alias (channel-beta, channel-nightly) or, for stable, the latest release
# holds. A channel with no published manifest is not frozen. Needs gh and GH_TOKEN. A manifest that cannot be read
# for any other reason stops the release: the answer is unknown.
set -eu
channel="$1"; version="$2"
here="$(dirname "$0")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
case "$channel" in
  stable) release="" ;;
  beta|nightly) release="channel-$channel" ;;
  *) echo "unknown channel $channel"; exit 1 ;;
esac
if ! out="$(gh release view ${release:+"$release"} --json tagName -q .tagName 2>&1)"; then
  case "$out" in *"not found"*) echo "$channel has no release yet: not frozen"; exit 0 ;; esac
  echo "cannot tell whether $channel is frozen: $out"; exit 1
fi
gh release download "$out" -p manifest.json -D "$tmp" >/dev/null
if python3 "$here/release_plan.py" thaws "$version" "$tmp/manifest.json"; then
  echo "$channel is not frozen against $version"
else
  echo "$channel is frozen by a signed freeze at $(jq -r .version "$tmp/manifest.json"); $version does not replace it. Release a version newer than the freeze to lift it."
  exit 1
fi
