import { text, slugify, id, now } from "./util.mjs";

export const CATEGORIES = [
  { name: "Business", slug: "business" },
  { name: "Technology", slug: "technology" },
  { name: "Creators", slug: "creators" },
  { name: "Arts & Culture", slug: "arts-culture" },
  { name: "Social Impact", slug: "social-impact" },
  { name: "Health & Wellness", slug: "health-wellness" },
  { name: "Science", slug: "science" },
  { name: "Sports", slug: "sports" },
  { name: "Education", slug: "education" },
];

export function resolveField(body) {
  const slug = slugify(body.field || body.category);
  const found = CATEGORIES.find((item) => item.slug === slug || slugify(item.name) === slug);
  if (found) return found;
  return { name: text(body.category, 60) || "Business", slug: "business" };
}

export function parseAchievements(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? { text: text(item, 240), verified: false } : { text: text(item?.text, 240), verified: Boolean(item?.verified) }))
      .filter((item) => item.text);
  }
  return String(raw || "")
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({ text: item, verified: false }));
}

export function parseReferences(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      title: text(item.title, 200),
      author: text(item.author, 120),
      publisher: text(item.publisher, 120),
      url: text(item.url, 400),
      publicationDate: text(item.publicationDate, 40),
      accessDate: text(item.accessDate, 40),
      identifier: text(item.identifier, 80),
      notes: text(item.notes, 400),
    }))
    .filter((item) => item.title || item.url);
}

export function snapshot(row) {
  return {
    name: row.name,
    headline: row.headline,
    dek: row.dek,
    body: row.body,
    achievements: row.achievements,
    origin: row.origin,
    building: row.building,
    story: row.story,
    city: row.city,
    country: row.country,
    website: row.website,
    photoDataUrl: row.photoDataUrl,
    photo: row.photo,
    references: row.references || [],
    lane: row.lane,
    verified: row.verified,
    protected: row.protected,
    needsReview: row.needsReview,
    field: row.field,
    category: row.category,
    pages: row.pages,
  };
}

export function writeCopy(record) {
  const win = record.achievements?.[0]?.text || record.story || record.headline;
  const origin = record.origin || `${record.name} started without an audience.`;
  const body = record.body?.length
    ? record.body
    : [
        `${record.name} is filed as ${record.headline}. ${win}`,
        `Ask where it started. ${origin} Names of Note leaves that part on.`,
        ...(record.lane === "sponsored" ? ["Sponsored on this desk, labeled."] : []),
      ];
  return {
    ...record,
    dek: record.dek || `${record.headline} — and the work that made the name worth filing.`,
    body,
    pullQuote: record.pullQuote || origin,
    linkedinPost: record.linkedinPost || `${record.name} — filed on Names of Note.`,
    coverLine: record.coverLine || record.headline,
    pages: record.pages?.length
      ? record.pages
      : [
          { kicker: "On the record", title: record.name, body: win || record.headline },
          { kicker: "Origin", title: "Where this started", body: record.interview || origin },
          { kicker: "Now", title: "What comes next", body: record.building || record.story || win },
        ],
  };
}

export function uniqueSlug(records, name, ignoreId) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (records.some((row) => row.slug === slug && row.id !== ignoreId && row.status !== "deleted")) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export function draftRecord(records, body, extras) {
  const field = resolveField(body);
  const stamp = now();
  const references = parseReferences(body.references);
  return writeCopy({
    id: id("person"),
    slug: uniqueSlug(records, body.name),
    sku: extras.sku || "free",
    status: extras.status || "published",
    name: text(body.name, 80),
    email: text(extras.email || body.email, 120),
    headline: text(body.headline, 120),
    category: field.name,
    field: field.slug,
    city: text(body.city, 60),
    country: text(body.country, 60),
    website: text(body.website, 160),
    social: text(body.social, 80),
    achievements: parseAchievements(body.achievements),
    origin: text(body.origin),
    building: text(body.building),
    story: text(body.story),
    interview: text(body.interview),
    unknown: text(body.unknown),
    photoDataUrl: text(body.photoDataUrl, 900000),
    dek: text(body.dek, 280),
    body: Array.isArray(body.body) ? body.body.map((item) => text(item, 4000)).filter(Boolean) : [],
    pullQuote: "",
    linkedinPost: "",
    coverLine: text(body.headline, 120),
    issueNo: 0,
    pages: [],
    references,
    tags: Array.isArray(body.tags) ? body.tags.map((item) => slugify(item, 40)).filter(Boolean) : [],
    lane: extras.lane || "filed",
    verified: false,
    featuredUntil: null,
    badgeYear: new Date().getFullYear(),
    createdAt: stamp,
    paidAt: null,
    publishedAt: extras.status === "published" ? stamp : null,
    ownerUserId: extras.ownerUserId || extras.createdBy || null,
    createdBy: extras.createdBy || extras.ownerUserId || null,
    protected: false,
    protectionLevel: "none",
    needsReview: extras.needsReview !== false,
    currentRevisionId: null,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    updatedAt: stamp,
  });
}

export function publicRecord(row) {
  if (!row || row.status === "deleted") return null;
  const { email, ...rest } = row;
  return {
    ...rest,
    revisionCount: rest.revisionCount || 0,
    createdBy: rest.createdBy || rest.ownerUserId || null,
  };
}

export function isFeatured(row, at = Date.now()) {
  return Boolean(row.featuredUntil && new Date(row.featuredUntil).getTime() > at);
}

export function matchesField(row, field) {
  if (!field) return true;
  return row.field === field || slugify(row.category) === field;
}

export function matchesQuery(row, q) {
  if (!q) return true;
  const hay = [row.name, row.headline, row.dek, row.category, row.city, row.country, row.field, ...(row.tags || []), ...(row.body || [])]
    .join(" ")
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function sortOrganic(a, b) {
  const rank = (row) => (row.lane === "editorial" ? 0 : 1);
  const byLane = rank(a) - rank(b);
  if (byLane !== 0) return byLane;
  return new Date(b.publishedAt || b.createdAt).getTime() - new Date(a.publishedAt || a.createdAt).getTime();
}

export function filingTooThin(body) {
  return text(body.origin).length < 40;
}

export function similarRecords(records, name, ignoreSlug) {
  const needle = slugify(name);
  if (!needle) return [];
  return records
    .filter((row) => row.status === "published" && row.slug !== ignoreSlug)
    .map((row) => {
      const slug = row.slug;
      const score = slug === needle ? 3 : slug.includes(needle) || needle.includes(slug) ? 2 : row.name.toLowerCase().includes(name.toLowerCase()) ? 1 : 0;
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => ({ slug: item.row.slug, name: item.row.name, dek: item.row.dek, field: item.row.field }));
}
