import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, id, now } from "./util.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");
const FILE = join(ROOT, "data", "db.json");

let cache = null;
let mongoClient = null;
let mongoDb = null;

function empty() {
  return {
    records: [],
    revisions: [],
    issueSeq: 27,
    users: [],
    sessions: [],
    talk: [],
    flags: [],
    watchlists: [],
    notifications: [],
    drafts: [],
    reports: [],
    warnings: [],
    blocks: [],
    auditLogs: [],
    settings: {
      newUserReview: true,
      trustedMinApprovedEdits: 10,
      trustedMinAccountDays: 14,
      loginLimit: 8,
      editLimit: 30,
    },
  };
}

function migrate(db) {
  const next = { ...empty(), ...db };
  next.records ||= [];
  next.revisions ||= [];
  next.users ||= [];
  next.sessions ||= [];
  next.talk ||= [];
  next.flags ||= [];
  next.watchlists ||= [];
  next.notifications ||= [];
  next.drafts ||= [];
  next.reports ||= [];
  next.warnings ||= [];
  next.blocks ||= [];
  next.auditLogs ||= [];
  next.settings = { ...empty().settings, ...(db.settings || {}) };
  next.issueSeq ||= 27;

  for (const row of next.records) {
    if (row.createdBy === undefined) row.createdBy = row.ownerUserId || null;
    if (row.protectionLevel === undefined) row.protectionLevel = row.protected ? "full" : "none";
    if (row.deletedAt === undefined) row.deletedAt = null;
    if (!Array.isArray(row.references)) row.references = [];
    if (!Array.isArray(row.tags)) row.tags = [];
    if (!row.updatedAt) row.updatedAt = row.publishedAt || row.createdAt;
    if (Array.isArray(row.revisions) && row.revisions.length) {
      for (const snap of row.revisions) {
        const revisionId = snap.revisionId || id("rev");
        if (!next.revisions.some((item) => item.id === revisionId && item.articleId === row.id)) {
          next.revisions.push({
            id: revisionId,
            articleId: row.id,
            slug: row.slug,
            authorId: snap.authorId || row.createdBy || null,
            summary: snap.summary || "Prior snapshot",
            status: "approved",
            parentRevisionId: null,
            content: snap,
            createdAt: snap.at || row.updatedAt,
          });
        }
      }
      row.revisions = undefined;
    }
    const mine = next.revisions.filter((item) => item.articleId === row.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    row.revisionCount = mine.length;
    row.currentRevisionId = row.currentRevisionId || mine[mine.length - 1]?.id || null;
  }

  for (const user of next.users) {
    if (!user.username) {
      const base = slugify(user.name || user.email.split("@")[0], 24) || "reader";
      let username = base;
      let n = 2;
      while (next.users.some((item) => item.username === username && item.id !== user.id)) username = `${base}-${n++}`;
      user.username = username;
    }
    if (user.emailVerified === undefined) user.emailVerified = user.role === "desk" || user.role === "moderator";
    if (user.bio === undefined) user.bio = "";
    if (!user.role) user.role = "member";
  }
  return next;
}

async function mongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoDb) return mongoDb;
  const { MongoClient } = await import("mongodb");
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB || "names_of_note");
  await mongoDb.collection("users").createIndex({ email: 1 }, { unique: true, sparse: true });
  await mongoDb.collection("users").createIndex({ username: 1 }, { unique: true, sparse: true });
  await mongoDb.collection("records").createIndex({ slug: 1 }, { unique: true, sparse: true });
  await mongoDb.collection("revisions").createIndex({ articleId: 1, createdAt: 1 });
  await mongoDb.collection("notifications").createIndex({ userId: 1, createdAt: -1 });
  await mongoDb.collection("reports").createIndex({ status: 1 });
  await mongoDb.collection("auditLogs").createIndex({ createdAt: -1 });
  return mongoDb;
}

async function readJson() {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return empty();
  }
}

export async function load() {
  if (cache) return cache;
  const db = await mongo();
  if (db) {
    const state = await db.collection("app_state").findOne({ _id: "v1" });
    cache = migrate(state || (await readJson()));
    return cache;
  }
  cache = migrate(await readJson());
  return cache;
}

export async function save(db) {
  cache = db;
  const mongoDbHandle = await mongo();
  if (mongoDbHandle) {
    const { _id, ...rest } = db;
    await mongoDbHandle.collection("app_state").replaceOne({ _id: "v1" }, { _id: "v1", ...rest, savedAt: now() }, { upsert: true });
    return;
  }
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(FILE, JSON.stringify(db, null, 2));
}

export function uniqueUsername(db, source, ignoreId) {
  const base = slugify(source, 24) || "reader";
  let username = base;
  let n = 2;
  while (db.users.some((user) => user.username === username && user.id !== ignoreId && !user.deletedAt)) {
    username = `${base}-${n++}`;
  }
  return username;
}

export function audit(db, { actorId, action, targetType, targetId, metadata, ip }) {
  db.auditLogs.push({
    id: id("audit"),
    actorId: actorId || null,
    action,
    targetType,
    targetId: targetId || null,
    metadata: metadata || {},
    ip: ip || null,
    createdAt: now(),
  });
}

export function notify(db, { userId, type, title, body, href }) {
  if (!userId) return;
  db.notifications.unshift({
    id: id("note"),
    userId,
    type,
    title,
    body,
    href: href || "",
    read: false,
    createdAt: now(),
  });
}

export function notifyWatchers(db, slug, payload, exceptUserId) {
  const watchers = db.watchlists.filter((row) => row.slug === slug && row.userId !== exceptUserId);
  for (const row of watchers) notify(db, { ...payload, userId: row.userId });
}

export function activeBlock(db, userId, scope) {
  if (!userId) return null;
  const stamp = Date.now();
  return (
    db.blocks.find((row) => {
      if (row.userId !== userId) return false;
      if (row.liftedAt) return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() < stamp) return false;
      return row.scope === "full" || row.scope === scope;
    }) || null
  );
}

export function settings(db) {
  return { ...empty().settings, ...(db.settings || {}) };
}
