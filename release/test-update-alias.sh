#!/bin/sh
# update_alias.sh with a stub gh: an alias is created when missing, replaced by a newer version, never by an older one.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
cat > "$tmp/gh" <<STUB
#!/bin/sh
echo "\$1 \$2" >> "$tmp/calls"
case "\$1 \$2" in
  "release view") [ -f "$tmp/alias.json" ] ;;
  "release download") [ ! -f "$tmp/nodownload" ] || exit 1; while [ \$# -gt 0 ]; do [ "\$1" = -D ] && d="\$2"; shift; done; cp "$tmp/alias.json" "\$d/manifest.json" ;;
esac
STUB
chmod +x "$tmp/gh"
manifest() { printf '{"version":"%s"}' "$1" > "$tmp/manifest.json"; : > "$tmp/manifest.json.sig"; }
run() { : > "$tmp/calls"; PATH="$tmp:$PATH" sh "$here/update_alias.sh" channel-beta "$tmp/manifest.json" "$tmp/manifest.json.sig" > /dev/null; }

manifest 0.2.0-rc.1; rm -f "$tmp/alias.json"; run
grep -q "release create" "$tmp/calls" || { echo "FAIL: a missing alias was not created"; exit 1; }

printf '{"version":"0.2.0-rc.1"}' > "$tmp/alias.json"
manifest 0.2.0-rc.2; run
grep -q "release upload" "$tmp/calls" || { echo "FAIL: a newer beta did not replace the alias"; exit 1; }
manifest 0.2.0; run
grep -q "release upload" "$tmp/calls" || { echo "FAIL: the stable release did not replace its rc"; exit 1; }

printf '{"version":"0.2.0"}' > "$tmp/alias.json"
manifest 0.2.1-rc.1; run
grep -q "release upload" "$tmp/calls" || { echo "FAIL: the next rc is newer than the last stable"; exit 1; }
printf '{"version":"0.2.1-rc.1"}' > "$tmp/alias.json"
manifest 0.2.0; run
! grep -q "release upload\|release create" "$tmp/calls" || { echo "FAIL: an older stable rolled the alias back"; exit 1; }
manifest 0.2.1-rc.1; run
! grep -q "release upload" "$tmp/calls" || { echo "FAIL: the same version was uploaded again"; exit 1; }

# --resign: the same version with a later issue time replaces the alias; nothing else does
rrun() { : > "$tmp/calls"; PATH="$tmp:$PATH" sh "$here/update_alias.sh" --resign channel-beta "$tmp/manifest.json" "$tmp/manifest.json.sig" > /dev/null; }
printf '{"version":"0.2.1-rc.1","issued_at":100}' > "$tmp/alias.json"
printf '{"version":"0.2.1-rc.1","issued_at":200}' > "$tmp/manifest.json"
rrun; grep -q "release upload" "$tmp/calls" || { echo "FAIL: a re-sign did not replace the alias"; exit 1; }
printf '{"version":"0.2.1-rc.1","issued_at":100}' > "$tmp/manifest.json"
rrun; ! grep -q "release upload" "$tmp/calls" || { echo "FAIL: a re-sign with the same issue time was uploaded"; exit 1; }
printf '{"version":"0.2.1-rc.1","issued_at":300,"freeze":true}' > "$tmp/manifest.json"
! rrun || { echo "FAIL: a re-sign changed more than the issue time"; exit 1; }
printf '{"version":"0.2.2-rc.1","issued_at":300}' > "$tmp/manifest.json"
! rrun || { echo "FAIL: a re-sign moved a version"; exit 1; }
rm -f "$tmp/alias.json"; printf '{"version":"0.2.1-rc.1","issued_at":300}' > "$tmp/manifest.json"
! rrun || { echo "FAIL: a re-sign created an alias"; exit 1; }
# --resign never writes blind: when the alias's manifest cannot be read nothing is uploaded
printf '{"version":"0.2.1-rc.1","issued_at":100}' > "$tmp/alias.json"; printf '{"version":"0.2.1-rc.1","issued_at":900}' > "$tmp/manifest.json"
touch "$tmp/nodownload"
! rrun || { echo "FAIL: a re-sign was written without reading the alias"; exit 1; }
! grep -q "release upload" "$tmp/calls" || { echo "FAIL: a re-sign uploaded after a failed read"; exit 1; }
rm "$tmp/nodownload"
echo ok
