#!/bin/sh
# Signs a manifest the way release-build.yaml does and checks the signature against the channel's own key in a keys file.
#   sign_manifest.sh PRIVATE_KEY KEYS_FILE KID CHANNEL MANIFEST
# Writes MANIFEST.sig (namespace termenbox-release, the one the updater and the installer check) and exits non-zero
# unless the signature verifies against the line KID of KEYS_FILE, whose channel binding must be CHANNEL (a line without
# `channel=` is a stable key; decision 0130). The private key file is not removed here: the caller owns it.
set -eu
key="$1"; keys="$2"; kid="$3"; channel="$4"; manifest="$5"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rm -f "$manifest.sig"
ssh-keygen -Y sign -q -n termenbox-release -f "$key" "$manifest"
grep -v '^#' "$keys" | awk -v kid="$kid" -v ch="$channel" '
  $1 == kid && NF >= 3 { c = "stable"; if ($4 ~ /^channel=/) c = substr($4, 9); if (c == ch) print "termenbox-release " $2 " " $3 }' > "$tmp/allowed_signers"
[ -s "$tmp/allowed_signers" ] || { echo "$keys has no $channel key $kid: add its public half (owner work, decision 0130)"; exit 1; }
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I termenbox-release -n termenbox-release -s "$manifest.sig" < "$manifest" >/dev/null
echo "signed $manifest with $kid"
