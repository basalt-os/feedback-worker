// Basalt OS feedback endpoint: a Cloudflare Worker that accepts feedback
// from the basalt-os.org form and from `basalt feedback` on Basalt OS, checks
// it, and stores each submission as one JSON object in a private R2 bucket.
//
// No third-party services, no cookies, no tracking. The client's IP address
// is never stored with a submission. For rate limiting only, a SHA-256 of
// the address (an IPv6 address by its /64) with a random salt that changes every day is kept as the name
// of a small counter object; the bucket's lifecycle rules delete the salts
// and the counters after two days, after which the hashes cannot be linked
// to an address any more.
//
// Endpoints:
//   POST    /v1/feedback   JSON (the site's script, the CLI) or a plain form post
//   OPTIONS /v1/feedback   CORS preflight, for the site's origin only
//   GET     /v1/health     {"ok": true}
//   GET     /              a short plain-text description

export const KINDS = ["bug", "idea", "other"];
export const SOURCES = ["web", "cli", "voice"];

export const LIMITS = {
  body: 32 * 1024, // bytes of the request body
  message: 5000, // characters
  email: 254,
  systemText: 4000, // characters of the form's free-text system field
  systemJSON: 16 * 1024, // bytes of a structured system object (CLI)
  client: 64,
  lang: 35,
};

const DEFAULTS = {
  ALLOWED_ORIGIN: "https://basalt-os.org",
  SITE_URL: "https://basalt-os.org",
  RATE_PER_HOUR: "5", // submissions per address per hour
  DAILY_CAP: "500", // submissions per day in total
};

const PATH = "/v1/feedback";

// conf returns a setting from the Worker's environment or its default.
function conf(env, name) {
  const v = env && env[name];
  return typeof v === "string" && v !== "" ? v : DEFAULTS[name];
}

// allowedOrigins: ALLOWED_ORIGIN may list several, separated by spaces or
// commas (a local preview in development); production has one.
function allowedOrigins(env) {
  return conf(env, "ALLOWED_ORIGIN")
    .split(/[\s,]+/)
    .filter(Boolean);
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function corsHeaders(origin) {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: location } });
}

// A validation or policy failure: a stable machine code (clients translate
// it) and the HTTP status.
class Refusal extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// readBody reads at most LIMITS.body bytes.
async function readBody(request) {
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > LIMITS.body) throw new Refusal(413, "too_large");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > LIMITS.body) throw new Refusal(413, "too_large");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Refusal(400, "bad_encoding");
  }
}

const chars = (s) => [...s].length;

// Control characters other than tab and newline have no place in feedback:
// C0 controls, DEL, C1 controls (U+0080 to U+009F; a terminal may act on
// U+009B CSI or U+009D OSC when an operator reads the feedback), and the
// bidirectional overrides and isolates (U+202A to U+202E, U+2066 to
// U+2069), which can make text read differently from what it is.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// hasControl reports whether any string inside v (object keys included)
// holds a refused character. It walks the value without recursion, so a
// deeply nested object cannot exhaust the stack.
function hasControl(v) {
  const stack = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") {
      if (CONTROL.test(x)) return true;
    } else if (Array.isArray(x)) {
      stack.push(...x);
    } else if (x && typeof x === "object") {
      for (const [k, val] of Object.entries(x)) {
        if (CONTROL.test(k)) return true;
        stack.push(val);
      }
    }
  }
  return false;
}

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/;
const CLIENT = /^[A-Za-z0-9._/+ -]+$/;
const LANG = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/;

// validate turns raw fields into a submission, or throws a Refusal.
// fields: kind, message, email, system, client, lang, source (strings,
// except system, which may be an object from the CLI).
export function validate(fields, { fromBrowser }) {
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : null);
  // opt reads an optional string field; another type is refused.
  const opt = (name, code) => {
    const v = fields[name];
    if (v == null) return "";
    if (typeof v !== "string") throw new Refusal(400, code);
    return v.trim();
  };

  const kind = str(fields.kind);
  if (kind === null || !KINDS.includes(kind)) throw new Refusal(400, "bad_kind");

  let message = str(fields.message);
  if (message === null) throw new Refusal(400, "bad_message");
  message = message.replace(/\r\n?/g, "\n").trim();
  if (message === "") throw new Refusal(400, "empty_message");
  if (chars(message) > LIMITS.message) throw new Refusal(400, "message_too_long");
  if (CONTROL.test(message)) throw new Refusal(400, "bad_message");

  const email = opt("email", "bad_email");
  if (email !== "" && (email.length > LIMITS.email || !EMAIL.test(email) || CONTROL.test(email))) {
    throw new Refusal(400, "bad_email");
  }

  let system = null;
  const rawSystem = fields.system;
  if (typeof rawSystem === "string") {
    const s = rawSystem.replace(/\r\n?/g, "\n").trim();
    if (chars(s) > LIMITS.systemText) throw new Refusal(400, "system_too_long");
    if (CONTROL.test(s)) throw new Refusal(400, "bad_system");
    system = s === "" ? null : s;
  } else if (rawSystem && typeof rawSystem === "object" && !Array.isArray(rawSystem) && !fromBrowser) {
    const s = JSON.stringify(rawSystem);
    if (new TextEncoder().encode(s).byteLength > LIMITS.systemJSON) {
      throw new Refusal(400, "system_too_long");
    }
    if (hasControl(rawSystem)) throw new Refusal(400, "bad_system");
    system = rawSystem;
  } else if (rawSystem != null) {
    throw new Refusal(400, "bad_system");
  }

  // The source: a browser on the site is always "web"; other clients say
  // cli or voice (the future voice action of the Basalt shell).
  let source = "web";
  if (!fromBrowser) {
    source = opt("source", "bad_source") || "cli";
    if (!SOURCES.includes(source) || source === "web") throw new Refusal(400, "bad_source");
  }

  const client = opt("client", "bad_client");
  if (client !== "" && (client.length > LIMITS.client || !CLIENT.test(client))) {
    throw new Refusal(400, "bad_client");
  }
  const lang = opt("lang", "bad_lang");
  if (lang !== "" && (lang.length > LIMITS.lang || !LANG.test(lang))) {
    throw new Refusal(400, "bad_lang");
  }

  return {
    kind,
    message,
    email: email || null,
    system,
    source,
    client: client || null,
    lang: lang || null,
  };
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

// dailySalt returns today's random salt, creating it on first use. Two
// requests racing at midnight may each write one; the last write wins and
// at worst a counter starts again, which only loosens the limit briefly.
async function dailySalt(bucket, day) {
  const key = `meta/salt/${day}`;
  const got = await bucket.get(key);
  if (got) return (await got.text()).trim();
  const salt = randomHex(32);
  await bucket.put(key, salt);
  const again = await bucket.get(key);
  return again ? (await again.text()).trim() : salt;
}

async function readCount(bucket, key) {
  const got = await bucket.get(key);
  if (!got) return 0;
  const n = parseInt(await got.text(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// rateSubject returns what the hourly limit counts: an IPv4 address as it
// is, an IPv6 address by its /64 network (one customer or VPS usually gets
// a whole /64, so counting single IPv6 addresses would let one client
// rotate through them and use up the daily cap), and "invalid" for
// anything that is not an address, so it does not get a fresh counter per
// spelling.
export function rateSubject(ip) {
  const s = String(ip || "").trim().replace(/%.*$/, "").toLowerCase();
  const v4 = (t) => {
    const parts = t.split(".");
    if (parts.length !== 4) return null;
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    }
    return parts.map(Number).join(".");
  };
  if (!s.includes(":")) return v4(s) || "invalid";

  const halves = s.split("::");
  if (halves.length > 2) return "invalid";
  const groups = (part) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // An embedded IPv4 address (::ffff:192.0.2.1) is the last two groups.
  const all = halves.length === 2 ? tail : head;
  const last = all[all.length - 1];
  if (last && last.includes(".")) {
    const a = v4(last);
    if (!a) return "invalid";
    const n = a.split(".").map(Number);
    all.splice(all.length - 1, 1, ((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16));
  }
  const given = head.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return "invalid";
  const full = [...head, ...Array(8 - given).fill("0"), ...tail];
  if (!full.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return "invalid";
  const nums = full.map((g) => parseInt(g, 16));
  // IPv4-mapped: count it as the IPv4 address.
  if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) {
    return [nums[6] >> 8, nums[6] & 255, nums[7] >> 8, nums[7] & 255].join(".");
  }
  return nums.slice(0, 4).map((n) => n.toString(16)).join(":") + "::/64";
}

// rateLimit counts the submission against the address's hourly limit and
// the daily total, or throws a Refusal. R2 has no atomic increment, so the
// counts are approximate under concurrency; that is enough here.
async function rateLimit(bucket, env, ip, now) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const hour = iso.slice(11, 13);

  const totalKey = `ratelimit/${day}/total`;
  const total = await readCount(bucket, totalKey);
  if (total >= Number(conf(env, "DAILY_CAP"))) throw new Refusal(503, "busy", { "Retry-After": "3600" });

  const salt = await dailySalt(bucket, day);
  const who = (await sha256(`${salt}|${rateSubject(ip)}`)).slice(0, 32);
  const key = `ratelimit/${day}/${hour}/${who}`;
  const n = await readCount(bucket, key);
  if (n >= Number(conf(env, "RATE_PER_HOUR"))) {
    const retry = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
    throw new Refusal(429, "rate_limited", { "Retry-After": String(retry) });
  }
  await bucket.put(key, String(n + 1));
  await bucket.put(totalKey, String(total + 1));
}

// store writes one submission and returns the stored record.
async function store(bucket, sub, now) {
  const iso = now.toISOString();
  const stamp = iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261004T153012Z
  const id = `${stamp}-${randomHex(4)}`;
  const key = `submissions/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${id}.json`;
  const record = { version: 1, id, received_at: iso, ...sub };
  await bucket.put(key, JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { kind: sub.kind, source: sub.source },
  });
  return record;
}

// --- E-mail notification (optional) ---------------------------------------
//
// With a send_email binding NOTIFY and the variables NOTIFY_FROM and
// NOTIFY_TO, every stored submission is also sent as a plain-text e-mail
// (Cloudflare Email Routing). It runs after the submission is stored and
// after the answer, through waitUntil: a failure is logged and never loses
// or refuses a submission. The person's e-mail, when given, becomes the
// Reply-To. No IP address or other request data is in the message.

// b64 encodes UTF-8 text as base64.
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// encodeHeader returns an RFC 2047 encoded word for any text, so user text
// can never break out of a header line.
function encodeHeader(text) {
  return `=?UTF-8?B?${b64(text)}?=`;
}

const KIND_LABEL = { bug: "bug", idea: "idea", other: "other" };

// notificationText is the plain-text body of the notification.
export function notificationText(record) {
  const lines = [
    `Kind: ${KIND_LABEL[record.kind] || record.kind}`,
    `Source: ${record.source}`,
    `Received: ${record.received_at}`,
    `Id: ${record.id}`,
  ];
  if (record.email) lines.push(`Reply to: ${record.email}`);
  if (record.client) lines.push(`Client: ${record.client}`);
  if (record.lang) lines.push(`Language: ${record.lang}`);
  lines.push("", "Message:", "", record.message);
  if (record.system) {
    lines.push("", "System:", "");
    lines.push(typeof record.system === "string" ? record.system : JSON.stringify(record.system, null, 2));
  }
  lines.push("", "--", "Basalt OS feedback endpoint. The submission is stored in the basalt-feedback bucket.");
  return lines.join("\r\n").replace(/\r?\n/g, "\r\n");
}

// notificationMIME builds the raw message (RFC 5322, base64 body).
export function notificationMIME(record, { from, to, now = new Date() }) {
  const first = record.message.split("\n")[0];
  const short = [...first].length > 60 ? [...first].slice(0, 60).join("") + " (more)" : first;
  const domain = from.split("@")[1] || "localhost";
  const headers = [
    `From: Basalt OS feedback <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(`[Basalt OS feedback] ${record.kind}: ${short}`)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${record.id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  if (record.email) headers.push(`Reply-To: <${record.email}>`);
  const body = b64(notificationText(record)).replace(/.{76}/g, "$&\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + body + "\r\n";
}

// notify sends the notification when it is configured. EmailMessage comes
// from the Workers runtime (cloudflare:email); tests pass their own.
async function notify(env, record, now) {
  const from = env && env.NOTIFY_FROM;
  const to = env && env.NOTIFY_TO;
  if (!env || !env.NOTIFY || !from || !to) return false;
  try {
    const EmailMessage = env.EmailMessage || (await import("cloudflare:email")).EmailMessage;
    await env.NOTIFY.send(new EmailMessage(from, to, notificationMIME(record, { from, to, now })));
    return true;
  } catch (e) {
    console.error("feedback: notification failed for", record.id, e && e.message);
    return false;
  }
}

async function handlePost(request, env, now, ctx) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const site = conf(env, "SITE_URL").replace(/\/+$/, "");
  const fromBrowser = origin !== null;
  if (fromBrowser && !allowed.includes(origin)) {
    return json(403, { ok: false, error: "origin" });
  }
  const cors = fromBrowser ? corsHeaders(origin) : {};

  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const isForm = type === "application/x-www-form-urlencoded";
  if (!isForm && type !== "application/json") {
    return json(415, { ok: false, error: "content_type" }, cors);
  }
  // A plain form post (no script) comes only from the site's page.
  if (isForm && !fromBrowser) return json(403, { ok: false, error: "origin" });

  const fail = (status, code, extra = {}) =>
    isForm
      ? redirect(`${site}/feedback/problem.html?reason=${encodeURIComponent(code)}`)
      : json(status, { ok: false, error: code }, { ...cors, ...extra });

  try {
    const body = await readBody(request);
    let fields;
    if (isForm) {
      fields = Object.fromEntries(new URLSearchParams(body));
    } else {
      try {
        fields = JSON.parse(body);
      } catch {
        throw new Refusal(400, "bad_json");
      }
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Refusal(400, "bad_json");
    }

    // Honeypot: a field people never see. A bot that fills it gets a
    // normal answer and nothing is stored.
    if (typeof fields.website === "string" && fields.website.trim() !== "") {
      return isForm ? redirect(`${site}/feedback/sent.html`) : json(201, { ok: true, id: "accepted" }, cors);
    }

    const sub = validate(fields, { fromBrowser });
    const bucket = env.FEEDBACK;
    if (!bucket) throw new Refusal(500, "not_configured");
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    await rateLimit(bucket, env, ip, now);
    const record = await store(bucket, sub, now);
    const id = record.id;
    const sent = notify(env, record, now);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(sent);
    else await sent;
    return isForm ? redirect(`${site}/feedback/sent.html`) : json(201, { ok: true, id }, cors);
  } catch (e) {
    if (e instanceof Refusal) return fail(e.status, e.code, e.extra);
    console.error("feedback: unexpected error", e && e.message);
    return fail(500, "internal");
  }
}

function handleOptions(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) {
    return new Response(null, { status: 403, headers: BASE_HEADERS });
  }
  return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...corsHeaders(origin) } });
}

export async function handle(request, env, now = new Date(), ctx = undefined) {
  const url = new URL(request.url);
  if (url.pathname === PATH) {
    if (request.method === "POST") return handlePost(request, env, now, ctx);
    if (request.method === "OPTIONS") return handleOptions(request, env);
    return json(405, { ok: false, error: "method" }, { Allow: "POST, OPTIONS" });
  }
  if (url.pathname === "/v1/health" && request.method === "GET") return json(200, { ok: true });
  if (url.pathname === "/" && request.method === "GET") {
    return text(
      200,
      "Basalt OS feedback endpoint. Send feedback from https://basalt-os.org/#feedback or with `basalt feedback` on Basalt OS.\n",
    );
  }
  return json(404, { ok: false, error: "not_found" });
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, new Date(), ctx);
  },
};
