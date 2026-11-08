#!/bin/sh
# check_not_frozen.sh with a stub gh: a frozen channel refuses a release that would not replace the freeze.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/gh" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "release view") [ -f "$tmp/manifest.json" ] && echo tag || { echo "release not found"; exit 1; } ;;
  "release download") while [ \$# -gt 0 ]; do [ "\$1" = -D ] && d="\$2"; shift; done; cp "$tmp/manifest.json" "\$d/manifest.json" ;;
esac
STUB
chmod +x "$tmp/gh"
check() { PATH="$tmp:$PATH" sh "$here/check_not_frozen.sh" "$1" "$2" >/dev/null 2>&1; }
check beta 0.3.0-rc.1 || { echo "FAIL: a channel with no release was treated as frozen"; exit 1; }
printf '{"version":"0.2.1","freeze":false}' > "$tmp/manifest.json"
check stable 0.2.0 || { echo "FAIL: a channel that is not frozen refused a release"; exit 1; }
printf '{"version":"0.2.1","freeze":true}' > "$tmp/manifest.json"
! check stable 0.2.1 || { echo "FAIL: a frozen channel took a release that does not replace the freeze"; exit 1; }
check stable 0.2.2 || { echo "FAIL: a release newer than the freeze was refused"; exit 1; }
! check other 0.2.2 || { echo "FAIL: an unknown channel passed"; exit 1; }
echo ok
