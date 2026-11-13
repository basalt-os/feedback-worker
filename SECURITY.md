# Security policy

This Worker receives feedback from anyone on the internet and stores it in
a private bucket, sometimes with an e-mail address the person chose to
give. Submissions are kept 180 days and then deleted by a lifecycle rule
on the bucket (see "What it stores" in the README). A way to read or
change stored submissions, to learn a sender's IP address, to inject
headers into the notification e-mail, to get around the
origin and rate limits, or to reach the operator's terminal through a
submission is a security problem. Please report it privately and give us
time to fix it before it is disclosed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/basalt-os/feedback-worker/security/advisories/new>
(the "Report a vulnerability" button under the Security tab). If you cannot
use GitHub, write to security@openbasalt.org.

Do not open a public issue, pull request or discussion for a security
problem, and do not send a test submission that holds someone else's
personal data. If the problem is in another part of Basalt OS (the
`basalt feedback` command, the system assistant, the installer), report it
in [basalt-os/basalt-os](https://github.com/basalt-os/basalt-os), or here
if you are not sure: we move reports between repositories.

Please include what you can of:

- the commit of this repository, or the date you saw the behavior on the
  public endpoint;
- the request you sent (method, headers, body), with any personal data
  removed;
- what an attacker gains, and who the attacker is (anyone on the internet,
  a page on another origin, a person with access to the bucket);
- whether you want to be credited, and how.

We aim to acknowledge a report within 7 days and to agree on a disclosure
date with you, normally within 90 days of the report or when a fix is
deployed, whichever comes first. Fixes are deployed to the endpoint and
published with a GitHub security advisory (and a CVE when it applies).

## Supported versions

Only the code on `main`, which is what the endpoint runs, receives
security fixes.

## Scope

In scope: the Worker (`src/worker.js`), its configuration
(`wrangler.toml`) and the scripts in `scripts/` (deployment, Email Routing
setup and the submission reader).

Out of scope, report upstream: the Cloudflare Workers runtime, R2 and Email
Routing, and volumetric denial of service against Cloudflare. Reaching the
daily total (`DAILY_CAP`) with many senders is a documented limit of the
design, not a vulnerability by itself, but a way for one sender to reach it
is.
