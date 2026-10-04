#!/usr/bin/env bash
# Deploy the feedback Worker with the Cloudflare API (no wrangler needed):
# create the private R2 bucket if missing, set its lifecycle rules, upload
# the Worker with its bindings and enable it on the account's workers.dev
# subdomain. Prints the endpoint URL.
#
# Credentials are read from files, never from the command line:
#   CF_API_TOKEN_FILE   API token (Workers Scripts: Edit, R2: Edit, Account Settings: Read)
#   CF_ACCOUNT_ID_FILE  account id
# Both default to files in CF_DIR (default $XDG_RUNTIME_DIR/obpkg-cf).
#
#   scripts/deploy.sh            deploy
#   scripts/deploy.sh --check    only show what exists (bucket, script, URL)
set -euo pipefail

cd "$(dirname "$0")/.."
NAME="${WORKER_NAME:-basalt-feedback}"
BUCKET="${BUCKET:-basalt-feedback}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://basalt-os.org}"
SITE_URL="${SITE_URL:-https://basalt-os.org}"
RATE_PER_HOUR="${RATE_PER_HOUR:-5}"
DAILY_CAP="${DAILY_CAP:-500}"
COMPAT_DATE="2026-09-01"

CF_DIR="${CF_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/obpkg-cf}"
TOKEN_FILE="${CF_API_TOKEN_FILE:-$CF_DIR/api-token}"
ACCOUNT_FILE="${CF_ACCOUNT_ID_FILE:-$CF_DIR/account-id}"
for f in "$TOKEN_FILE" "$ACCOUNT_FILE"; do
  [[ -r "$f" ]] || { echo "deploy: cannot read $f" >&2; exit 1; }
done
ACCOUNT="$(tr -d '[:space:]' <"$ACCOUNT_FILE")"
[[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo "deploy: the account id in $ACCOUNT_FILE does not look right" >&2; exit 1; }

# The token goes to curl in a header file (mode 0600), not in argv.
work="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/feedback-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
( umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" >"$work/auth" )

API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT"

# cf METHOD PATH [curl args]: prints the JSON answer; fails on success=false.
cf() {
  local method="$1" path="$2"; shift 2
  local out
  out="$(curl -sS -X "$method" -H @"$work/auth" "$API$path" "$@")"
  if ! jq -e '.success == true' >/dev/null 2>&1 <<<"$out"; then
    echo "deploy: $method $path failed:" >&2
    jq -c '.errors // .' <<<"$out" >&2 || echo "$out" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

subdomain() { cf GET /workers/subdomain | jq -r '.result.subdomain'; }

if [[ "${1:-}" == "--check" ]]; then
  cf GET "/r2/buckets/$BUCKET" | jq -c '{bucket: .result.name, created: .result.creation_date, location: .result.location}' || true
  cf GET "/workers/scripts/$NAME/subdomain" | jq -c '{workers_dev: .result.enabled}' || true
  echo "https://$NAME.$(subdomain).workers.dev/v1/feedback"
  exit 0
fi

# 1. The bucket (private: no public access, no custom domain).
if cf GET "/r2/buckets/$BUCKET" >/dev/null 2>&1; then
  echo "bucket $BUCKET exists"
else
  cf POST /r2/buckets -H 'Content-Type: application/json' --data "{\"name\":\"$BUCKET\"}" >/dev/null
  echo "bucket $BUCKET created"
fi

# 2. Lifecycle: rate-limit counters and the daily salts go after two days,
#    so an address hash cannot be linked to an address afterwards.
cf PUT "/r2/buckets/$BUCKET/lifecycle" -H 'Content-Type: application/json' --data @- >/dev/null <<'EOF'
{"rules": [
  {"id": "ratelimit-2d", "enabled": true, "conditions": {"prefix": "ratelimit/"},
   "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 172800}}},
  {"id": "salt-2d", "enabled": true, "conditions": {"prefix": "meta/salt/"},
   "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 172800}}}
]}
EOF
echo "lifecycle rules set (ratelimit/, meta/salt/: 2 days)"

# 3. The Worker, an ES module with its bindings.
jq -n --arg compat "$COMPAT_DATE" --arg bucket "$BUCKET" --arg origin "$ALLOWED_ORIGIN" \
  --arg site "$SITE_URL" --arg rate "$RATE_PER_HOUR" --arg cap "$DAILY_CAP" '{
  main_module: "worker.js",
  compatibility_date: $compat,
  bindings: [
    {type: "r2_bucket", name: "FEEDBACK", bucket_name: $bucket},
    {type: "plain_text", name: "ALLOWED_ORIGIN", text: $origin},
    {type: "plain_text", name: "SITE_URL", text: $site},
    {type: "plain_text", name: "RATE_PER_HOUR", text: $rate},
    {type: "plain_text", name: "DAILY_CAP", text: $cap}
  ]}' >"$work/metadata.json"
cf PUT "/workers/scripts/$NAME" \
  -F "metadata=@$work/metadata.json;type=application/json" \
  -F "worker.js=@src/worker.js;type=application/javascript+module" >/dev/null
echo "worker $NAME uploaded"

# 4. Serve it on workers.dev (no zone route), without preview URLs.
cf POST "/workers/scripts/$NAME/subdomain" -H 'Content-Type: application/json' \
  --data '{"enabled": true, "previews_enabled": false}' >/dev/null
url="https://$NAME.$(subdomain).workers.dev"
echo "endpoint: $url/v1/feedback"
