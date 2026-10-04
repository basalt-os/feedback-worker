#!/usr/bin/env python3
"""List and read feedback submissions in the private R2 bucket.

Uses R2's S3 API with a SigV4 signature (Python standard library only).
Credentials come from files, never from the command line:

  CF_ACCOUNT_ID_FILE        account id
  R2_ACCESS_KEY_ID_FILE     R2 S3 access key id
  R2_SECRET_ACCESS_KEY_FILE R2 S3 secret access key

They default to account-id, r2-access-key-id and r2-secret-access-key in
CF_DIR (default $XDG_RUNTIME_DIR/obpkg-cf).

  feedback-read.py list [--since 2026-10-01] [--kind bug] [--source web]
  feedback-read.py show ID            one submission (id, or its full key)
  feedback-read.py dump [--since D]   every submission as JSON lines
"""

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BUCKET = os.environ.get("BUCKET", "basalt-feedback")
PREFIX = "submissions/"
S3NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


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
        self.account = read_secret("CF_ACCOUNT_ID_FILE", "account-id")
        self.key_id = read_secret("R2_ACCESS_KEY_ID_FILE", "r2-access-key-id")
        self.secret = read_secret("R2_SECRET_ACCESS_KEY_FILE", "r2-secret-access-key")
        self.host = f"{self.account}.r2.cloudflarestorage.com"

    def _sign(self, method, path, query):
        now = dt.datetime.now(dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        day = now.strftime("%Y%m%d")
        payload = hashlib.sha256(b"").hexdigest()
        canon_query = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
            for k, v in sorted(query.items()))
        headers = {"host": self.host, "x-amz-content-sha256": payload, "x-amz-date": amz_date}
        signed = ";".join(sorted(headers))
        canon = "\n".join([
            method, urllib.parse.quote(path, safe="/-_.~"), canon_query,
            "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload])
        scope = f"{day}/auto/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope,
                             hashlib.sha256(canon.encode()).hexdigest()])
        k = ("AWS4" + self.secret).encode()
        for part in (day, "auto", "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={self.key_id}/{scope}, "
                                    f"SignedHeaders={signed}, Signature={sig}")
        url = f"https://{self.host}{urllib.parse.quote(path, safe='/-_.~')}"
        if canon_query:
            url += "?" + canon_query
        return url, headers

    def get(self, path, query=None):
        url, headers = self._sign("GET", path, query or {})
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            sys.exit(f"feedback-read: GET {path}: HTTP {e.code}")

    def keys(self, start_after=""):
        token = None
        while True:
            q = {"list-type": "2", "prefix": PREFIX}
            if start_after:
                q["start-after"] = start_after
            if token:
                q["continuation-token"] = token
            root = ET.fromstring(self.get(f"/{BUCKET}", q))
            for c in root.iter(f"{S3NS}Contents"):
                yield c.find(f"{S3NS}Key").text
            if root.findtext(f"{S3NS}IsTruncated") != "true":
                return
            token = root.findtext(f"{S3NS}NextContinuationToken")

    def submission(self, key):
        body = self.get(f"/{BUCKET}/{key}")
        return None if body is None else json.loads(body)


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
        print(json.dumps(sub, indent=2, ensure_ascii=False))
    elif args.cmd == "dump":
        for _, sub in selected(r2, args):
            print(json.dumps(sub, ensure_ascii=False))
    else:
        n = 0
        for _, sub in selected(r2, args):
            n += 1
            first = (sub.get("message") or "").splitlines()[0] if sub.get("message") else ""
            if len(first) > 70:
                first = first[:67] + "..."
            mail = "mail" if sub.get("email") else "    "
            sysinfo = "sys" if sub.get("system") else "   "
            print(f"{sub.get('id')}  {sub.get('kind'):<5} {sub.get('source'):<5} {mail} {sysinfo}  {first}")
        print(f"{n} submission(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
