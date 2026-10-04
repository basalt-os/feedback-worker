// Unit tests of the feedback Worker with an in-memory R2 bucket.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validate, LIMITS } from "../src/worker.js";

// memBucket is the part of the R2 binding the Worker uses.
function memBucket() {
  const m = new Map();
  return {
    m,
    async get(key) {
      if (!m.has(key)) return null;
      const { value } = m.get(key);
      return { text: async () => value, json: async () => JSON.parse(value) };
    },
    async put(key, value, opts = {}) {
      m.set(key, { value: String(value), opts });
    },
    submissions() {
      return [...m.entries()].filter(([k]) => k.startsWith("submissions/")).map(([, v]) => JSON.parse(v.value));
    },
  };
}

const SITE = "https://basalt-os.org";
const URL_ = "https://basalt-feedback.example.workers.dev/v1/feedback";
const NOW = new Date("2026-10-04T15:30:12.345Z");

function env(extra = {}) {
  return { FEEDBACK: memBucket(), ...extra };
}

function post(body, { origin = SITE, type = "application/json", ip = "203.0.113.7", headers = {} } = {}) {
  const h = { "Content-Type": type, "CF-Connecting-IP": ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request(URL_, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = { kind: "bug", message: "The installer froze on the disk step.", email: "me@example.org" };

test("a JSON submission from the site is stored and answered with its id", async () => {
  const e = env();
  const res = await handle(post(good), e, NOW);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.id, /^20261004T153012Z-[0-9a-f]{8}$/);
  const subs = e.FEEDBACK.submissions();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].id, body.id);
  assert.equal(subs[0].kind, "bug");
  assert.equal(subs[0].source, "web");
  assert.equal(subs[0].email, "me@example.org");
  assert.equal(subs[0].received_at, NOW.toISOString());
  const key = [...e.FEEDBACK.m.keys()].find((k) => k.startsWith("submissions/"));
  assert.equal(key, `submissions/2026/10/04/${body.id}.json`);
});

test("the stored record holds no IP address, user agent or other request data", async () => {
  const e = env();
  await handle(post(good, { headers: { "User-Agent": "Mozilla/5.0 test" } }), e, NOW);
  const raw = [...e.FEEDBACK.m.entries()].find(([k]) => k.startsWith("submissions/"))[1].value;
  assert.ok(!raw.includes("203.0.113.7"));
  assert.ok(!raw.includes("Mozilla"));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
    "client", "email", "id", "kind", "lang", "message", "received_at", "source", "system", "version",
  ]);
  // Nor anywhere else in the bucket.
  for (const [k, v] of e.FEEDBACK.m) {
    assert.ok(!k.includes("203.0.113.7") && !v.value.includes("203.0.113.7"), k);
  }
});

test("a plain form post is redirected to the thank-you page", async () => {
  const e = env();
  const form = new URLSearchParams({ kind: "idea", message: "Dark mode for the installer", email: "", website: "" });
  const res = await handle(post(form.toString(), { type: "application/x-www-form-urlencoded" }), e, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), `${SITE}/feedback/sent.html`);
  const [sub] = e.FEEDBACK.submissions();
  assert.equal(sub.kind, "idea");
  assert.equal(sub.email, null);
});

test("a form post with a problem is redirected to the problem page with the reason", async () => {
  const form = new URLSearchParams({ kind: "idea", message: "   " });
  const res = await handle(post(form.toString(), { type: "application/x-www-form-urlencoded" }), env(), NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), `${SITE}/feedback/problem.html?reason=empty_message`);
});

test("other origins are refused, for posts and preflights", async () => {
  const e = env();
  const res = await handle(post(good, { origin: "https://evil.example" }), e, NOW);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(e.FEEDBACK.submissions().length, 0);

  const pre = await handle(
    new Request(URL_, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }),
    e,
    NOW,
  );
  assert.equal(pre.status, 403);
  const ok = await handle(new Request(URL_, { method: "OPTIONS", headers: { Origin: SITE } }), e, NOW);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(ok.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});

test("a form post without an Origin header is refused", async () => {
  const form = new URLSearchParams({ kind: "bug", message: "x" });
  const res = await handle(post(form.toString(), { origin: null, type: "application/x-www-form-urlencoded" }), env(), NOW);
  assert.equal(res.status, 403);
});

test("the CLI posts JSON without an origin, with a structured system object", async () => {
  const e = env();
  const res = await handle(
    post(
      {
        kind: "bug",
        message: "basalt why nginx says unknown",
        source: "cli",
        client: "basalt-assistant/0.9.0",
        lang: "pt_BR",
        system: { os: { name: "Basalt OS", version: "44 (Basalt 0.0.1)" }, packages: ["basalt-assistant 0.9.0-1"] },
      },
      { origin: null },
    ),
    e,
    NOW,
  );
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  const [sub] = e.FEEDBACK.submissions();
  assert.equal(sub.source, "cli");
  assert.equal(sub.client, "basalt-assistant/0.9.0");
  assert.equal(sub.lang, "pt_BR");
  assert.equal(sub.system.os.name, "Basalt OS");
});

test("the site cannot send a structured system object or claim another source", async () => {
  const r1 = await handle(post({ ...good, system: { a: 1 } }), env(), NOW);
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "bad_system");
  const e = env();
  const r2 = await handle(post({ ...good, source: "cli" }), e, NOW);
  assert.equal(r2.status, 201);
  assert.equal(e.FEEDBACK.submissions()[0].source, "web");
});

test("the honeypot answers like a success and stores nothing", async () => {
  const e = env();
  const res = await handle(post({ ...good, website: "http://spam.example" }), e, NOW);
  assert.equal(res.status, 201);
  assert.equal(e.FEEDBACK.m.size, 0);
  const form = new URLSearchParams({ kind: "bug", message: "x", website: "spam" });
  const r2 = await handle(post(form.toString(), { type: "application/x-www-form-urlencoded" }), e, NOW);
  assert.equal(r2.status, 303);
  assert.equal(r2.headers.get("Location"), `${SITE}/feedback/sent.html`);
  assert.equal(e.FEEDBACK.m.size, 0);
});

test("validation: kind, message, e-mail, sizes and control characters", async () => {
  const cases = [
    [{ ...good, kind: "rant" }, "bad_kind"],
    [{ ...good, kind: undefined }, "bad_kind"],
    [{ ...good, message: "" }, "empty_message"],
    [{ ...good, message: 42 }, "bad_message"],
    [{ ...good, message: "a".repeat(LIMITS.message + 1) }, "message_too_long"],
    [{ ...good, message: "bell\u0007" }, "bad_message"],
    [{ ...good, email: "not-an-address" }, "bad_email"],
    [{ ...good, email: ["a@b.org"] }, "bad_email"],
    [{ ...good, system: "x".repeat(LIMITS.systemText + 1) }, "system_too_long"],
    [{ ...good, lang: "<script>" }, "bad_lang"],
    [{ ...good, client: "x".repeat(65) }, "bad_client"],
  ];
  for (const [body, code] of cases) {
    const res = await handle(post(body), env(), NOW);
    assert.equal(res.status, 400, code);
    assert.equal((await res.json()).error, code);
  }
  // A message at the limit in characters (not bytes) passes.
  const res = await handle(post({ ...good, message: "é".repeat(LIMITS.message) }), env(), NOW);
  assert.equal(res.status, 201);
});

test("a CLI system object over 16 KiB is refused", async () => {
  const res = await handle(
    post({ ...good, source: "cli", system: { blob: "x".repeat(LIMITS.systemJSON) } }, { origin: null }),
    env(),
    NOW,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "system_too_long");
});

test("bodies over 32 KiB, bad JSON and other content types are refused", async () => {
  const big = await handle(post({ ...good, message: "a".repeat(40000) }), env(), NOW);
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, "too_large");
  const bad = await handle(post("{not json"), env(), NOW);
  assert.equal((await bad.json()).error, "bad_json");
  const arr = await handle(post("[1,2]"), env(), NOW);
  assert.equal((await arr.json()).error, "bad_json");
  const plain = await handle(post("hello", { type: "text/plain" }), env(), NOW);
  assert.equal(plain.status, 415);
});

test("rate limit: five per address per hour, then 429 with Retry-After", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) {
    const res = await handle(post(good), e, NOW);
    assert.equal(res.status, 201, `submission ${i + 1}`);
  }
  const res = await handle(post(good), e, NOW);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "rate_limited");
  assert.equal(res.headers.get("Retry-After"), String(3600 - (30 * 60 + 12)));
  // Another address is not affected, nor the same address the next hour.
  assert.equal((await handle(post(good, { ip: "198.51.100.1" }), e, NOW)).status, 201);
  assert.equal((await handle(post(good), e, new Date("2026-10-04T16:00:01Z"))).status, 201);
  assert.equal(e.FEEDBACK.submissions().length, 7);
});

test("rate limit counters are named by a salted hash, and the salt changes daily", async () => {
  const e = env();
  await handle(post(good), e, NOW);
  await handle(post(good), e, new Date("2026-10-05T10:00:00Z"));
  const keys = [...e.FEEDBACK.m.keys()];
  const salts = keys.filter((k) => k.startsWith("meta/salt/"));
  assert.deepEqual(salts.sort(), ["meta/salt/2026-10-04", "meta/salt/2026-10-05"]);
  assert.notEqual(e.FEEDBACK.m.get(salts[0]).value, e.FEEDBACK.m.get(salts[1]).value);
  const counters = keys.filter((k) => /^ratelimit\/\d{4}-\d\d-\d\d\/\d\d\//.test(k));
  assert.equal(counters.length, 2);
  const [h1, h2] = counters.map((k) => k.split("/").pop());
  assert.match(h1, /^[0-9a-f]{32}$/);
  assert.notEqual(h1, h2); // same address, different day: unlinkable
});

test("the daily cap answers 503 busy", async () => {
  const e = env({ DAILY_CAP: "2", RATE_PER_HOUR: "100" });
  assert.equal((await handle(post(good), e, NOW)).status, 201);
  assert.equal((await handle(post(good, { ip: "198.51.100.2" }), e, NOW)).status, 201);
  const res = await handle(post(good, { ip: "198.51.100.3" }), e, NOW);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "busy");
});

test("several allowed origins can be configured for a local preview", async () => {
  const e = env({ ALLOWED_ORIGIN: "https://basalt-os.org http://localhost:8000" });
  const res = await handle(post(good, { origin: "http://localhost:8000" }), e, NOW);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
});

test("other paths and methods", async () => {
  const e = env();
  assert.equal((await handle(new Request(URL_, { method: "GET" }), e, NOW)).status, 405);
  assert.equal((await handle(new Request("https://x.example/v1/health"), e, NOW)).status, 200);
  assert.equal((await handle(new Request("https://x.example/"), e, NOW)).status, 200);
  assert.equal((await handle(new Request("https://x.example/admin"), e, NOW)).status, 404);
  assert.equal(e.FEEDBACK.m.size, 0);
});

test("validate trims and normalizes line endings", () => {
  const s = validate({ kind: "other", message: "  a\r\nb\rc  " }, { fromBrowser: true });
  assert.equal(s.message, "a\nb\nc");
  assert.equal(s.email, null);
  assert.equal(s.system, null);
});

// --- e-mail notification ---

class FakeEmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

function mailEnv(extra = {}) {
  const sent = [];
  return {
    sent,
    env: env({
      NOTIFY: {
        async send(m) {
          sent.push(m);
        },
      },
      NOTIFY_FROM: "feedback-bot@obpkg.org",
      NOTIFY_TO: "feedback@basalt-os.org",
      EmailMessage: FakeEmailMessage,
      ...extra,
    }),
  };
}

function decodeBody(raw) {
  const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, "");
  return Buffer.from(body, "base64").toString("utf8");
}

test("a stored submission is e-mailed, with the person's address as Reply-To", async () => {
  const { env: e, sent } = mailEnv();
  const res = await handle(post({ ...good, message: "Ação: o instalador travou.\nSegunda linha", system: "VM, 4 GiB" }), e, NOW);
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.from, "feedback-bot@obpkg.org");
  assert.equal(m.to, "feedback@basalt-os.org");
  const [head] = m.raw.split("\r\n\r\n");
  assert.match(head, /^From: Basalt OS feedback <feedback-bot@obpkg\.org>$/m);
  assert.match(head, /^To: <feedback@basalt-os\.org>$/m);
  assert.match(head, /^Reply-To: <me@example\.org>$/m);
  assert.match(head, new RegExp(`^Message-ID: <${id}@obpkg\\.org>$`, "m"));
  const subject = head.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m);
  assert.ok(subject, head);
  assert.equal(Buffer.from(subject[1], "base64").toString("utf8"), "[Basalt OS feedback] bug: Ação: o instalador travou.");
  const body = decodeBody(m.raw);
  assert.match(body, /Kind: bug/);
  assert.match(body, new RegExp(`Id: ${id}`));
  assert.match(body, /Ação: o instalador travou\.\r\nSegunda linha/);
  assert.match(body, /System:\r\n\r\nVM, 4 GiB/);
  assert.ok(!m.raw.includes("203.0.113.7"));
  for (const line of m.raw.split("\r\n")) assert.ok(line.length <= 998);
});

test("no Reply-To without an e-mail, and a structured system object is pretty-printed", async () => {
  const { env: e, sent } = mailEnv();
  await handle(post({ kind: "idea", message: "x", source: "cli", system: { os: { name: "Basalt OS" } } }, { origin: null }), e, NOW);
  assert.equal(sent.length, 1);
  assert.ok(!/^Reply-To:/m.test(sent[0].raw));
  assert.match(decodeBody(sent[0].raw), /"name": "Basalt OS"/);
});

test("a failing notification never loses or refuses the submission", async () => {
  const { env: e } = mailEnv({
    NOTIFY: {
      async send() {
        throw new Error("destination not verified");
      },
    },
  });
  const res = await handle(post(good), e, NOW);
  assert.equal(res.status, 201);
  assert.equal(e.FEEDBACK.submissions().length, 1);
});

test("the notification runs through waitUntil when the runtime gives a context", async () => {
  const { env: e, sent } = mailEnv();
  const pending = [];
  const res = await handle(post(good), e, NOW, { waitUntil: (p) => pending.push(p) });
  assert.equal(res.status, 201);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(sent.length, 1);
});

test("honeypot and refused submissions send no e-mail; no binding means no e-mail", async () => {
  const { env: e, sent } = mailEnv();
  await handle(post({ ...good, website: "x" }), e, NOW);
  await handle(post({ ...good, kind: "rant" }), e, NOW);
  assert.equal(sent.length, 0);
  const plain = env();
  assert.equal((await handle(post(good), plain, NOW)).status, 201);
});
