#!/bin/sh
# Points a rolling alias release (channel-beta, channel-nightly) at a published release.
#   update_alias.sh ALIAS MANIFEST SIG
# The alias holds only manifest.json and its signature, a copy of the versioned release's; the assets stay under the
# real tag the manifest names. It moves only forward: a candidate that is not a newer SemVer than the alias's current
# manifest leaves it alone, so a late-finishing older run can never roll an alias back. Needs gh, jq and GH_TOKEN.
#   update_alias.sh --resign ALIAS MANIFEST SIG
# also takes the same version when the manifest differs from the alias's only in a later "issued_at" (resign_manifest.py).
set -eu
resign=false
if [ "${1:-}" = --resign ]; then resign=true; shift; fi
alias="$1"; manifest="$2"; sig="$3"
here="$(dirname "$0")"
candidate="$(jq -r .version "$manifest")"

if gh release view "$alias" >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  if gh release download "$alias" -p manifest.json -D "$tmp"; then
    current="$(jq -r .version "$tmp/manifest.json")"
    if [ "$resign" = true ]; then
      [ "$candidate" = "$current" ] || { echo "$alias holds $current, not $candidate: a re-sign never moves a version"; exit 1; }
      [ "$(jq -S 'del(.issued_at)' "$tmp/manifest.json")" = "$(jq -S 'del(.issued_at)' "$manifest")" ] \
        || { echo "the manifest differs from $alias in more than its issue time"; exit 1; }
      jq -e --slurpfile n "$manifest" '(.issued_at // 0) < ($n[0].issued_at // 0)' "$tmp/manifest.json" >/dev/null \
        || { echo "$alias stays as it is (the manifest is not issued later)"; exit 0; }
      echo "$alias: $current signed again"
    elif ! python3 "$here/release_plan.py" newer "$candidate" "$current"; then
      echo "$alias stays at $current ($candidate is not newer)"
      exit 0
    else
      echo "$alias: $current -> $candidate"
    fi
  elif [ "$resign" = true ]; then
    # Without what the alias holds, none of the checks above can run: a re-sign never writes blind.
    echo "cannot read $alias's manifest, so nothing is signed again"; exit 1
  fi
  gh release upload "$alias" "$manifest" "$sig" --clobber
else
  [ "$resign" = false ] || { echo "$alias does not exist: nothing to sign again"; exit 1; }
  echo "$alias: created at $candidate"
  # Never "latest": releases/latest/download is the stable channel's address.
  gh release create "$alias" --title "$alias" --prerelease --latest=false \
    --notes "Rolling pointer of the ${alias#channel-} channel: only the manifest and its signature, which name the real release. Do not download from here by hand." \
    "$manifest" "$sig"
fi
