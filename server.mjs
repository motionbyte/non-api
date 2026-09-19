import { createServer } from "node:http";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { slugify, text, id, now, parseCookies, clientIp, rateLimit, safeUrl, readBody, send, fail } from "./lib/util.mjs";
import { PERMISSIONS, can, isMod, canDirectPublish, publicUser, publicProfile } from "./lib/rbac.mjs";
import { diffSnapshots } from "./lib/diff.mjs";
import {
  CATEGORIES,
  parseAchievements,
  parseReferences,
  snapshot,
  writeCopy,
  draftRecord,
  publicRecord,
  isFeatured,
  matchesField,
  matchesQuery,
  sortOrganic,
  similarRecords,
  filingTooThin,
} from "./lib/copy.mjs";
import { load, save, uniqueUsername, audit, notify, notifyWatchers, activeBlock, settings } from "./lib/store.mjs";
import { announcePage } from "./lib/indexnow.mjs";

const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT || 4010);
const ORIGIN = process.env.WEB_ORIGIN || "http://127.0.0.1:3010";
const SESSION_DAYS = 30;
const json = (res, code, body) => send(res, code, body, ORIGIN);
const deny = (res, code, errorCode, message) => fail(res, ORIGIN, code, errorCode, message);

const SKUS = {
  featured: {
    id: "featured",
    name: "Featured",
    label: "$99/yr",
    cents: 9900,
    blurb: "Labeled Sponsored slot on this desk. Does not change ranking or verified.",
  },
};

const SEED_USERS =
  process.env.NODE_ENV === "production"
    ? []
    : [
        { email: "desk@namesofnote.com", name: "The Desk", role: "desk", password: "DeskNote26!" },
        { email: "moderator@namesofnote.com", name: "Community Moderator", role: "moderator", password: "NoteMod26!" },
      ];

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const buf = await scryptAsync(password, salt, 64);
  return { hash: Buffer.from(buf).toString("hex"), salt };
}

async function checkPassword(password, hash, salt) {
  const buf = await scryptAsync(password, salt, 64);
  const left = Buffer.from(buf);
  const right = Buffer.from(hash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie).non_session || "";
}

function sessionUser(db, req) {
  const token = sessionToken(req);
  if (!token) return null;
  const session = db.sessions.find((row) => row.token === token && new Date(row.expiresAt).getTime() > Date.now());
  if (!session) return null;
  const user = db.users.find((row) => row.id === session.userId && !row.deletedAt);
  return user || null;
}

function createdByUser(db, user) {
  return db.records.find((row) => (row.createdBy === user.id || row.ownerUserId === user.id) && row.status !== "rejected" && row.status !== "deleted") || null;
}

async function createSession(db, user, req) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.sessions.push({
    id: id("sess"),
    token,
    userId: user.id,
    expiresAt,
    ip: clientIp(req),
    createdAt: now(),
  });
  await save(db);
  return token;
}

function requireUser(db, req, res) {
  const user = sessionUser(db, req);
  if (!user) {
    deny(res, 401, "AUTH_REQUIRED", "Sign in.");
    return null;
  }
  return user;
}

function requirePerm(user, res, permission, message) {
  if (!can(user, permission)) {
    deny(res, 403, "PERMISSION_DENIED", message || "You do not have permission.");
    return false;
  }
  return true;
}

function recordBySlug(db, slug) {
  return db.records.find((row) => row.slug === slug && row.status !== "deleted") || null;
}

function appendRevision(db, record, { authorId, summary, status, parentRevisionId }) {
  const revision = {
    id: id("rev"),
    articleId: record.id,
    slug: record.slug,
    authorId: authorId || null,
    summary: text(summary, 240) || "Updated the page",
    status,
    parentRevisionId: parentRevisionId || record.currentRevisionId || null,
    content: snapshot(record),
    createdAt: now(),
  };
  db.revisions.push(revision);
  record.revisionCount = db.revisions.filter((item) => item.articleId === record.id).length;
  if (status === "approved") record.currentRevisionId = revision.id;
  return revision;
}

function applySnapshot(record, content) {
  Object.assign(record, {
    name: content.name || record.name,
    headline: content.headline,
    dek: content.dek,
    body: content.body,
    achievements: content.achievements,
    origin: content.origin,
    building: content.building,
    story: content.story,
    city: content.city,
    country: content.country,
    website: content.website,
    photoDataUrl: content.photoDataUrl,
    photo: content.photo,
    references: content.references || [],
    field: content.field || record.field,
    category: content.category || record.category,
    pages: [],
  });
  Object.assign(record, writeCopy(record));
}

function searchPeople(records, q) {
  return [...records]
    .filter((row) => row.status === "published" && matchesQuery(row, q))
    .sort(sortOrganic)
    .slice(0, 40)
    .map((row) => ({
      type: "person",
      slug: row.slug,
      title: row.name,
      description: row.dek,
      category: row.category || row.field,
      updatedAt: row.updatedAt,
    }));
}

export async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  let path = url.pathname.replace(/\/$/, "") || "/";
  while (path === "/api" || path.startsWith("/api/")) {
    path = path === "/api" ? "/" : path.slice(4) || "/";
  }
  const ip = clientIp(req);

  try {
    let db = await load();
    db.sessions = db.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
    let changed = false;
    for (const item of SEED_USERS) {
      if (db.users.some((user) => user.email === item.email)) continue;
      const { hash, salt } = await hashPassword(item.password);
      db.users.push({
        id: `user-${item.role}`,
        email: item.email,
        name: item.name,
        username: item.role,
        role: item.role,
        bio: "",
        passwordHash: hash,
        passwordSalt: salt,
        emailVerified: true,
        createdAt: now(),
      });
      changed = true;
    }
    if (changed) await save(db);

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, product: "names-of-note" });
    }
    if (req.method === "GET" && path === "/v1/catalog") {
      return json(res, 200, { name: "Names of Note", domain: "namesofnote.com", skus: Object.values(SKUS), categories: CATEGORIES });
    }
    if (req.method === "GET" && path === "/v1/settings/public") {
      const conf = settings(db);
      return json(res, 200, { newUserReview: conf.newUserReview });
    }

    if (req.method === "POST" && path === "/v1/auth/signup") {
      if (!rateLimit(`signup:${ip}`, 5, 60_000)) return deny(res, 429, "RATE_LIMITED", "Too many attempts. Wait a minute.");
      const body = await readBody(req);
      const name = text(body.name, 80);
      const email = text(body.email, 120).toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2 || !email.includes("@") || password.length < 8) {
        return deny(res, 400, "INVALID_INPUT", "Name, a real email, and a password of 8+ characters.");
      }
      if (db.users.some((user) => user.email === email && !user.deletedAt)) {
        return deny(res, 409, "EMAIL_TAKEN", "That email is already on this desk.");
      }
      const { hash, salt } = await hashPassword(password);
      const user = {
        id: id("user"),
        email,
        name,
        username: uniqueUsername(db, body.username || name),
        role: "member",
        bio: "",
        passwordHash: hash,
        passwordSalt: salt,
        emailVerified: process.env.NODE_ENV !== "production",
        verifyToken: randomBytes(24).toString("hex"),
        createdAt: now(),
      };
      db.users.push(user);
      audit(db, { actorId: user.id, action: "USER_CREATED", targetType: "user", targetId: user.id, ip });
      const token = await createSession(db, user, req);
      return json(res, 200, { token, user: publicUser(user), verifyToken: process.env.NODE_ENV !== "production" ? user.verifyToken : undefined });
    }

    if (req.method === "POST" && path === "/v1/auth/login") {
      if (!rateLimit(`login:${ip}`, settings(db).loginLimit || 8, 60_000)) {
        return deny(res, 429, "RATE_LIMITED", "Too many attempts. Wait a minute.");
      }
      const body = await readBody(req);
      const email = text(body.email, 120).toLowerCase();
      const password = String(body.password || "");
      const user = db.users.find((row) => row.email === email && !row.deletedAt);
      if (!user || !(await checkPassword(password, user.passwordHash, user.passwordSalt))) {
        return deny(res, 401, "INVALID_CREDENTIALS", "Email or password did not match.");
      }
      const blocked = activeBlock(db, user.id, "full");
      if (blocked) return deny(res, 403, "USER_BLOCKED", blocked.reason || "This account is blocked.");
      const token = await createSession(db, user, req);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "POST" && path === "/v1/auth/logout") {
      const token = sessionToken(req);
      db.sessions = db.sessions.filter((row) => row.token !== token);
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/v1/auth/verify") {
      const body = await readBody(req);
      const user = db.users.find((row) => row.verifyToken && row.verifyToken === text(body.token, 80));
      if (!user) return deny(res, 400, "INVALID_TOKEN", "That verification link is not valid.");
      user.emailVerified = true;
      user.verifyToken = null;
      await save(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (req.method === "POST" && path === "/v1/auth/forgot") {
      if (!rateLimit(`forgot:${ip}`, 5, 60_000)) return deny(res, 429, "RATE_LIMITED", "Too many attempts.");
      const body = await readBody(req);
      const email = text(body.email, 120).toLowerCase();
      const user = db.users.find((row) => row.email === email && !row.deletedAt);
      if (user) {
        user.resetToken = randomBytes(24).toString("hex");
        user.resetExpires = new Date(Date.now() + 1000 * 60 * 60).toISOString();
        await save(db);
      }
      return json(res, 200, { ok: true, resetToken: process.env.NODE_ENV !== "production" && user ? user.resetToken : undefined });
    }

    if (req.method === "POST" && path === "/v1/auth/reset") {
      const body = await readBody(req);
      const user = db.users.find((row) => row.resetToken && row.resetToken === text(body.token, 80));
      if (!user || !user.resetExpires || new Date(user.resetExpires).getTime() < Date.now()) {
        return deny(res, 400, "INVALID_TOKEN", "That reset link is not valid.");
      }
      const password = String(body.password || "");
      if (password.length < 8) return deny(res, 400, "INVALID_INPUT", "Password of 8+ characters.");
      const { hash, salt } = await hashPassword(password);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.resetToken = null;
      user.resetExpires = null;
      db.sessions = db.sessions.filter((row) => row.userId !== user.id);
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/v1/me") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const record = createdByUser(db, user);
      const unread = db.notifications.filter((item) => item.userId === user.id && !item.read).length;
      return json(res, 200, { user: publicUser(user), record: record ? publicRecord(record) : null, unread });
    }

    if (req.method === "POST" && path === "/v1/me") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      if (body.name) user.name = text(body.name, 80);
      if (body.bio !== undefined) user.bio = text(body.bio, 600);
      if (body.username) user.username = uniqueUsername(db, body.username, user.id);
      await save(db);
      return json(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && path === "/v1/me/password") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      if (!(await checkPassword(String(body.current || ""), user.passwordHash, user.passwordSalt))) {
        return deny(res, 401, "INVALID_CREDENTIALS", "Current password did not match.");
      }
      if (String(body.next || "").length < 8) return deny(res, 400, "INVALID_INPUT", "Password of 8+ characters.");
      const { hash, salt } = await hashPassword(String(body.next));
      user.passwordHash = hash;
      user.passwordSalt = salt;
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/v1/me/sessions") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const token = sessionToken(req);
      return json(res, 200, {
        sessions: db.sessions
          .filter((row) => row.userId === user.id)
          .map((row) => ({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, current: row.token === token })),
      });
    }

    if (req.method === "POST" && path === "/v1/me/sessions/revoke") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const token = sessionToken(req);
      db.sessions = db.sessions.filter((row) => row.userId !== user.id || row.token === token);
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/v1/me/delete") {
      const user = requireUser(db, req, res);
      if (!user) return;
      user.deletedAt = now();
      user.name = "Former contributor";
      user.email = `deleted-${user.id}@invalid.local`;
      user.username = `deleted-${user.id.slice(-6)}`;
      db.sessions = db.sessions.filter((row) => row.userId !== user.id);
      audit(db, { actorId: user.id, action: "USER_DELETED", targetType: "user", targetId: user.id, ip });
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/v1/search") {
      const q = text(url.searchParams.get("q") || "", 80);
      const type = text(url.searchParams.get("type") || "all", 20);
      const published = db.records.filter((row) => row.status === "published");
      const people = q && type !== "users" && type !== "categories" ? searchPeople(published, q) : type === "all" && q ? searchPeople(published, q) : [];
      const users =
        q && (type === "all" || type === "users")
          ? db.users
              .filter((row) => !row.deletedAt && (`${row.username} ${row.name}`.toLowerCase().includes(q.toLowerCase())))
              .slice(0, 20)
              .map((row) => ({ type: "user", username: row.username, title: row.name, description: row.bio || row.role }))
          : [];
      const categories =
        !q || type === "all" || type === "categories"
          ? CATEGORIES.filter((item) => !q || item.name.toLowerCase().includes(q.toLowerCase()) || item.slug.includes(slugify(q))).map((item) => ({
              type: "category",
              slug: item.slug,
              title: item.name,
              description: "Field",
            }))
          : [];
      return json(res, 200, { q, results: [...people, ...users, ...categories] });
    }

    if (req.method === "GET" && path === "/v1/records") {
      const field = text(url.searchParams.get("field") || "", 40);
      const q = text(url.searchParams.get("q") || "", 80);
      const stamp = Date.now();
      const published = db.records.filter((row) => row.status === "published" && matchesField(row, field) && matchesQuery(row, q));
      const featured = published.filter((row) => isFeatured(row, stamp)).map(publicRecord);
      const records = [...published].sort(sortOrganic).map(publicRecord);
      return json(res, 200, { records, featured });
    }

    if (req.method === "GET" && path === "/v1/sitemap") {
      const pages = db.records
        .filter((row) => row.status === "published")
        .map((row) => ({ slug: row.slug, updatedAt: row.updatedAt, name: row.name }));
      return json(res, 200, { pages });
    }

    if (req.method === "GET" && path.startsWith("/v1/records/")) {
      const rest = path.slice("/v1/records/".length);
      const parts = rest.split("/");
      const record = recordBySlug(db, parts[0]);
      if (!record) return deny(res, 404, "ARTICLE_NOT_FOUND", "Not on this desk.");
      if (parts.length === 1) return json(res, 200, { record: publicRecord(record) });
      if (parts[1] === "talk") {
        return json(res, 200, { talk: db.talk.filter((item) => item.slug === record.slug) });
      }
      if (parts[1] === "revisions" && parts.length === 2) {
        const revisions = db.revisions
          .filter((item) => item.articleId === record.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((item) => ({
            id: item.id,
            authorId: item.authorId,
            author: publicProfile(db.users.find((user) => user.id === item.authorId)) || { name: "Former contributor", username: "deleted" },
            summary: item.summary,
            status: item.status,
            createdAt: item.createdAt,
            parentRevisionId: item.parentRevisionId,
            current: item.id === record.currentRevisionId,
          }));
        return json(res, 200, { revisions, currentRevisionId: record.currentRevisionId });
      }
      if (parts[1] === "revisions" && parts[2] && parts[3] === "diff") {
        const from = db.revisions.find((item) => item.id === parts[2] && item.articleId === record.id);
        const toId = url.searchParams.get("to") || record.currentRevisionId;
        const to = db.revisions.find((item) => item.id === toId && item.articleId === record.id);
        if (!from || !to) return deny(res, 404, "REVISION_NOT_FOUND", "Those revisions are not on this page.");
        return json(res, 200, { from, to, diff: diffSnapshots(from.content, to.content) });
      }
      if (parts[1] === "revisions" && parts[2]) {
        const revision = db.revisions.find((item) => item.id === parts[2] && item.articleId === record.id);
        if (!revision) return deny(res, 404, "REVISION_NOT_FOUND", "No such revision.");
        return json(res, 200, { revision });
      }
      return deny(res, 404, "NOT_FOUND", "Not found");
    }

    if (req.method === "GET" && path.startsWith("/v1/talk/")) {
      const slug = path.slice("/v1/talk/".length);
      return json(res, 200, { talk: db.talk.filter((item) => item.slug === slug) });
    }

    if (req.method === "GET" && path.startsWith("/v1/users/")) {
      const username = path.slice("/v1/users/".length).split("/")[0];
      const contrib = path.endsWith("/contributions");
      const user = db.users.find((row) => row.username === username && !row.deletedAt);
      if (!user) return deny(res, 404, "USER_NOT_FOUND", "No such contributor.");
      const authored = db.revisions.filter((item) => item.authorId === user.id);
      const created = db.records.filter((row) => (row.createdBy === user.id || row.ownerUserId === user.id) && row.status === "published");
      const watched = db.watchlists.filter((row) => row.userId === user.id);
      if (contrib) {
        const items = authored
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 80)
          .map((item) => ({
            revisionId: item.id,
            slug: item.slug,
            summary: item.summary,
            status: item.status,
            createdAt: item.createdAt,
            name: recordBySlug(db, item.slug)?.name || item.slug,
          }));
        return json(res, 200, { contributions: items });
      }
      return json(res, 200, {
        profile: publicProfile(user, {
          editCount: authored.length,
          pagesCreated: created.length,
          pagesWatched: watched.length,
        }),
        created: created.map((row) => ({ slug: row.slug, name: row.name, dek: row.dek })),
        recent: authored
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 12)
          .map((item) => ({ slug: item.slug, summary: item.summary, createdAt: item.createdAt, status: item.status })),
      });
    }

    if (req.method === "POST" && path === "/v1/talk") {
      const user = requireUser(db, req, res);
      if (!user) return;
      if (!rateLimit(`talk:${user.id}`, 20, 60_000)) return deny(res, 429, "RATE_LIMITED", "Slow down on talk.");
      const blocked = activeBlock(db, user.id, "discussion");
      if (blocked) return deny(res, 403, "USER_BLOCKED", blocked.reason || "Talk is blocked on this account.");
      const body = await readBody(req);
      const slug = slugify(body.slug);
      const message = text(body.body, 1200);
      if (!slug || message.length < 4) return deny(res, 400, "INVALID_INPUT", "Write a note the desk can act on.");
      const mentions = [...message.matchAll(/@([a-z0-9-]+)/gi)].map((item) => item[1].toLowerCase());
      const item = {
        id: id("talk"),
        slug,
        userId: user.id,
        userName: user.name,
        username: user.username,
        role: user.role,
        body: message,
        createdAt: now(),
      };
      db.talk.push(item);
      notifyWatchers(db, slug, { type: "talk", title: "Talk on a watched page", body: `${user.name} wrote on ${slug}.`, href: `/people/${slug}` }, user.id);
      for (const name of mentions) {
        const mentioned = db.users.find((row) => row.username === name && !row.deletedAt);
        if (mentioned && mentioned.id !== user.id) {
          notify(db, { userId: mentioned.id, type: "mention", title: "You were mentioned", body: `${user.name} mentioned you on ${slug}.`, href: `/people/${slug}` });
        }
      }
      await save(db);
      return json(res, 200, { talk: item });
    }

    if (req.method === "POST" && path === "/v1/flags") {
      const user = requireUser(db, req, res);
      if (!user) return;
      if (!rateLimit(`flag:${user.id}`, 8, 60_000)) return deny(res, 429, "RATE_LIMITED", "Too many flags.");
      const body = await readBody(req);
      const slug = slugify(body.slug);
      const reason = text(body.reason, 400);
      const kind = text(body.kind || "other", 40);
      if (!slug || reason.length < 4) return deny(res, 400, "INVALID_INPUT", "Say what is wrong.");
      const duplicate = db.flags.find((item) => item.slug === slug && item.userId === user.id && item.status === "open");
      if (duplicate) return deny(res, 409, "DUPLICATE_REPORT", "You already flagged this page.");
      const item = {
        id: id("flag"),
        slug,
        userId: user.id,
        userName: user.name,
        reason,
        kind,
        status: "open",
        priority: "normal",
        createdAt: now(),
      };
      db.flags.push(item);
      db.reports.push({ ...item, targetType: "article" });
      audit(db, { actorId: user.id, action: "REPORT_CREATED", targetType: "article", targetId: slug, ip });
      await save(db);
      return json(res, 200, { flag: item });
    }

    if (req.method === "GET" && path === "/v1/suggest") {
      const name = text(url.searchParams.get("name") || url.searchParams.get("q") || "", 80);
      const published = db.records.filter((row) => row.status === "published");
      return json(res, 200, { matches: similarRecords(published, name) });
    }

    if (req.method === "POST" && path === "/v1/file") {
      const user = requireUser(db, req, res);
      if (!user) return;
      if (!requirePerm(user, res, PERMISSIONS.CREATE_PAGE, "You cannot file a page.")) return;
      if (!rateLimit(`file:${user.id}`, 8, 60_000)) return deny(res, 429, "RATE_LIMITED", "Too many filings.");
      const blocked = activeBlock(db, user.id, "creation");
      if (blocked) return deny(res, 403, "USER_BLOCKED", blocked.reason || "Filing is blocked on this account.");
      const body = await readBody(req);
      if (!text(body.name, 80)) return deny(res, 400, "INVALID_INPUT", "Incomplete filing.");
      const matches = similarRecords(db.records.filter((row) => row.status === "published"), body.name);
      if (matches[0]?.slug === slugify(body.name) && !body.confirmDuplicate) {
        return json(res, 409, { error: "A similar page already exists.", code: "POSSIBLE_DUPLICATE", matches });
      }
      if (filingTooThin(body)) return deny(res, 400, "PAGE_TOO_THIN", "Write who they are — a public lead, not just a name.");
      const pending = settings(db).newUserReview && !canDirectPublish(user);
      const record = draftRecord(db.records, body, {
        sku: "free",
        status: "published",
        lane: "filed",
        createdBy: user.id,
        ownerUserId: user.id,
        email: user.email,
        needsReview: pending,
      });
      record.website = safeUrl(record.website);
      db.records.unshift(record);
      const revision = appendRevision(db, record, {
        authorId: user.id,
        summary: "Filed the page",
        status: pending ? "pending" : "approved",
      });
      record.currentRevisionId = revision.id;
      audit(db, { actorId: user.id, action: "ARTICLE_CREATED", targetType: "article", targetId: record.slug, ip });
      await save(db);
      announcePage(record.slug);
      return json(res, 200, { slug: record.slug, matches });
    }

    if (req.method === "POST" && path === "/v1/edit") {
      const user = requireUser(db, req, res);
      if (!user) return;
      if (!requirePerm(user, res, PERMISSIONS.EDIT_PAGE, "You cannot edit pages.")) return;
      if (!rateLimit(`edit:${user.id}`, settings(db).editLimit || 30, 60_000)) return deny(res, 429, "RATE_LIMITED", "Too many edits.");
      const blocked = activeBlock(db, user.id, "editing");
      if (blocked) return deny(res, 403, "USER_BLOCKED", blocked.reason || "Editing is blocked on this account.");
      const body = await readBody(req);
      let record = recordBySlug(db, slugify(body.slug));
      if (!record) {
        record = draftRecord(db.records, { ...body, name: body.name || body.slug }, {
          sku: "free",
          status: "published",
          lane: "filed",
          createdBy: user.id,
          ownerUserId: user.id,
          email: user.email,
          needsReview: true,
        });
        record.slug = slugify(body.slug);
        db.records.unshift(record);
      }
      if ((record.protected || record.protectionLevel === "full" || record.protectionLevel === "edit") && !isMod(user)) {
        return deny(res, 403, "PAGE_PROTECTED", "This page is locked.");
      }
      if (body.expectedRevisionId && record.currentRevisionId && body.expectedRevisionId !== record.currentRevisionId) {
        const current = db.revisions.find((item) => item.id === record.currentRevisionId);
        return json(res, 409, {
          error: "Your version is based on an older revision.",
          code: "REVISION_CONFLICT",
          currentRevisionId: record.currentRevisionId,
          current: current?.content,
        });
      }
      const pending = settings(db).newUserReview && !canDirectPublish(user);
      const previous = snapshot(record);
      if (body.headline) record.headline = text(body.headline, 120);
      if (body.dek !== undefined) record.dek = text(body.dek, 280);
      if (body.city !== undefined) record.city = text(body.city, 60);
      if (body.country !== undefined) record.country = text(body.country, 60);
      if (body.achievements !== undefined) record.achievements = parseAchievements(body.achievements);
      if (body.origin !== undefined) record.origin = text(body.origin);
      if (body.building !== undefined) record.building = text(body.building);
      if (body.story !== undefined) record.story = text(body.story);
      if (body.body !== undefined) {
        record.body = Array.isArray(body.body) ? body.body.map((item) => text(item, 4000)).filter(Boolean) : String(body.body).split(/\n\n/).map((item) => text(item, 4000)).filter(Boolean);
      }
      if (body.references !== undefined) record.references = parseReferences(body.references).map((item) => ({ ...item, url: safeUrl(item.url) }));
      if (body.website !== undefined) record.website = safeUrl(body.website);
      record.pages = [];
      Object.assign(record, writeCopy(record));
      const proposed = snapshot(record);
      if (pending) applySnapshot(record, previous);
      record.needsReview = pending;
      record.updatedAt = now();
      const revision = {
        id: id("rev"),
        articleId: record.id,
        slug: record.slug,
        authorId: user.id,
        summary: text(body.summary, 240) || "Updated the page",
        status: pending ? "pending" : "approved",
        parentRevisionId: record.currentRevisionId || null,
        content: proposed,
        createdAt: now(),
      };
      db.revisions.push(revision);
      record.revisionCount = db.revisions.filter((item) => item.articleId === record.id).length;
      if (!pending) record.currentRevisionId = revision.id;
      notifyWatchers(db, record.slug, { type: "edit", title: "A watched page changed", body: `${user.name} edited ${record.name}.`, href: `/people/${record.slug}` }, user.id);
      audit(db, { actorId: user.id, action: "ARTICLE_EDITED", targetType: "article", targetId: record.slug, ip, metadata: { revisionId: revision.id } });
      await save(db);
      return json(res, 200, { slug: record.slug, revisionId: revision.id, pending });
    }

    if (req.method === "POST" && path === "/v1/drafts") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      const slug = slugify(body.slug || "");
      const existing = db.drafts.find((row) => row.userId === user.id && row.slug === slug);
      const draft = {
        id: existing?.id || id("draft"),
        userId: user.id,
        slug,
        title: text(body.name || body.title, 80),
        content: body,
        savedAt: now(),
      };
      db.drafts = db.drafts.filter((row) => row.id !== draft.id);
      db.drafts.unshift(draft);
      await save(db);
      return json(res, 200, { draft: { id: draft.id, slug: draft.slug, savedAt: draft.savedAt } });
    }

    if (req.method === "GET" && path === "/v1/drafts") {
      const user = requireUser(db, req, res);
      if (!user) return;
      return json(res, 200, { drafts: db.drafts.filter((row) => row.userId === user.id) });
    }

    if (req.method === "POST" && path === "/v1/watch") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      const slug = slugify(body.slug);
      if (!slug) return deny(res, 400, "INVALID_INPUT", "Missing page.");
      const watching = db.watchlists.some((row) => row.userId === user.id && row.slug === slug);
      if (watching) db.watchlists = db.watchlists.filter((row) => !(row.userId === user.id && row.slug === slug));
      else db.watchlists.push({ id: id("watch"), userId: user.id, slug, createdAt: now() });
      await save(db);
      return json(res, 200, { watching: !watching, slug });
    }

    if (req.method === "GET" && path === "/v1/watchlist") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const items = db.watchlists
        .filter((row) => row.userId === user.id)
        .map((row) => {
          const record = recordBySlug(db, row.slug);
          return { slug: row.slug, name: record?.name || row.slug, dek: record?.dek || "", updatedAt: record?.updatedAt, watching: true };
        });
      return json(res, 200, { watchlist: items });
    }

    if (req.method === "GET" && path === "/v1/notifications") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const items = db.notifications.filter((item) => item.userId === user.id).slice(0, 80);
      return json(res, 200, { notifications: items });
    }

    if (req.method === "POST" && path === "/v1/notifications/read") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      for (const item of db.notifications) {
        if (item.userId !== user.id) continue;
        if (!body.id || item.id === body.id) item.read = true;
      }
      await save(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/v1/checkout") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      const sku = SKUS[text(body.sku, 40)];
      if (!sku || sku.id !== "featured") return deny(res, 400, "INVALID_INPUT", "Incomplete filing.");
      let record = createdByUser(db, user);
      if (!record) {
        if (!text(body.name, 80)) return deny(res, 400, "INVALID_INPUT", "Incomplete filing.");
        if (filingTooThin(body)) return deny(res, 400, "PAGE_TOO_THIN", "Write who they are — a public lead, not just a name.");
        record = draftRecord(db.records, body, { sku: sku.id, status: "pending", lane: "filed", createdBy: user.id, ownerUserId: user.id, email: user.email });
        db.records.unshift(record);
      } else {
        record.sku = sku.id;
        if (record.status !== "published") record.status = "pending";
      }
      await save(db);
      return json(res, 200, { id: record.id, slug: record.slug, cents: sku.cents, label: sku.label, demo: !process.env.RAZORPAY_KEY_ID });
    }

    if (req.method === "POST" && path === "/v1/checkout/confirm") {
      const user = requireUser(db, req, res);
      if (!user) return;
      const body = await readBody(req);
      const record = db.records.find((row) => row.id === body.id && (row.createdBy === user.id || row.ownerUserId === user.id));
      if (!record) return deny(res, 404, "ARTICLE_NOT_FOUND", "No such filing.");
      if (record.lane !== "sponsored" || record.status !== "published") {
        const featuredUntil = new Date();
        featuredUntil.setFullYear(featuredUntil.getFullYear() + 1);
        appendRevision(db, record, { authorId: user.id, summary: "Boosted as a labeled sponsored slot", status: "approved" });
        Object.assign(record, writeCopy({ ...record, lane: "sponsored" }), {
          status: "published",
          lane: "sponsored",
          featuredUntil: featuredUntil.toISOString(),
          paidAt: now(),
          publishedAt: record.publishedAt || now(),
          needsReview: true,
          updatedAt: now(),
        });
        await save(db);
      }
      announcePage(record.slug);
      return json(res, 200, { slug: record.slug });
    }

    if (req.method === "GET" && path === "/v1/moderation/queue") {
      const user = sessionUser(db, req);
      if (!user || !can(user, PERMISSIONS.REVIEW_EDITS)) return deny(res, 403, "PERMISSION_DENIED", "Moderators only.");
      const filings = db.records.filter((row) => row.needsReview && row.status === "published").map(publicRecord);
      const flags = db.flags.filter((item) => item.status === "open");
      const pendingEdits = db.revisions
        .filter((item) => item.status === "pending")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 40)
        .map((item) => ({
          ...item,
          name: recordBySlug(db, item.slug)?.name || item.slug,
          author: publicProfile(db.users.find((row) => row.id === item.authorId)),
        }));
      const recent = [...db.records]
        .filter((row) => row.status !== "deleted")
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
        .slice(0, 30)
        .map((row) => ({
          slug: row.slug,
          name: row.name,
          lane: row.lane,
          needsReview: row.needsReview,
          verified: row.verified,
          protected: row.protected,
          updatedAt: row.updatedAt,
        }));
      const blocks = db.blocks.filter((row) => !row.liftedAt);
      const warnings = db.warnings.slice(-20).reverse();
      return json(res, 200, {
        filings,
        flags,
        pendingEdits,
        recent,
        talk: db.talk.slice(-20).reverse(),
        blocks,
        warnings,
        audit: can(user, PERMISSIONS.VIEW_AUDIT) ? db.auditLogs.slice(-40).reverse() : [],
      });
    }

    if (req.method === "POST" && path === "/v1/moderation/act") {
      const user = sessionUser(db, req);
      if (!user || !isMod(user)) return deny(res, 403, "PERMISSION_DENIED", "Moderators only.");
      const body = await readBody(req);
      const action = text(body.action, 40);
      if (action === "resolve-flag") {
        const flag = db.flags.find((item) => item.id === text(body.id, 80));
        if (!flag) return deny(res, 404, "REPORT_NOT_FOUND", "No such flag.");
        flag.status = "resolved";
        flag.resolvedBy = user.id;
        flag.resolvedAt = now();
        const report = db.reports.find((item) => item.id === flag.id);
        if (report) {
          report.status = "resolved";
          report.resolvedAt = now();
        }
        audit(db, { actorId: user.id, action: "REPORT_RESOLVED", targetType: "flag", targetId: flag.id, ip });
        await save(db);
        return json(res, 200, { ok: true });
      }
      if (action === "approve-edit" || action === "reject-edit") {
        if (!requirePerm(user, res, PERMISSIONS.REVIEW_EDITS)) return;
        const revision = db.revisions.find((item) => item.id === text(body.id, 80));
        if (!revision) return deny(res, 404, "REVISION_NOT_FOUND", "No such edit.");
        const record = db.records.find((row) => row.id === revision.articleId);
        if (!record) return deny(res, 404, "ARTICLE_NOT_FOUND", "Not on this desk.");
        if (action === "approve-edit") {
          applySnapshot(record, revision.content);
          revision.status = "approved";
          record.currentRevisionId = revision.id;
          record.needsReview = false;
          record.updatedAt = now();
          notify(db, { userId: revision.authorId, type: "approved", title: "Edit approved", body: `Your edit on ${record.name} is on the record.`, href: `/people/${record.slug}` });
          audit(db, { actorId: user.id, action: "EDIT_APPROVED", targetType: "revision", targetId: revision.id, ip });
        } else {
          revision.status = "rejected";
          notify(db, { userId: revision.authorId, type: "rejected", title: "Edit rejected", body: body.note || `Your edit on ${record.name} was not taken.`, href: `/people/${record.slug}` });
          audit(db, { actorId: user.id, action: "EDIT_REJECTED", targetType: "revision", targetId: revision.id, ip });
        }
        await save(db);
        if (action === "approve-edit") announcePage(record.slug);
        return json(res, 200, { ok: true, slug: record.slug });
      }
      const record = recordBySlug(db, slugify(body.slug));
      if (!record) return deny(res, 404, "ARTICLE_NOT_FOUND", "Not on this desk.");
      if (action === "approve") {
        record.needsReview = false;
      } else if (action === "verify") {
        record.verified = true;
        record.needsReview = false;
      } else if (action === "unverify") {
        record.verified = false;
      } else if (action === "protect") {
        if (!requirePerm(user, res, PERMISSIONS.PROTECT_PAGE)) return;
        record.protected = true;
        record.protectionLevel = text(body.level, 20) || "full";
        record.protectionReason = text(body.reason, 240) || "Locked by a moderator.";
        audit(db, { actorId: user.id, action: "ARTICLE_PROTECTED", targetType: "article", targetId: record.slug, ip });
        notifyWatchers(db, record.slug, { type: "protect", title: "Page locked", body: `${record.name} was locked.`, href: `/people/${record.slug}` });
      } else if (action === "unprotect") {
        record.protected = false;
        record.protectionLevel = "none";
        record.protectionReason = "";
      } else if (action === "delete") {
        if (!requirePerm(user, res, PERMISSIONS.DELETE_PAGE)) return;
        record.status = "deleted";
        record.deletedAt = now();
        record.deletedBy = user.id;
        record.deletionReason = text(body.reason, 240) || "Removed by a moderator.";
        audit(db, { actorId: user.id, action: "ARTICLE_DELETED", targetType: "article", targetId: record.slug, ip });
      } else if (action === "restore") {
        if (!requirePerm(user, res, PERMISSIONS.RESTORE_PAGE)) return;
        record.status = "published";
        record.deletedAt = null;
        record.deletedBy = null;
        audit(db, { actorId: user.id, action: "ARTICLE_RESTORED", targetType: "article", targetId: record.slug, ip });
      } else if (action === "warn") {
        if (!requirePerm(user, res, PERMISSIONS.WARN_USER)) return;
        const target = db.users.find((row) => row.id === text(body.userId, 80) || row.username === text(body.username, 40));
        if (!target) return deny(res, 404, "USER_NOT_FOUND", "No such contributor.");
        const warning = {
          id: id("warn"),
          userId: target.id,
          moderatorId: user.id,
          reason: text(body.reason, 240) || "Conduct on this desk.",
          severity: text(body.severity, 20) || "WARNING",
          createdAt: now(),
          slug: record.slug,
        };
        db.warnings.push(warning);
        notify(db, { userId: target.id, type: "warning", title: "A warning from the desk", body: warning.reason, href: `/people/${record.slug}` });
        audit(db, { actorId: user.id, action: "USER_WARNED", targetType: "user", targetId: target.id, ip });
      } else if (action === "block") {
        if (!requirePerm(user, res, PERMISSIONS.BLOCK_USER)) return;
        const target = db.users.find((row) => row.id === text(body.userId, 80) || row.username === text(body.username, 40));
        if (!target) return deny(res, 404, "USER_NOT_FOUND", "No such contributor.");
        const block = {
          id: id("block"),
          userId: target.id,
          moderatorId: user.id,
          reason: text(body.reason, 240) || "Blocked by a moderator.",
          scope: text(body.scope, 20) || "full",
          start: now(),
          expiresAt: body.expiresAt || null,
          liftedAt: null,
        };
        db.blocks.push(block);
        notify(db, { userId: target.id, type: "block", title: "Account restricted", body: block.reason, href: "/desk" });
        audit(db, { actorId: user.id, action: "USER_BLOCKED", targetType: "user", targetId: target.id, ip });
      } else if (action === "revert") {
        if (!requirePerm(user, res, PERMISSIONS.REVERT_EDIT)) return;
        const targetRevision =
          db.revisions.find((item) => item.id === text(body.revisionId, 80) && item.articleId === record.id) ||
          db.revisions.filter((item) => item.articleId === record.id && item.status === "approved").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[1];
        if (!targetRevision) return deny(res, 400, "REVISION_NOT_FOUND", "Nothing to revert.");
        applySnapshot(record, targetRevision.content);
        record.needsReview = false;
        record.updatedAt = now();
        const revision = appendRevision(db, record, {
          authorId: user.id,
          summary: text(body.reason, 240) || `Reverted to ${targetRevision.id}`,
          status: "approved",
          parentRevisionId: record.currentRevisionId,
        });
        record.currentRevisionId = revision.id;
        notifyWatchers(db, record.slug, { type: "revert", title: "Page reverted", body: `${record.name} was reverted.`, href: `/people/${record.slug}/history` });
        audit(db, { actorId: user.id, action: "ARTICLE_REVERTED", targetType: "article", targetId: record.slug, ip, metadata: { revisionId: revision.id } });
      } else {
        return deny(res, 400, "INVALID_INPUT", "Unknown action.");
      }
      record.updatedAt = now();
      await save(db);
      if (record.status === "published") announcePage(record.slug);
      return json(res, 200, { slug: record.slug, record: publicRecord(record) });
    }

    if (req.method === "GET" && path === "/v1/admin/overview") {
      const user = sessionUser(db, req);
      if (!user || user.role !== "desk") return deny(res, 403, "PERMISSION_DENIED", "Desk only.");
      return json(res, 200, {
        users: db.users.filter((row) => !row.deletedAt).length,
        articles: db.records.filter((row) => row.status === "published").length,
        pending: db.revisions.filter((item) => item.status === "pending").length,
        reports: db.flags.filter((item) => item.status === "open").length,
        blocks: db.blocks.filter((row) => !row.liftedAt).length,
      });
    }

    return deny(res, 404, "NOT_FOUND", "Not found");
  } catch (error) {
    return deny(res, 500, "SERVER_ERROR", error instanceof Error ? error.message : "Desk closed.");
  }
}

export default handleRequest;

const server = createServer(handleRequest);

if (!process.env.VERCEL) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Names of Note API on :" + PORT);
  });
}
