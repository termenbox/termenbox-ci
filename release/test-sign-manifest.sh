#!/bin/sh
# sign_manifest.sh with throwaway keys: signs for the channel's own key, refuses a key of another channel or another key.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ssh-keygen -q -t ed25519 -N '' -C t -f "$tmp/k1"
ssh-keygen -q -t ed25519 -N '' -C t -f "$tmp/k2"
pub() { cut -d' ' -f1,2 "$1.pub"; }
printf '# keys\nr1 %s\nb1 %s channel=beta\n' "$(pub "$tmp/k1")" "$(pub "$tmp/k2")" > "$tmp/keys.txt"
echo '{"version":"1"}' > "$tmp/m.json"
sign() { sh "$here/sign_manifest.sh" "$tmp/$1" "$tmp/keys.txt" "$2" "$3" "$tmp/m.json" >/dev/null 2>&1; }
sign k1 r1 stable || { echo "FAIL: the stable key did not sign a stable manifest"; exit 1; }
sign k2 b1 beta || { echo "FAIL: the beta key did not sign a beta manifest"; exit 1; }
! sign k1 r1 beta || { echo "FAIL: a stable key was accepted for the beta channel"; exit 1; }
! sign k2 r1 stable || { echo "FAIL: a signature by another key was accepted"; exit 1; }
! sign k1 n1 nightly || { echo "FAIL: a kid missing from the keys file was accepted"; exit 1; }
echo ok
