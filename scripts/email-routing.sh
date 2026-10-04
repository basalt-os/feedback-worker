#!/usr/bin/env bash
# Cloudflare Email Routing for the feedback notification: the Worker sends
# from an address on ZONE (default obpkg.org) to a verified destination
# (default feedback@basalt-os.org).
#
#   scripts/email-routing.sh status    routing state of the zone, the destination's verification
#   scripts/email-routing.sh enable    turn on Email Routing for the zone (adds its MX and SPF records)
#   scripts/email-routing.sh add-destination
#                                      register the destination; Cloudflare e-mails it a
#                                      verification link that a person must open
#
# Needs an API token with Zone: Email Routing Rules: Edit (and Zone: Read)
# and Account: Email Routing Addresses: Edit. Credentials as in deploy.sh
# (CF_API_TOKEN_FILE, CF_ACCOUNT_ID_FILE, default CF_DIR).
set -euo pipefail

ZONE="${ZONE:-obpkg.org}"
DEST="${NOTIFY_TO:-feedback@basalt-os.org}"
CF_DIR="${CF_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/obpkg-cf}"
TOKEN_FILE="${CF_API_TOKEN_FILE:-$CF_DIR/api-token}"
ACCOUNT_FILE="${CF_ACCOUNT_ID_FILE:-$CF_DIR/account-id}"
ACCOUNT="$(tr -d '[:space:]' <"$ACCOUNT_FILE")"

work="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/feedback-email.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
( umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" >"$work/auth" )

API="https://api.cloudflare.com/client/v4"
cf() {
  local method="$1" path="$2"; shift 2
  local out
  out="$(curl -sS -X "$method" -H @"$work/auth" "$API$path" "$@")"
  if ! jq -e '.success == true' >/dev/null 2>&1 <<<"$out"; then
    echo "email-routing: $method $path failed:" >&2
    jq -c '.errors // .' <<<"$out" >&2 || echo "$out" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

zone_id() { cf GET "/zones?name=$ZONE" | jq -r '.result[0].id // empty'; }

case "${1:-status}" in
  status)
    z="$(zone_id)"
    [[ -n "$z" ]] || { echo "zone $ZONE not found" >&2; exit 1; }
    cf GET "/zones/$z/email/routing" | jq -c '.result | {zone: .name, enabled, status}'
    cf GET "/accounts/$ACCOUNT/email/routing/addresses" |
      jq -c --arg d "$DEST" '[.result[] | select(.email == $d) | {email, verified}]'
    ;;
  enable)
    z="$(zone_id)"
    cf POST "/zones/$z/email/routing/enable" -H 'Content-Type: application/json' --data '{}' |
      jq -c '.result | {zone: .name, enabled, status}'
    ;;
  add-destination)
    cf POST "/accounts/$ACCOUNT/email/routing/addresses" -H 'Content-Type: application/json' \
      --data "{\"email\":\"$DEST\"}" | jq -c '.result | {email, verified, created}'
    echo "Cloudflare sent a verification link to $DEST; it must be opened before the Worker can send."
    ;;
  *)
    echo "usage: $0 status | enable | add-destination" >&2
    exit 2
    ;;
esac
