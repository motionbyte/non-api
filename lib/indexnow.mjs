const KEY = process.env.INDEXNOW_KEY || "c4e8f1a29b6d47c0a3158e7d2f90b4c6";
const SITE = process.env.SITE_URL || process.env.PUBLIC_SITE_URL || "https://namesofnote.com";

export function pageUrl(slug) {
  return `${SITE.replace(/\/$/, "")}/people/${slug}`;
}

export async function announcePages(slugs) {
  if (process.env.NODE_ENV !== "production" && !process.env.INDEXNOW_KEY) return;
  const host = SITE.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host || host.startsWith("127.0.0.1") || host.startsWith("localhost")) return;
  const urlList = [...new Set((slugs || []).filter(Boolean).map((slug) => pageUrl(slug)))];
  if (!urlList.length) return;
  try {
    await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key: KEY,
        keyLocation: `${SITE.replace(/\/$/, "")}/${KEY}.txt`,
        urlList,
      }),
    });
  } catch {
    /* discovery ping is best-effort */
  }
}

export function announcePage(slug) {
  if (!slug) return;
  void announcePages([slug]);
}
