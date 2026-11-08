#!/bin/sh
# Publishes a signed release to the project's R2 bucket: every file under <channel>/<version>/, then the
# channel's moving pointer <channel>/manifest.json[.sig], which only moves forward.
#   publish_r2.sh [--freeze] DIST CHANNEL VERSION ALIASES
# DIST holds the binaries, tmux and its notices, LICENSE, NOTICES, SHA256SUMS, manifest.json and manifest.json.sig.
# ALIASES is the release plan's rolling aliases (channel-beta, channel-nightly): each names one more pointer. A nightly
# can only name channel-nightly, so it can never write a stable or beta path. Versioned objects are immutable: a version
# whose manifest.json is already there and differs from DIST's is refused, and manifest.json is uploaded last so its
# presence means "complete": a re-run whose manifest is byte for byte the published one uploads nothing, finishes the
# pointers, and so lets the caller complete a mirror Release that failed after R2 succeeded.
# A pointer is two objects, the signature and the manifest. The signature goes first and the manifest last: the forward-only
# check reads the pointer's manifest, so a run that stopped between the two leaves an old manifest and is finished by the
# next run, and a reader that sees one move's manifest with the other's signature fails verification and asks again
# (the installer and the helper retry once). Releases that can write the same pointer must not overlap: release-build.yaml
# puts them in one workflow concurrency group (r2-pointers-beta for stable and beta, r2-pointers-nightly). A freeze is in
# a group of its own (r2-freeze-<channel>) so that no release can displace it while it waits, which means a freeze and a
# release can run together on one pointer. This script is what keeps them apart: it reads a pointer right before it writes
# it and writes only a newer version, and a freeze then reads its channel's pointer back and fails unless it holds the
# freeze. What is left is a window of a few seconds between a release's read and its write; the freeze run turns red when
# it loses, and running it again repeats it.
# --resign (publish_r2.sh --resign DIST CHANNEL VERSION) writes the same release's manifest again with a later "issued_at"
# (resign_manifest.py), so a quiet channel stays inside the 90-day window the installer and the updater accept. It touches
# only the channel's own pointer, signature first, and only when the pointer still holds this version with this manifest
# apart from the issue time and a later one is offered: it cannot move a version, lift a freeze or write an older state.
# It then reads the pointer back and fails unless it holds the new manifest.
#
# --freeze moves only the pointers, with the signed freeze manifest in DIST (manifest.json and manifest.json.sig, nothing
# else is uploaded or pruned). The channel's own pointer must end up holding that manifest, or the script fails: a freeze
# that did not take effect must not look like a success. Aliases (a stable freeze also covers channel-beta) stay forward-only.
# Last, it prunes the channel's own older version prefixes (r2_retention.py) to stay inside the free tier: the version the
# channel's pointer holds and the previous 2 (4 for nightly) stay, nothing else under the bucket is touched, and it is
# skipped when any step above failed. The mirror Releases keep everything.
# Needs the AWS CLI and, in the environment, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_ACCOUNT_ID and R2_BUCKET.
# The caller runs the security review gate for stable and beta before this script;
# this script does not decide whether a release may happen.
set -eu
freeze=false; resign=false
if [ "${1:-}" = --freeze ]; then freeze=true; shift; fi
if [ "${1:-}" = --resign ]; then resign=true; shift; fi
dist="$1"; channel="$2"; version="$3"; aliases="${4:-}"
here="$(dirname "$0")"
case "$channel" in stable|beta|nightly) ;; *) echo "unknown channel $channel"; exit 1 ;; esac
case "$version" in ''|*/*|*..*) echo "bad version $version"; exit 1 ;; esac
: "${R2_ACCOUNT_ID:?}" "${R2_BUCKET:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
case "$R2_ACCOUNT_ID$R2_BUCKET" in *[!A-Za-z0-9-]*) echo "bad account id or bucket name"; exit 1 ;; esac
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
# R2 does not take the newer AWS CLI's default checksum headers
export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
s3() { aws --endpoint-url "$endpoint" "$@"; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# the pointers this release may move: its own channel, and the channels its aliases name
pointers="$channel"
for a in $aliases; do
  case "$a" in
    channel-nightly) p=nightly ;;
    channel-beta) p=beta ;;
    *) echo "unknown alias $a"; exit 1 ;;
  esac
  case " $pointers " in *" $p "*) ;; *) pointers="$pointers $p" ;; esac
done
for p in $pointers; do
  case "$channel:$p" in
    nightly:nightly|beta:beta|stable:stable|stable:beta) ;;
    *) echo "a $channel release may not write the $p path"; exit 1 ;;
  esac
done

if [ "$resign" = true ]; then
  [ -z "$aliases" ] || { echo "a re-sign writes the channel's own pointer only"; exit 1; }
  for f in manifest.json manifest.json.sig; do [ -f "$dist/$f" ] || { echo "missing $dist/$f"; exit 1; }; done
fi

absent() { case "$1" in *"(404)"*|*NoSuchKey*|*"Not Found"*) return 0 ;; *) return 1 ;; esac; }

if [ "$resign" = true ]; then
  key="$channel/manifest.json"
  s3 s3 cp "s3://$R2_BUCKET/$key" "$tmp/current.json" --only-show-errors || { echo "cannot read $key, so nothing is signed again"; exit 1; }
  [ "$(jq -r .version "$tmp/current.json")" = "$version" ] || { echo "$key holds $(jq -r .version "$tmp/current.json"), not $version: a re-sign never moves a version"; exit 1; }
  [ "$(jq -S 'del(.issued_at)' "$tmp/current.json")" = "$(jq -S 'del(.issued_at)' "$dist/manifest.json")" ] \
    || { echo "the manifest to write differs from $key in more than its issue time"; exit 1; }
  jq -e --slurpfile n "$dist/manifest.json" '(.issued_at // 0) < ($n[0].issued_at // 0)' "$tmp/current.json" >/dev/null \
    || { echo "the manifest to write is not issued later than $key"; exit 1; }
  # The pointer is read again right before anything is written: a freeze or a release that wrote since the first read is
  # not replaced by this older state, and its signature is not overwritten. What is left is the few milliseconds between
  # this read and the writes; the read-back below turns a loss there into a red run.
  s3 s3 cp "s3://$R2_BUCKET/$key" "$tmp/again.json" --only-show-errors || { echo "cannot read $key again, so nothing is signed again"; exit 1; }
  cmp -s "$tmp/again.json" "$tmp/current.json" || { echo "$key changed while it was being signed again: run it again"; exit 1; }
  s3 s3 cp "$dist/manifest.json.sig" "s3://$R2_BUCKET/$key.sig" --only-show-errors --content-type text/plain --cache-control "public,max-age=60"
  s3 s3 cp "$dist/manifest.json" "s3://$R2_BUCKET/$key" --only-show-errors --content-type application/json --cache-control "public,max-age=60"
  if ! s3 s3 cp "s3://$R2_BUCKET/$key" "$tmp/back.json" --only-show-errors || ! cmp -s "$tmp/back.json" "$dist/manifest.json" \
    || ! s3 s3 cp "s3://$R2_BUCKET/$key.sig" "$tmp/back.sig" --only-show-errors || ! cmp -s "$tmp/back.sig" "$dist/manifest.json.sig"; then
    echo "$key does not hold the re-signed manifest and its signature after they were written (something else moved the pointer): run it again"; exit 1
  fi
  echo "$key: $version signed again"; exit 0
fi

prefix="$channel/$version"
published=false
if [ "$freeze" = false ]; then
  if out="$(s3 s3 cp "s3://$R2_BUCKET/$prefix/manifest.json" "$tmp/there.json" --only-show-errors 2>&1)"; then
    if cmp -s "$tmp/there.json" "$dist/manifest.json"; then
      published=true; echo "$prefix is already published with this manifest: nothing is uploaded again"
    else
      echo "$prefix/manifest.json is already published and differs from this build: a version is never overwritten"; exit 1
    fi
  elif ! absent "$out"; then
    echo "cannot tell whether $prefix exists: $out"; exit 1
  fi
fi

immutable="public,max-age=31536000,immutable"
put() { # FILE KEY CONTENT_TYPE CACHE_CONTROL
  s3 s3 cp "$1" "s3://$R2_BUCKET/$2" --only-show-errors --content-type "$3" --cache-control "$4"
}
type_of() {
  case "$1" in
    manifest.json) echo application/json ;;
    LICENSE|NOTICES|SHA256SUMS|*.sig|tmux-COPYING|tmux-libevent-LICENSE|tmux-ncurses-COPYING) echo text/plain ;;
    *) echo application/octet-stream ;;
  esac
}
files="termenbox-server-x86_64-linux termenbox-server-aarch64-linux tmux-x86_64-linux tmux-aarch64-linux tmux-COPYING tmux-libevent-LICENSE tmux-ncurses-COPYING LICENSE NOTICES SHA256SUMS manifest.json.sig manifest.json"
[ "$freeze" = false ] || files="manifest.json.sig manifest.json"
for f in $files; do [ -f "$dist/$f" ] || { echo "missing $dist/$f"; exit 1; }; done
if [ "$freeze" = false ] && [ "$published" = false ]; then
  for f in $files; do put "$dist/$f" "$prefix/$f" "$(type_of "$f")" "$immutable"; done
  echo "uploaded $prefix"
fi

for p in $pointers; do
  key="$p/manifest.json"
  if out="$(s3 s3 cp "s3://$R2_BUCKET/$key" "$tmp/current.json" --only-show-errors 2>&1)"; then
    if cmp -s "$tmp/current.json" "$dist/manifest.json"; then
      echo "$key already holds $version"; continue
    fi
    current="$(jq -r .version "$tmp/current.json")"
    if ! python3 "$here/release_plan.py" newer "$version" "$current"; then
      if [ "$freeze" = true ] && [ "$p" = "$channel" ]; then
        echo "$key holds $current and $version is not newer: the freeze did not take effect on R2"; exit 1
      fi
      echo "$key stays at $current ($version is not newer)"; continue
    fi
    echo "$key: $current -> $version"
  elif absent "$out"; then
    echo "$key: created at $version"
  else
    echo "cannot read $key, so it is not moved: $out"; exit 1
  fi
  put "$dist/manifest.json.sig" "$key.sig" text/plain "public,max-age=60"
  put "$dist/manifest.json" "$key" application/json "public,max-age=60"
done

# A freeze must be what the channel's pointer holds now: a release that wrote in between would have replaced it.
if [ "$freeze" = true ]; then
  if ! out="$(s3 s3 cp "s3://$R2_BUCKET/$channel/manifest.json" "$tmp/back.json" --only-show-errors 2>&1)" || ! cmp -s "$tmp/back.json" "$dist/manifest.json"; then
    echo "$channel/manifest.json does not hold the freeze after it was written (something else moved the pointer): run the freeze again"; exit 1
  fi
fi

# Retention touches nothing for a freeze: it adds no version, and the one the frozen manifest names stays where it is.
[ "$freeze" = false ] || exit 0

# Retention: only after the pointers moved, only this channel's version prefixes, judged by what the pointer holds now.
case "$channel" in nightly) keep=4 ;; *) keep=2 ;; esac
if ! out="$(s3 s3 cp "s3://$R2_BUCKET/$channel/manifest.json" "$tmp/now.json" --only-show-errors 2>&1)"; then
  echo "cannot read $channel/manifest.json back, so nothing is pruned: $out"; exit 0
fi
now="$(jq -r .version "$tmp/now.json")"
if ! listing="$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "$channel/" --delimiter / --query 'CommonPrefixes[].Prefix' --output text 2>&1)"; then
  echo "cannot list $channel/, so nothing is pruned: $listing"; exit 0
fi
# the listing is "<channel>/<version>/" entries separated by white space (or None when empty)
names="$(printf '%s\n' $listing | sed -n "s#^$channel/\([^/]*\)/\$#\1#p")"
doomed="$(printf '%s\n' "$names" | python3 "$here/r2_retention.py" "$now" "$keep")"
for v in $doomed; do
  case "$v" in ''|*/*|*..*|health.txt|manifest.json*) echo "refusing to prune $v"; exit 1 ;; esac
  [ "$v" != "$now" ] || { echo "refusing to prune the current version"; exit 1; }
  s3 s3 rm "s3://$R2_BUCKET/$channel/$v/" --recursive --only-show-errors
  echo "pruned $channel/$v"
done
