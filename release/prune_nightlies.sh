#!/bin/sh
# Deletes nightly releases (and their tags) older than KEEP_DAYS, never the one channel-nightly points at.
#   prune_nightlies.sh [KEEP_DAYS]      (default 14; DRY_RUN=1 only prints). Needs gh, jq and GH_TOKEN.
# If the alias cannot be read, nothing is deleted: without it there is no telling which release must stay.
set -eu
keep="${1:-14}"
tmp="$(mktemp -d)"
if ! gh release download channel-nightly -p manifest.json -D "$tmp" 2>/dev/null; then
  echo "channel-nightly has no manifest; deleting nothing"
  exit 0
fi
# the alias holds the manifest of the nightly it points at; that nightly's tag is vYYYY.MM.DD-nightly for the day in its
# version (X.Y.Z-nightly.YYYYMMDD, or .N after it for a later nightly of the day), because its asset URLs name the download host, not the release
day="$(jq -r '.version // empty | capture("-nightly\\.(?<d>[0-9]{8})(\\.(?<n>[0-9]+))?$") | .d + (if .n then "." + .n else "" end)' "$tmp/manifest.json" 2>/dev/null || true)"
target=""
[ -z "$day" ] || target="v$(printf '%s' "$day" | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})(\.([0-9]+))?$/\1.\2.\3-nightly.\5/; s/-nightly\.$/-nightly/')"
[ -n "$target" ] && [ "$target" != null ] || { echo "cannot read the alias target; deleting nothing"; exit 0; }
cutoff="$(date -u -d "$keep days ago" +%Y%m%d)"
echo "alias target $target; deleting nightlies before $cutoff"
gh release list --limit 300 --json tagName -q '.[].tagName' | grep -E '^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}-nightly(\.[0-9]+)?$' | while read -r tag; do
  day="$(printf '%s' "$tag" | sed -E 's/^v([0-9]{4})\.([0-9]{2})\.([0-9]{2})-nightly(\.[0-9]+)?$/\1\2\3/')"
  [ "$day" -lt "$cutoff" ] || continue
  if [ "$tag" = "$target" ]; then echo "keeping $tag (the alias points at it)"; continue; fi
  echo "deleting $tag"
  [ -n "${DRY_RUN:-}" ] || gh release delete "$tag" --cleanup-tag --yes
done
