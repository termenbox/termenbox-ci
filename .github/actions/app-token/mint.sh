#!/usr/bin/env bash
# Mints an installation token of a GitHub app for one repository: an RS256 app JWT, the repository's installation, then an
# access token limited to that repository and the permissions asked for. Reads APP_ID, APP_KEY (PEM), REPO (owner/name) and
# PERMISSIONS (JSON) from the environment; the key reaches openssl through a pipe, never a file or an argument. Prints the
# token only as the step output `token`, after masking it (or on stdout with MINT_STDOUT=1).
set -euo pipefail
set +x
api="${GITHUB_API_URL:-https://api.github.com}"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
[ -n "${APP_ID:-}" ] && [ -n "${APP_KEY:-}" ] || { echo "no app credentials"; exit 1; }
case "$APP_ID" in *[!0-9]*) echo "bad app id"; exit 1 ;; esac
case "$REPO" in */*) ;; *) echo "bad repository"; exit 1 ;; esac
now=$(date +%s)
head=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
body=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$head" "$body" | openssl dgst -sha256 -sign <(printf '%s\n' "$APP_KEY") | b64url)
jwt="$head.$body.$sig"
call() { # call <method> <url> [json body]; prints the body, fails on an HTTP error without echoing it
  local out
  out=$(curl -sS --fail-with-body -X "$1" -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    ${3:+-H "Content-Type: application/json" --data "$3"} "$2" 2>/dev/null) || { echo "github refused $1 ${2#"$api"} (check the app's installation and permissions)"; exit 1; }
  printf '%s' "$out"
}
inst=$(call GET "$api/repos/$REPO/installation" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
req=$(python3 -c 'import sys,json;print(json.dumps({"repositories":[sys.argv[1].split("/")[1]],"permissions":json.loads(sys.argv[2])}))' "$REPO" "$PERMISSIONS")
token=$(call POST "$api/app/installations/$inst/access_tokens" "$req" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$token" ] || { echo "no token returned"; exit 1; }
# MINT_STDOUT=1 (another action calling this script) prints the bare token and nothing else, for the caller to hold in a variable.
if [ "${MINT_STDOUT:-}" = 1 ]; then printf '%s' "$token"; exit 0; fi
echo "::add-mask::$token"
echo "token=$token" >> "${GITHUB_OUTPUT:?}"
echo "minted a token for $REPO"
