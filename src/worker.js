// Basalt OS feedback endpoint: a Cloudflare Worker that accepts feedback
// from the basalt-os.org form and from `basalt feedback` on Basalt OS, checks
// it, and stores each submission as one JSON object in a private R2 bucket.
//
// No third-party services, no cookies, no tracking. The client's IP address
// is never stored with a submission. For rate limiting only, a SHA-256 of
// the address with a random salt that changes every day is kept as the name
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

// Control characters other than tab and newline have no place in feedback.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
  if (email !== "" && (email.length > LIMITS.email || !EMAIL.test(email))) {
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
  const who = (await sha256(`${salt}|${ip}`)).slice(0, 32);
  const key = `ratelimit/${day}/${hour}/${who}`;
  const n = await readCount(bucket, key);
  if (n >= Number(conf(env, "RATE_PER_HOUR"))) {
    const retry = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
    throw new Refusal(429, "rate_limited", { "Retry-After": String(retry) });
  }
  await bucket.put(key, String(n + 1));
  await bucket.put(totalKey, String(total + 1));
}

// store writes one submission and returns its id.
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
  return id;
}

async function handlePost(request, env, now) {
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
    const id = await store(bucket, sub, now);
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

export async function handle(request, env, now = new Date()) {
  const url = new URL(request.url);
  if (url.pathname === PATH) {
    if (request.method === "POST") return handlePost(request, env, now);
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
  fetch(request, env) {
    return handle(request, env);
  },
};
