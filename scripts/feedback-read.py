#!/usr/bin/env python3
"""List and read feedback submissions in the private R2 bucket.

Uses the Cloudflare REST API (R2 objects) with an API token that has R2
read access (Python standard library only). Credentials come from files,
never from the command line:

  CF_API_TOKEN_FILE   API token
  CF_ACCOUNT_ID_FILE  account id

They default to api-token and account-id in CF_DIR (default
$XDG_RUNTIME_DIR/obpkg-cf).

  feedback-read.py list [--since 2026-10-01] [--kind bug] [--source web]
  feedback-read.py show ID            one submission (id, or its full key)
  feedback-read.py dump [--since D]   every submission as JSON lines
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BUCKET = os.environ.get("BUCKET", "basalt-feedback")
PREFIX = "submissions/"


def read_secret(env, default_name):
    cf_dir = os.environ.get("CF_DIR") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "obpkg-cf")
    path = os.environ.get(env) or os.path.join(cf_dir, default_name)
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError as e:
        sys.exit(f"feedback-read: cannot read {path}: {e.strerror}")


class R2:
    def __init__(self):
        account = read_secret("CF_ACCOUNT_ID_FILE", "account-id")
        self._token = read_secret("CF_API_TOKEN_FILE", "api-token")
        self.base = (f"https://api.cloudflare.com/client/v4/accounts/{account}"
                     f"/r2/buckets/{BUCKET}/objects")

    def _get(self, url):
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            sys.exit(f"feedback-read: HTTP {e.code} for {url.split('?')[0]}")

    def keys(self, start_after=""):
        cursor = None
        while True:
            q = {"prefix": PREFIX, "per_page": "1000"}
            if start_after:
                q["start_after"] = start_after
            if cursor:
                q["cursor"] = cursor
            page = json.loads(self._get(self.base + "?" + urllib.parse.urlencode(q)))
            for obj in page.get("result") or []:
                yield obj["key"]
            info = page.get("result_info") or {}
            cursor = info.get("cursor")
            if not info.get("is_truncated") or not cursor:
                return

    def submission(self, key):
        body = self._get(self.base + "/" + urllib.parse.quote(key, safe="/"))
        return None if body is None else json.loads(body)


def safe(text, keep=""):
    """Escape every non-printable character of text as \\uXXXX.

    Submissions are untrusted text. The Worker refuses control and bidi
    characters, but this reader is the second line of defense: whatever is
    stored, nothing reaches the operator's terminal as a raw control (C0,
    C1 such as U+009B CSI, bidi overrides, line separators). Characters in
    keep (newline for indented JSON) stay as they are. The escape is also
    valid inside a JSON string, so the JSON output stays parseable.
    """
    out = []
    for ch in text:
        if ch in keep or ch.isprintable():
            out.append(ch)
            continue
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            out.append(f"\\u{0xD800 + (cp >> 10):04x}\\u{0xDC00 + (cp & 0x3FF):04x}")
        else:
            out.append(f"\\u{cp:04x}")
    return "".join(out)


def key_for(ident):
    if ident.startswith(PREFIX):
        return ident
    # 20261004T153012Z-1a2b3c4d -> submissions/2026/10/04/<id>.json
    return f"{PREFIX}{ident[0:4]}/{ident[4:6]}/{ident[6:8]}/{ident}.json"


def selected(r2, args):
    start = ""
    if args.since:
        d = dt.date.fromisoformat(args.since)
        start = f"{PREFIX}{d:%Y/%m/%d}/"  # keys sort by date
    for key in r2.keys(start_after=start.rstrip("/") if start else ""):
        sub = r2.submission(key)
        if sub is None:
            continue
        if args.kind and sub.get("kind") != args.kind:
            continue
        if args.source and sub.get("source") != args.source:
            continue
        yield key, sub


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    for name in ("list", "dump"):
        s = sp.add_parser(name)
        s.add_argument("--since", help="YYYY-MM-DD (UTC)")
        s.add_argument("--kind", choices=["bug", "idea", "other"])
        s.add_argument("--source", choices=["web", "cli", "voice"])
    s = sp.add_parser("show")
    s.add_argument("id")
    args = p.parse_args()
    r2 = R2()

    if args.cmd == "show":
        sub = r2.submission(key_for(args.id))
        if sub is None:
            sys.exit(f"feedback-read: no submission {args.id}")
        print(safe(json.dumps(sub, indent=2, ensure_ascii=False), keep="\n"))
    elif args.cmd == "dump":
        for _, sub in selected(r2, args):
            print(safe(json.dumps(sub, ensure_ascii=False)))
    else:
        n = 0
        for _, sub in selected(r2, args):
            n += 1
            first = (sub.get("message") or "").splitlines()[0] if sub.get("message") else ""
            if len(first) > 70:
                first = first[:67] + "..."
            mail = "mail" if sub.get("email") else "    "
            sysinfo = "sys" if sub.get("system") else "   "
            line = f"{sub.get('id')}  {sub.get('kind')!s:<5} {sub.get('source')!s:<5} {mail} {sysinfo}  {first}"
            print(safe(line))
        print(f"{n} submission(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
