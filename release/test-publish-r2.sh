#!/bin/sh
# publish_r2.sh with a stub aws that keeps the bucket in a directory: versioned files with immutable caching, a pointer that
# is created, moved forward and never moved back, a version that is never overwritten, and no way for a nightly (or a
# beta) to write another channel's path.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bucket" "$tmp/bin"
cat > "$tmp/bin/aws" <<STUB
#!/bin/sh
# aws --endpoint-url URL s3 cp SRC DST [--content-type T --cache-control C ...] | s3api head-object --bucket B --key K
[ "\$1" = --endpoint-url ] && [ "\$2" = "https://acct1.r2.cloudflarestorage.com" ] || { echo "bad endpoint \$2" >&2; exit 2; }
shift 2
case "\$1 \$2" in
  "s3 cp")
    src="\$3"; dst="\$4"; shift 4
    ct=""; cc=""
    while [ \$# -gt 0 ]; do case "\$1" in --content-type) ct="\$2"; shift ;; --cache-control) cc="\$2"; shift ;; esac; shift; done
    case "\$src" in
      s3://*) f="$tmp/bucket/\${src#s3://bkt/}"; [ -f "\$f" ] || { echo "An error occurred (404) when calling the HeadObject operation: Key does not exist" >&2; exit 1; }; cp "\$f" "\$dst"
         # a writer that changes the object right after it was read once (the next read differs)
         if [ -f "$tmp/changeafterread" ] && [ "\$(cat "$tmp/changeafterread")" = "\${src#s3://bkt/}" ]; then rm "$tmp/changeafterread"; printf '{"version":"0.5.0-nightly.20261110","freeze":true,"issued_at":999}' > "\$f"; fi ;;
      *) k="\${dst#s3://bkt/}"; { [ -f "$tmp/failput" ] && [ "\$(cat "$tmp/failput")" = "\$k" ]; } && { echo "put failed: \$k" >&2; exit 1; }
         mkdir -p "\$(dirname "$tmp/bucket/\$k")"; cp "\$src" "$tmp/bucket/\$k"; echo "\$k|\$ct|\$cc" >> "$tmp/puts"
         # a release that writes the pointer right after the freeze did
         if [ -f "$tmp/clobber" ] && [ "\$(cat "$tmp/clobber")" = "\$k" ]; then printf '{"version":"0.1.0"}' > "$tmp/bucket/\$k"; fi ;;
    esac ;;
  "s3 rm")
    pre="\${3#s3://bkt/}"; echo "\$pre" >> "$tmp/rms"; rm -rf "$tmp/bucket/\$pre" ;;
  "s3api list-objects-v2")
    while [ \$# -gt 0 ]; do [ "\$1" = --prefix ] && p="\$2"; shift; done
    (cd "$tmp/bucket" && for d in "\$p"*/; do [ -d "\$d" ] && printf '%s ' "\$d"; done; true) | sed 's/ \$//'; [ -d "$tmp/bucket/\${p%/}" ] || echo None ;;
  "s3api head-object")
    while [ \$# -gt 0 ]; do [ "\$1" = --key ] && k="\$2"; shift; done
    [ -f "$tmp/bucket/\$k" ] || { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; } ;;
  *) echo "unexpected: \$*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/aws"
export PATH="$tmp/bin:$PATH" R2_ACCOUNT_ID=acct1 R2_BUCKET=bkt AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s

dist() { # VERSION
  d="$tmp/dist"; rm -rf "$d"; mkdir -p "$d"
  for f in termenbox-server-x86_64-linux termenbox-server-aarch64-linux tmux-x86_64-linux tmux-aarch64-linux tmux-COPYING tmux-libevent-LICENSE tmux-ncurses-COPYING LICENSE NOTICES SHA256SUMS manifest.json.sig; do echo "$f $1" > "$d/$f"; done
  printf '{"version":"%s"}' "$1" > "$d/manifest.json"
}
run() { : > "$tmp/puts"; sh "$here/publish_r2.sh" "$tmp/dist" "$@" > "$tmp/out" 2>&1; }
fail() { cat "$tmp/out"; echo "FAIL: $1"; exit 1; }
pointer() { jq -r .version "$tmp/bucket/$1/manifest.json"; }

dist 0.2.0-rc.1; run beta 0.2.0-rc.1 channel-beta || fail "first beta"
[ "$(pointer beta)" = 0.2.0-rc.1 ] || fail "the pointer was not created"
[ -f "$tmp/bucket/beta/0.2.0-rc.1/termenbox-server-x86_64-linux" ] || fail "versioned file missing"
grep -q '^beta/0.2.0-rc.1/termenbox-server-x86_64-linux|application/octet-stream|public,max-age=31536000,immutable$' "$tmp/puts" || fail "versioned objects are not immutable"
grep -q '^beta/manifest.json|application/json|public,max-age=60$' "$tmp/puts" || fail "the pointer has the wrong cache control"
[ "$(tail -1 "$tmp/puts" | cut -d'|' -f1)" = beta/manifest.json ] || fail "the pointer's manifest is not the last object written"
[ "$(tail -2 "$tmp/puts" | head -1 | cut -d'|' -f1)" = beta/manifest.json.sig ] || fail "the pointer's signature is not written before its manifest"
last_versioned="$(grep '^beta/0.2.0-rc.1/' "$tmp/puts" | tail -1 | cut -d'|' -f1)"
[ "$last_versioned" = beta/0.2.0-rc.1/manifest.json ] || fail "manifest.json is not the last versioned object"

dist 0.2.0-rc.2; run beta 0.2.0-rc.2 channel-beta || fail "newer beta"
[ "$(pointer beta)" = 0.2.0-rc.2 ] || fail "a newer beta did not move the pointer"
dist 0.2.0-rc.1; run beta 0.2.0-rc.1 channel-beta || fail "the same build again was refused"
! grep -q '^beta/0.2.0-rc.1/' "$tmp/puts" || fail "the same build again uploaded its files a second time"
dist 0.2.0-rc.1; printf '{"version":"0.2.0-rc.1","other":1}' > "$tmp/dist/manifest.json"
! run beta 0.2.0-rc.1 channel-beta || fail "a published version was overwritten by a different build"
[ "$(pointer beta)" = 0.2.0-rc.2 ] || fail "the pointer moved for a refused build"
dist 0.2.0-rc.0; run beta 0.2.0-rc.0 channel-beta || fail "an older, unpublished beta is still uploaded"
[ "$(pointer beta)" = 0.2.0-rc.2 ] || fail "an older beta rolled the pointer back"

# a run that stops between the signature and the manifest leaves the old pointer in place, and the next run finishes it
dist 0.2.0-rc.3; echo beta/manifest.json > "$tmp/failput"
! run beta 0.2.0-rc.3 channel-beta || fail "a failed pointer upload was reported as a success"
rm "$tmp/failput"
[ "$(pointer beta)" = 0.2.0-rc.2 ] || fail "a half-moved pointer shows the new version"
run beta 0.2.0-rc.3 channel-beta || fail "the re-run after a failed pointer upload"
[ "$(pointer beta)" = 0.2.0-rc.3 ] || fail "the re-run did not finish the pointer"
grep -q '^beta/0.2.0-rc.3/' "$tmp/puts" && fail "the re-run uploaded the version again"

dist 0.2.0; run stable 0.2.0 channel-beta || fail "stable"
[ "$(pointer stable)" = 0.2.0 ] && [ "$(pointer beta)" = 0.2.0 ] || fail "stable did not move its pointer and the newer-than-beta channel-beta"
dist 0.1.9; run stable 0.1.9 channel-beta || fail "an older stable"
[ "$(pointer stable)" = 0.2.0 ] && [ "$(pointer beta)" = 0.2.0 ] || fail "an older stable moved a pointer"

dist 0.3.0-nightly.20261101; run nightly 0.3.0-nightly.20261101 channel-nightly || fail "nightly"
[ "$(pointer nightly)" = 0.3.0-nightly.20261101 ] || fail "nightly pointer"
[ "$(pointer stable)" = 0.2.0 ] && [ "$(pointer beta)" = 0.2.0 ] || fail "a nightly moved a stable or beta pointer"
dist 0.4.0-nightly.20261102
! run nightly 0.4.0-nightly.20261102 "channel-nightly channel-beta" || fail "a nightly named channel-beta"
! run nightly 0.4.0-nightly.20261102 channel-stable || fail "an unknown alias was accepted"
! run beta 0.4.0-beta.1 channel-nightly || fail "a beta named channel-nightly"
[ ! -e "$tmp/bucket/nightly/0.4.0-nightly.20261102" ] || fail "a refused release uploaded something"
rm "$tmp/dist/LICENSE"; ! run nightly 0.4.0-nightly.20261102 channel-nightly || fail "a missing file was accepted"
[ ! -e "$tmp/bucket/nightly/0.4.0-nightly.20261102" ] || fail "an incomplete release uploaded something"

# retention: stable keeps the pointer's version and 2 before it; nothing else is touched
mkdir -p "$tmp/bucket/stable"; echo x > "$tmp/bucket/health.txt"
for v in 0.2.1 0.2.2 0.2.3; do dist $v; run stable $v || fail "stable $v"; done
[ -d "$tmp/bucket/stable/0.2.3" ] && [ -d "$tmp/bucket/stable/0.2.2" ] && [ -d "$tmp/bucket/stable/0.2.1" ] || fail "kept versions were pruned"
[ ! -d "$tmp/bucket/stable/0.2.0" ] || fail "the oldest stable was not pruned"
[ -f "$tmp/bucket/health.txt" ] && [ -f "$tmp/bucket/stable/manifest.json" ] || fail "pruning touched a non-version object"
[ "$(pointer stable)" = 0.2.3 ] || fail "pointer after prune"
[ -d "$tmp/bucket/beta/0.2.0-rc.1" ] && [ -d "$tmp/bucket/beta/0.2.0-rc.2" ] || fail "a stable release pruned the beta prefix"
# an older version published later is not the pointer, and is itself pruned only if it is out of the window
dist 0.1.0; run stable 0.1.0 || fail "older stable"
[ "$(pointer stable)" = 0.2.3 ] || fail "older stable moved the pointer"

# a freeze writes only the pointers: the signed freeze manifest, signature first, forward-only, and it fails if the channel's own pointer did not take it
freeze_dist() { # VERSION
  d="$tmp/fdist"; rm -rf "$d"; mkdir -p "$d"; echo "sig $1" > "$d/manifest.json.sig"
  printf '{"version":"%s","freeze":true}' "$1" > "$d/manifest.json"
}
frun() { : > "$tmp/puts"; sh "$here/publish_r2.sh" --freeze "$tmp/fdist" "$@" > "$tmp/out" 2>&1; }
freeze_dist 0.2.4; frun stable 0.2.4 channel-beta || fail "a stable freeze"
[ "$(pointer stable)" = 0.2.4 ] && [ "$(pointer beta)" = 0.2.4 ] || fail "a stable freeze did not reach the stable and beta pointers"
[ "$(jq -r .freeze "$tmp/bucket/stable/manifest.json")" = true ] || fail "the pointer does not hold the freeze"
[ "$(cut -d'|' -f1 "$tmp/puts" | tr '\n' ' ')" = "stable/manifest.json.sig stable/manifest.json beta/manifest.json.sig beta/manifest.json " ] || fail "a freeze wrote something besides the two pointers, or in another order"
[ ! -e "$tmp/bucket/stable/0.2.4" ] || fail "a freeze added a version prefix"
[ -d "$tmp/bucket/stable/0.2.3" ] || fail "a freeze pruned a version"
frun stable 0.2.4 channel-beta || fail "the same freeze again"
freeze_dist 0.2.3; ! frun stable 0.2.3 || fail "a freeze that is not newer was reported as taking effect"
[ "$(pointer stable)" = 0.2.4 ] || fail "an older freeze moved the pointer"
dist 0.4.0-nightly.20261103
freeze_dist 0.4.0-nightly.20261104; ! frun nightly 0.4.0-nightly.20261104 channel-beta || fail "a nightly freeze named channel-beta"
freeze_dist 0.3.0-nightly.20261102; frun nightly 0.3.0-nightly.20261102 channel-nightly || fail "a nightly freeze"
[ "$(pointer nightly)" = 0.3.0-nightly.20261102 ] && [ "$(pointer stable)" = 0.2.4 ] || fail "a nightly freeze moved the wrong pointer"
# a release that overwrites the pointer right after the freeze: the freeze run fails instead of looking like a success
freeze_dist 0.5.0-nightly.20261110; echo nightly/manifest.json > "$tmp/clobber"
! frun nightly 0.5.0-nightly.20261110 channel-nightly || fail "a freeze that a release displaced was reported as taking effect"
grep -q 'run the freeze again' "$tmp/out" || fail "a displaced freeze does not say what to do"
rm "$tmp/clobber"; frun nightly 0.5.0-nightly.20261110 channel-nightly || fail "the freeze again after it was displaced"
[ "$(jq -r .freeze "$tmp/bucket/nightly/manifest.json")" = true ] || fail "the repeated freeze is not on the pointer"

# a re-sign writes the channel's own pointer again with a later issue time: signature first, the same version and the same
# content apart from the issue time, a freeze stays a freeze, and an older or equal issue time is refused
resign_dist() { # VERSION FREEZE ISSUED_AT
  d="$tmp/rdist"; rm -rf "$d"; mkdir -p "$d"; echo "sig $3" > "$d/manifest.json.sig"
  printf '{"version":"%s","freeze":%s,"issued_at":%s}' "$1" "$2" "$3" > "$d/manifest.json"
}
rrun() { : > "$tmp/puts"; sh "$here/publish_r2.sh" --resign "$tmp/rdist" "$@" > "$tmp/out" 2>&1; }
v=0.5.0-nightly.20261110
resign_dist $v true 200; rrun nightly $v || fail "a re-sign"
[ "$(jq -r .issued_at "$tmp/bucket/nightly/manifest.json")" = 200 ] && [ "$(jq -r .freeze "$tmp/bucket/nightly/manifest.json")" = true ] || fail "the pointer does not hold the re-signed manifest"
[ "$(cut -d'|' -f1 "$tmp/puts" | tr '\n' ' ')" = "nightly/manifest.json.sig nightly/manifest.json " ] || fail "a re-sign wrote something besides the pointer, or in another order"
resign_dist $v true 200; ! rrun nightly $v || fail "a re-sign with the same issue time was written"
resign_dist $v true 100; ! rrun nightly $v || fail "a re-sign with an older issue time was written"
resign_dist $v false 300; ! rrun nightly $v || fail "a re-sign lifted a freeze"
resign_dist 0.5.1-nightly.20261111 true 300; ! rrun nightly 0.5.1-nightly.20261111 || fail "a re-sign moved a version"
resign_dist $v true 300; ! rrun nightly $v channel-beta || fail "a re-sign named an alias"
resign_dist $v true 300; echo nightly/manifest.json > "$tmp/clobber"
! rrun nightly $v || fail "a re-sign that something displaced was reported as taking effect"
rm "$tmp/clobber"
grep -q 'run it again' "$tmp/out" || fail "a displaced re-sign does not say what to do"
# the pointer now holds another version: a re-sign of the old one is refused, it never moves a version back
rm -f "$tmp/clobber"; resign_dist $v true 400; ! rrun nightly $v || fail "a re-sign replaced a pointer that moved to another version"
# a pointer that changes between the first read and the write is left alone, signature included
printf '{"version":"%s","freeze":true,"issued_at":300}' "$v" > "$tmp/bucket/nightly/manifest.json"
echo "sig before" > "$tmp/bucket/nightly/manifest.json.sig"
resign_dist $v true 500
echo nightly/manifest.json > "$tmp/changeafterread"
! rrun nightly $v || fail "a re-sign replaced a pointer that changed after it was read"
[ "$(cat "$tmp/bucket/nightly/manifest.json.sig")" = "sig before" ] || fail "a re-sign overwrote the signature of a pointer that changed"
[ "$(jq -r .issued_at "$tmp/bucket/nightly/manifest.json")" = 999 ] || fail "the other writer's manifest was replaced"
echo ok
