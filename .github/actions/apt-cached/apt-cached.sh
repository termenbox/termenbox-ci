#!/bin/sh
# apt-cached.sh key GROUP "PKGS"   : prints the cache key for a group of packages on this runner
# apt-cached.sh install "PKGS" HIT : installs the packages, from the restored .deb files when HIT is true, else with apt-get
# A run then does not depend on the Ubuntu mirrors once a run with the same packages has saved the files. Writes
# `saved=true` to $GITHUB_OUTPUT when it left .deb files in $APT_DEBS for the cache to save.
set -eu
out="${GITHUB_OUTPUT:-/dev/null}"
debs="${APT_DEBS:-$HOME/apt-debs}"
archives="${APT_ARCHIVES:-/var/cache/apt/archives}"
waits="${APT_WAITS:-0 10 30}"
sudo="${APT_SUDO-sudo}"

apt_install() {
  ok=0
  for wait in $waits; do
    sleep "$wait"
    # shellcheck disable=SC2086
    if $sudo apt-get update && $sudo apt-get install -y $1; then ok=1; break; fi
    # No Ubuntu host answered (the whole ubuntu.com zone can be down): take the next try from a mirror under another
    # name. apt still checks the signed Release files, so the host adds no trust.
    base=https://mirror.us.leaseweb.net/ubuntu/
    [ "$(dpkg --print-architecture)" = amd64 ] || base=https://mirror.us.leaseweb.net/ubuntu-ports/
    # shellcheck disable=SC2086
    $sudo sed -i -E "s#(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z0-9.-]*ubuntu\.com/ubuntu(-ports)?/)#$base#g" ${APT_SOURCES:-/etc/apt/sources.list /etc/apt/sources.list.d/*} 2>/dev/null || true
  done
  [ "$ok" = 1 ]
  mkdir -p "$debs"
  if ls "$archives"/*.deb >/dev/null 2>&1; then
    cp "$archives"/*.deb "$debs"/
    echo "saved=true" >> "$out"
  fi
}

case "$1" in
  key)
    # Job group, architecture, runner image (a new image starts a new entry) and packages.
    echo "key=apt-$2-$(uname -m)-${ImageVersion:-0}-$(echo "$3" | tr ' ' '-')" >> "$out"
    ;;
  install)
    # A restored set that does not install (a package it needs is missing) falls back to apt, which then saves anew.
    if [ "${3:-}" = true ] && $sudo dpkg -i "$debs"/*.deb; then exit 0; fi
    apt_install "$2"
    ;;
  *) echo "usage: apt-cached.sh key GROUP PKGS | install PKGS HIT" >&2; exit 2 ;;
esac
