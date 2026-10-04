# feedback-worker

Endpoint: `https://basalt-feedback.openbasalt.workers.dev/v1/feedback`

The endpoint behind the feedback form on [basalt-os.org](https://basalt-os.org)
and the `basalt feedback` command on Basalt OS. It is a single Cloudflare
Worker in plain JavaScript, with no dependencies, that checks each
submission and stores it as one JSON object in a private R2 bucket.

## What it stores, and what it does not

Each submission is one object, `submissions/YYYY/MM/DD/<id>.json`:

```json
{
  "version": 1,
  "id": "20261004T153012Z-1a2b3c4d",
  "received_at": "2026-10-04T15:30:12.345Z",
  "kind": "bug",
  "message": "The installer froze on the disk step.",
  "email": null,
  "system": null,
  "source": "web",
  "client": null,
  "lang": null
}
```

- `kind` is `bug`, `idea` or `other`; `message` is what the person wrote;
  `email` only if they gave one, for a reply; `system` only if they added
  it (free text from the form, or the parts of the report the person
  accepted in `basalt feedback`); `source` is `web`, `cli` or `voice`;
  `client` and `lang` are what the command line sends about itself.
- No IP address, user agent, referrer, cookie or any other request data is
  stored with a submission. The Worker sets no cookies and calls no other
  service.
- Rate limiting needs to tell senders apart for a while. The Worker keeps,
  for each sender and hour, a small counter object whose name is a SHA-256
  of the address with a random salt that changes every day. The bucket's
  lifecycle rules delete the counters and the salts after two days; after
  that, nobody can link a counter to an address.

## E-mail notification

With a `send_email` binding `NOTIFY` and the variables `NOTIFY_FROM` and
`NOTIFY_TO`, each stored submission is also sent as a plain-text e-mail
through Cloudflare Email Routing: from `feedback-bot@obpkg.org` to the
verified address `feedback@basalt-os.org`, with the kind, the message, the
system details, the id and, when the person gave an e-mail, a `Reply-To`
so the team can answer directly. User text goes into headers only as
encoded words, so it cannot add headers. The e-mail is sent after the
submission is stored and after the answer (`waitUntil`); if it fails, the
failure is logged and the submission stays stored. No IP address or other
request data is in it.

Setup, once: `scripts/email-routing.sh enable` (Email Routing on the
sending zone, which adds its MX and SPF records), `scripts/email-routing.sh
add-destination` (Cloudflare e-mails a verification link to the
destination), and after the link is opened, `NOTIFY=1 scripts/deploy.sh`.

## API

`POST /v1/feedback`

| Field | Rules |
|---|---|
| `kind` | `bug`, `idea` or `other` (required) |
| `message` | 1 to 5000 characters after trimming (required) |
| `email` | optional, up to 254 characters |
| `system` | optional: text up to 4000 characters, or (command line only) a JSON object up to 16 KiB |
| `source` | command line only: `cli` (default) or `voice` |
| `client`, `lang` | optional, short (`basalt-assistant/0.9.0`, `pt_BR`) |
| `website` | must stay empty (a field hidden from people; bots fill it) |

- From a browser, the `Origin` must be `https://basalt-os.org`; CORS answers
  only that origin. Requests without an `Origin` (the command line) must be
  JSON.
- JSON in, JSON out: `201 {"ok": true, "id": "ID"}`, or an error with a
  stable code that clients translate: `400 {"ok": false, "error":
  "empty_message"}`. Codes: `bad_kind`, `bad_message`, `empty_message`,
  `message_too_long`, `bad_email`, `bad_system`, `system_too_long`,
  `bad_source`, `bad_client`, `bad_lang`, `bad_json`, `bad_encoding`,
  `too_large` (413, body over 32 KiB), `content_type` (415), `origin`
  (403), `rate_limited` (429, with `Retry-After`), `busy` (503, the daily
  total is reached).
- A plain form post (`application/x-www-form-urlencoded`, works without
  JavaScript) is answered with a redirect to `/feedback/sent.html` on the
  site, or to `/feedback/problem.html?reason=CODE`.
- Limits: 5 submissions per sender per hour, 500 per day in total
  (`RATE_PER_HOUR`, `DAILY_CAP`).

`GET /v1/health` answers `{"ok": true}`.

## Test

```sh
node --test test/*.test.js                     # unit tests, an in-memory bucket
npx wrangler@4 dev --local            # the Worker with a local R2 (miniflare)
```

## Deploy

`scripts/deploy.sh` uses the Cloudflare API directly (curl and jq, no
wrangler): it creates the private bucket `basalt-feedback` if it is
missing, sets the lifecycle rules, uploads the Worker with its bindings and
serves it on the account's workers.dev subdomain (created as `openbasalt`
when the account has none). It reads the API token
and the account id from files (`CF_API_TOKEN_FILE`, `CF_ACCOUNT_ID_FILE`),
never from the command line. `scripts/deploy.sh --check` shows what exists.

## Read submissions

`scripts/feedback-read.py` (Python standard library only) reads the bucket
through the Cloudflare REST API with an API token that can read R2, from
files (`CF_API_TOKEN_FILE`, `CF_ACCOUNT_ID_FILE`):

```sh
scripts/feedback-read.py list --since 2026-10-01
scripts/feedback-read.py show 20261004T153012Z-1a2b3c4d
scripts/feedback-read.py dump --kind bug > bugs.jsonl
```

Bug reports are evidence for the project's lab, not knowledge by
themselves: a fix is reproduced and verified before anything learned from a
report reaches a Basalt OS package.

## License

Apache License 2.0, see [LICENSE](LICENSE).
