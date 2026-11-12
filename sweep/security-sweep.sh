#!/bin/sh
# The monthly security sweep: runs every recurring check and prints ONLY the number
# of checks that passed, the number that failed and the NAMES of the failing ones. A check's own output is discarded here,
# so nothing a check finds can reach a public log. The owner
# reads the detail in the encrypted job log.
#
#   sh sweep/security-sweep.sh                   run the checks that need this repo and the tokens of the job
#   sh sweep/security-sweep.sh --tools           run the checks that need the source tree (SWEEP_SOURCE_DIR); that job holds no secret
#   sh sweep/security-sweep.sh --list FILE     run the checks of FILE instead (one `name<TAB>command` per line; the tests use this)
#
# Environment (all optional; a check that needs a missing value fails by its name):
#   SWEEP_SUMMARY  file that also receives the printed lines (the workflow posts it to the private monthly issue)
#   SWEEP_DENY     the cargo-deny command, default `cargo deny` (the workflow installs it)
#   SWEEP_RUST     prefix for cargo commands, default `sh scripts/dev.sh` (the pinned build container)
#   SWEEP_FUZZ     prefix for the bounded fuzz run, default `sh scripts/dev.sh --fuzz`
#   SWEEP_FUZZ_SECS  seconds per fuzz target, default 60
#   SWEEP_DL_HOST  download host, default https://dl.termenbox.dev
#   SWEEP_TOKENS   names of the environment variables that hold tokens to check for expiry, default `SOURCE_TOKEN LOG_TOKEN STATUS_TOKEN`
#   SWEEP_GH_REPO  the ci repo (owner/name): the token-scope check asks it for a recent successful per-Environment run
#   SWEEP_CI_BYTES  live artifact bytes the ci-storage check allows, default 2000000000; SWEEP_CACHE_BYTES the cache bytes, default 7000000000
#   SWEEP_MANIFEST_WARN_DAYS  age in days from which a channel's signed manifest fails the manifest-age check, default 60
#                  (the installer and the updater refuse one older than 90, so this leaves 30 days to sign it again)
#   SWEEP_CI_IMAGE_DAYS  age in days of the CI image ci.yaml pins, once a newer build exists, from which ci-image-age fails, default 60
#   SWEEP_STATE    file holding the last seen manifest versions (`channel version` lines), read and rewritten by the manifest check
set -u
cd "$(dirname "$0")/.."

SRC=${SWEEP_SOURCE_DIR:-}
RUST=${SWEEP_RUST:-sh scripts/dev.sh}
FUZZ=${SWEEP_FUZZ:-sh scripts/dev.sh --fuzz}
FUZZ_SECS=${SWEEP_FUZZ_SECS:-60}
export SWEEP_DL_HOST="${SWEEP_DL_HOST:-https://dl.termenbox.dev}"
export SWEEP_TOKENS="${SWEEP_TOKENS:-SOURCE_TOKEN LOG_TOKEN STATUS_TOKEN}"
export SWEEP_STATE="${SWEEP_STATE:-}"
NIGHTLY=nightly-2026-10-15

# Built-in checks, one `name<TAB>command` per line. Commands run with `sh -c`, output discarded.
builtin_checks() {
  tab=$(printf '\t')
  cat <<EOF
workflow-lint${tab}zizmor --min-severity high ${TERMENBOX_WORKFLOWS_DIR:-.github/workflows}
pinned-actions${tab}node sweep/check-pinned-actions.mjs
job-environments${tab}node sweep/check-job-environments.mjs
deploy-token-scope${tab}sh sweep/security-sweep.sh --token-scope
ci-settings${tab}node sweep/check-ci-settings.mjs
repo-structure${tab}node sweep/check-repo-structure.mjs
token-expiry${tab}sh sweep/security-sweep.sh --token-expiry
dl-no-listing${tab}sh sweep/security-sweep.sh --dl-listing
manifest-forward${tab}sh sweep/security-sweep.sh --manifest-forward
manifest-age${tab}sh sweep/security-sweep.sh --manifest-age
ci-storage${tab}sh sweep/security-sweep.sh --ci-storage
ci-image-age${tab}node sweep/check-ci-image-age.mjs
EOF
}

# The checks that run the source tree's tools. They run in a job that holds no secret; each runs inside SWEEP_SOURCE_DIR.
tool_checks() {
  [ -n "$SRC" ] && [ -d "$SRC" ] || { echo "sweep: no source tree"; exit 2; }
  tab=$(printf '\t')
  cat <<EOF
cargo-deny${tab}cd "$SRC" && ${SWEEP_DENY:-cargo deny} --manifest-path packages/server/Cargo.toml check licenses advisories
pnpm-audit${tab}cd "$SRC" && node scripts/check-pnpm-audit.mjs
fuzz-bounded${tab}cd "$SRC" && $FUZZ sh -c 'cd packages/server && for t in \$(cargo +$NIGHTLY fuzz list); do cargo +$NIGHTLY fuzz run \$t -- -max_total_time=$FUZZ_SECS || exit 1; done'
preauth-caps${tab}cd "$SRC" && $RUST cargo test -p termenbox-server -- preauth_ per_source_cap_ignores_spoofed_headers rejection_is_cheaper_than_request unauthenticated_input_cannot_start_a_process
EOF
}

# --- sub-checks (each exits 0 or 1 and prints nothing a human must read) ---

# Each Environment's Cloudflare token: the check reads its token from that Environment, which only a job of that Environment
# holds, so the sweep job (Environment `security`) asks the dispatch of the per-Environment workflow for its last result.
sub_token_scope() {
  [ -n "${SWEEP_GH_REPO:-}" ] || exit 1
  n=$(gh run list -R "$SWEEP_GH_REPO" --workflow check-deploy-token-scope.yaml --status success -L 1 \
    --json createdAt -q '[.[] | select((.createdAt | fromdateiso8601) > (now - 14*86400))] | length' 2>/dev/null) || exit 1
  [ "${n:-0}" = 1 ]
}

# Fails when a token has no expiry or expires within 30 days (GitHub reports a fine-grained token's expiry in a header).
sub_token_expiry() {
  limit=$(( $(date +%s) + 30*86400 ))
  for name in $SWEEP_TOKENS; do
    eval "tok=\${$name:-}"
    [ -n "$tok" ] || exit 1
    exp=$(curl -fsS -I -H "Authorization: Bearer $tok" https://api.github.com/rate_limit 2>/dev/null \
      | tr -d '\r' | sed -n 's/^[Gg]ithub-authentication-token-expiration: *//p') || exit 1
    [ -n "$exp" ] || exit 1
    at=$(date -d "$exp" +%s 2>/dev/null) || exit 1
    [ "$at" -gt "$limit" ] || exit 1
  done
}

# The download host must not list its bucket, at the root or in a channel directory.
sub_dl_listing() {
  for p in "" stable/ beta/ nightly/; do
    body=$(curl -sS -m 20 "$SWEEP_DL_HOST/$p" 2>/dev/null) || body=""
    case "$body" in *ListBucketResult*|*"Index of"*|*"<Contents>"*) exit 1 ;; esac
  done
}

# Each channel's manifest version never goes below the one the last sweep saw (SWEEP_STATE keeps it between runs).
sub_manifest_forward() {
  tmp=$(mktemp) || exit 1
  : > "$tmp"
  rc=0
  for ch in stable beta nightly; do
    v=$(curl -fsS -m 20 "$SWEEP_DL_HOST/$ch/manifest.json" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1) || v=""
    [ -n "$v" ] || { rc=1; continue; }
    if [ -n "$SWEEP_STATE" ] && [ -f "$SWEEP_STATE" ]; then
      old=$(awk -v c="$ch" '$1 == c { print $2 }' "$SWEEP_STATE")
      if [ -n "$old" ] && [ "$(printf '%s\n%s\n' "$old" "$v" | sort -V | head -1)" != "$old" ]; then rc=1; fi
    fi
    echo "$ch $v" >> "$tmp"
  done
  [ -z "$SWEEP_STATE" ] || cp "$tmp" "$SWEEP_STATE"
  rm -f "$tmp"
  exit "$rc"
}

# Every channel's pointer manifest states an issue time that is at most SWEEP_MANIFEST_WARN_DAYS old: the installer and the
# updater refuse one older than 90 days, so this is the warning that a re-sign is due (the beta and nightly pointers are signed
# again by the monthly re-sign job, the stable one offline by the owner).
sub_manifest_age() {
  limit=$(( ${SWEEP_MANIFEST_WARN_DAYS:-60} * 86400 ))
  now=$(date +%s)
  rc=0
  for ch in stable beta nightly; do
    at=$(curl -fsS -m 20 "$SWEEP_DL_HOST/$ch/manifest.json" 2>/dev/null | sed -n 's/^ *"issued_at": *\([0-9][0-9]*\).*/\1/p' | head -1) || at=""
    [ -n "$at" ] && [ "$at" -ge $((now - limit)) ] && [ "$at" -le $((now + 86400)) ] || rc=1
  done
  exit "$rc"
}

# The ci repo's live artifact bytes stay under 2 GB, its cache bytes under 7 GB, and the previous month's Actions minutes are
# not above 1.5 times the month before. The minutes need a token that can read billing usage; when the API refuses, that
# part is skipped, the two byte limits still apply.
sub_ci_storage() {
  [ -n "${SWEEP_GH_REPO:-}" ] || exit 1
  art=$(gh api --paginate "repos/$SWEEP_GH_REPO/actions/artifacts" --jq '.artifacts[] | select(.expired == false) | .size_in_bytes' 2>/dev/null \
    | awk '{ s += $1 } END { print s + 0 }') || exit 1
  cache=$(gh api "repos/$SWEEP_GH_REPO/actions/cache/usage" --jq '.active_caches_size_in_bytes' 2>/dev/null) || exit 1
  [ -n "$art" ] && [ -n "$cache" ] || exit 1
  [ "$art" -lt "${SWEEP_CI_BYTES:-2000000000}" ] && [ "$cache" -lt "${SWEEP_CACHE_BYTES:-7000000000}" ] || exit 1
  owner=${SWEEP_GH_REPO%%/*}
  last=$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)
  before=$(date -u -d "$(date -u +%Y-%m-01) -2 month" +%Y-%m)
  mins() {
    gh api "organizations/$owner/settings/billing/usage?year=${1%-*}&month=$(expr "${1#*-}" + 0)" \
      --jq '[.usageItems[] | select(.product == "actions" and .unitType == "Minutes") | .quantity] | add // 0' 2>/dev/null
  }
  a=$(mins "$last") && b=$(mins "$before") || exit 0
  [ -n "$a" ] && [ -n "$b" ] || exit 0
  awk -v a="$a" -v b="$b" 'BEGIN { exit !(b == 0 || a <= 1.5 * b) }'
}

case "${1:-}" in
  --ci-storage) (sub_ci_storage); exit $? ;;
  --token-scope) (sub_token_scope); exit $? ;;
  --token-expiry) (sub_token_expiry); exit $? ;;
  --dl-listing) (sub_dl_listing); exit $? ;;
  --manifest-forward) (sub_manifest_forward); exit $? ;;
  --manifest-age) (sub_manifest_age); exit $? ;;
esac

list=""
mode=builtin
if [ "${1:-}" = "--tools" ]; then mode=tools; fi
if [ "${1:-}" = "--list" ]; then
  list=${2:?usage: security-sweep.sh [--list FILE]}
  [ -f "$list" ] || { echo "sweep: no such list"; exit 2; }
fi

work=$(mktemp -d) || exit 2
trap 'rm -rf "$work"' EXIT
if [ -n "$list" ]; then cp "$list" "$work/checks"; elif [ "$mode" = tools ]; then tool_checks > "$work/checks"; else builtin_checks > "$work/checks"; fi

pass=0
fail=0
: > "$work/failed"
while IFS="$(printf '\t')" read -r name cmd; do
  [ -n "$name" ] || continue
  case "$name" in \#*) continue ;; esac
  if sh -c "$cmd" >/dev/null 2>&1 </dev/null; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "$name" >> "$work/failed"; fi
done < "$work/checks"

{
  echo "sweep: $pass passed, $fail failed"
  while read -r n; do echo "failed: $n"; done < "$work/failed"
} > "$work/out"
cat "$work/out"
[ -z "${SWEEP_SUMMARY:-}" ] || cp "$work/out" "$SWEEP_SUMMARY"
[ "$fail" -eq 0 ]
