export function slugify(value, max = 60) {
  return String(value || "name")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, max);
}

export function text(value, max = 800) {
  return String(value ?? "").trim().slice(0, max);
}

export function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function now() {
  return new Date().toISOString();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const cut = part.trim();
    if (!cut) continue;
    const eq = cut.indexOf("=");
    if (eq < 0) continue;
    out[cut.slice(0, eq)] = decodeURIComponent(cut.slice(eq + 1));
  }
  return out;
}

export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

const buckets = new Map();

export function rateLimit(key, max, windowMs) {
  const stamp = Date.now();
  const row = buckets.get(key) || { count: 0, start: stamp };
  if (stamp - row.start > windowMs) {
    row.count = 0;
    row.start = stamp;
  }
  row.count += 1;
  buckets.set(key, row);
  return row.count <= max;
}

export function safeUrl(value) {
  const raw = text(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return "";
    if (/^(10|127|169\.254)\./.test(host) || host.startsWith("192.168.") || host.startsWith("172.")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function send(res, code, body, origin) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  res.end(JSON.stringify(body));
}

export function fail(res, origin, code, errorCode, message) {
  return send(res, code, { success: false, code: errorCode, error: message }, origin);
}
