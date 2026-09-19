const API = process.env.API || "http://127.0.0.1:4010";
const WEB = process.env.WEB || "http://127.0.0.1:3010";
const stamp = Date.now().toString(36);
const memberEmail = `reader-${stamp}@example.test`;
const memberPass = "ReaderPass26!";
let failed = 0;
const results = [];

function ok(name, pass, extra = "") {
  results.push({ name, pass, extra });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json, text };
}

async function html(path) {
  const res = await fetch(`${WEB}${path}`, { redirect: "manual" });
  const text = await res.text();
  return { res, text };
}

async function run() {
  const health = await req("/health");
  ok("API health", health.json?.ok === true && health.json.product === "names-of-note");

  const catalog = await req("/v1/catalog");
  ok("catalog + categories", Array.isArray(catalog.json?.skus) && Array.isArray(catalog.json?.categories));

  const records = await req("/v1/records");
  ok("published records", Array.isArray(records.json?.records) && records.json.records.length > 0);

  const search = await req("/v1/search?q=aman");
  ok("search people", search.json?.results?.some((item) => item.slug === "aman-raj"));

  const suggest = await req("/v1/suggest?name=Aman%20Raj");
  ok("duplicate suggest", (suggest.json?.matches || []).some((item) => item.slug === "aman-raj"));

  const sitemapApi = await req("/v1/sitemap");
  ok("api sitemap", Array.isArray(sitemapApi.json?.pages));

  const unauthMod = await req("/v1/moderation/queue");
  ok("moderation requires auth", unauthMod.res.status === 403 && unauthMod.json.code === "PERMISSION_DENIED");

  const unauthEdit = await req("/v1/edit", { method: "POST", body: JSON.stringify({ slug: "aman-raj" }) });
  ok("edit requires auth", unauthEdit.res.status === 401);

  const signup = await req("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ name: "Test Reader", email: memberEmail, password: memberPass }),
  });
  ok("signup", Boolean(signup.json?.token && signup.json?.user?.username), signup.json?.error);
  const memberToken = signup.json?.token;
  const member = signup.json?.user;
  const auth = { Authorization: `Bearer ${memberToken}` };

  const badLogin = await req("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: memberEmail, password: "wrong-password" }),
  });
  ok("bad login rejected", badLogin.res.status === 401);

  const login = await req("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: memberEmail, password: memberPass }),
  });
  ok("member login", Boolean(login.json?.token));

  const me = await req("/v1/me", { headers: auth });
  ok("me payload", me.json?.user?.email === memberEmail && Array.isArray(me.json?.user?.permissions));

  const memberMod = await req("/v1/moderation/queue", { headers: auth });
  ok("member cannot moderate", memberMod.res.status === 403);

  const fileName = `Ada Lovelace ${stamp}`;
  const filed = await req("/v1/file", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: fileName,
      headline: "Mathematician",
      category: "science",
      city: "London",
      country: "England",
      achievements: "Notes on Babbage's engine",
      origin: "Wrote the first published computer algorithm.",
      building: "The analytical engine as a public idea.",
    }),
  });
  ok("file a page", Boolean(filed.json?.slug), filed.json?.error);
  const slug = filed.json?.slug;

  const dup = await req("/v1/file", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: fileName, headline: "Mathematician", category: "science" }),
  });
  ok("duplicate filing blocked", dup.res.status === 409 && dup.json?.code === "POSSIBLE_DUPLICATE");

  const page = await req(`/v1/records/${slug}`);
  ok("read filed page", page.json?.record?.name === fileName && page.json.record.status === "published");

  const edit1 = await req("/v1/edit", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      slug,
      headline: "Mathematician and writer",
      dek: "The notes that made calculation a literary act.",
      origin: "Wrote on Babbage.",
      building: "A public algorithm.",
      body: "Ada Lovelace translated Menabrea and added notes that read the engine as more than a calculator.\n\nNames of Note files that public record.",
      summary: "Expanded the dek and body",
      expectedRevisionId: page.json?.record?.currentRevisionId,
    }),
  });
  ok("member edit is pending", edit1.json?.pending === true && Boolean(edit1.json?.revisionId), edit1.json?.error);

  const afterPending = await req(`/v1/records/${slug}`);
  ok(
    "pending edit does not publish",
    afterPending.json?.record?.headline === "Mathematician",
    afterPending.json?.record?.headline,
  );

  const watch = await req("/v1/watch", { method: "POST", headers: auth, body: JSON.stringify({ slug }) });
  ok("watch page", watch.json?.watching === true);

  const watchlist = await req("/v1/watchlist", { headers: auth });
  ok("watchlist contains page", (watchlist.json?.watchlist || []).some((item) => item.slug === slug));

  const talk = await req("/v1/talk", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, body: `Need a source on the Notes. @${member?.username}` }),
  });
  ok("post talk", Boolean(talk.json?.talk?.id));

  const flag = await req("/v1/flags", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, reason: "Missing a citation for the Notes.", kind: "missing_citation" }),
  });
  ok("flag page", Boolean(flag.json?.flag?.id));

  const dupFlag = await req("/v1/flags", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, reason: "Missing a citation for the Notes." }),
  });
  ok("duplicate flag blocked", dupFlag.res.status === 409);

  const draft = await req("/v1/drafts", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, name: fileName, headline: "Draft headline" }),
  });
  ok("autosave draft", Boolean(draft.json?.draft?.id));

  const drafts = await req("/v1/drafts", { headers: auth });
  ok("list drafts", (drafts.json?.drafts || []).length >= 1);

  const jsUrl = await req("/v1/edit", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, website: "javascript:alert(1)", summary: "bad url" }),
  });
  const afterJs = await req(`/v1/records/${slug}`);
  ok("javascript url stripped", afterJs.json?.record?.website === "" || !afterJs.json?.record?.website);

  const conflict = await req("/v1/edit", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      slug,
      headline: "stale",
      summary: "stale parent",
      expectedRevisionId: "rev-does-not-exist",
    }),
  });
  ok("revision conflict", conflict.res.status === 409 && conflict.json?.code === "REVISION_CONFLICT");

  const profile = await req(`/v1/users/${member.username}`);
  ok("public profile", profile.json?.profile?.username === member.username);

  const contrib = await req(`/v1/users/${member.username}/contributions`);
  ok("contributions list", (contrib.json?.contributions || []).length >= 1);

  const modLogin = await req("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "moderator@namesofnote.com", password: "NoteMod26!" }),
  });
  ok("moderator login", Boolean(modLogin.json?.token), modLogin.json?.error);
  const modAuth = { Authorization: `Bearer ${modLogin.json?.token}` };

  const queue = await req("/v1/moderation/queue", { headers: modAuth });
  ok("moderator queue", Array.isArray(queue.json?.pendingEdits) && Array.isArray(queue.json?.flags));
  const pending = (queue.json?.pendingEdits || []).find((item) => item.summary === "Expanded the dek and body");
  ok("pending edit in queue", Boolean(pending), JSON.stringify(queue.json?.pendingEdits?.slice(0, 2)));

  if (pending) {
    const approve = await req("/v1/moderation/act", {
      method: "POST",
      headers: modAuth,
      body: JSON.stringify({ action: "approve-edit", id: pending.id }),
    });
    ok("approve pending edit", approve.json?.ok === true || approve.json?.slug === slug, approve.json?.error);
  }

  const published = await req(`/v1/records/${slug}`);
  ok("approved edit is live", published.json?.record?.headline === "Mathematician and writer", published.json?.record?.headline);

  const notes = await req("/v1/notifications", { headers: auth });
  ok("contributor notified of approval", (notes.json?.notifications || []).some((item) => item.type === "approved"));

  const revisions = await req(`/v1/records/${slug}/revisions`);
  ok("revision history", (revisions.json?.revisions || []).length >= 2);
  const current = revisions.json?.revisions?.find((item) => item.current);
  const older = (revisions.json?.revisions || []).find((item) => !item.current && item.status === "approved") || revisions.json?.revisions?.[1];
  if (current && older) {
    const diff = await req(`/v1/records/${slug}/revisions/${older.id}/diff?to=${current.id}`);
    ok("visual diff rows", Array.isArray(diff.json?.diff) && diff.json.diff.length > 0);
  } else {
    ok("visual diff rows", false, "missing revisions to compare");
  }

  const revert = await req("/v1/moderation/act", {
    method: "POST",
    headers: modAuth,
    body: JSON.stringify({ action: "revert", slug, revisionId: older?.id, reason: "Restore earlier filing copy" }),
  });
  ok("revert creates new revision", Boolean(revert.json?.slug), revert.json?.error);
  const afterRevert = await req(`/v1/records/${slug}/revisions`);
  ok("history preserved after revert", (afterRevert.json?.revisions || []).length > (revisions.json?.revisions || []).length);

  const protect = await req("/v1/moderation/act", {
    method: "POST",
    headers: modAuth,
    body: JSON.stringify({ action: "protect", slug, reason: "Featured name" }),
  });
  ok("protect page", protect.res.ok);
  const lockedEdit = await req("/v1/edit", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ slug, headline: "should fail", summary: "vandalism attempt" }),
  });
  ok("locked page blocks member", lockedEdit.res.status === 403);

  const unprotect = await req("/v1/moderation/act", {
    method: "POST",
    headers: modAuth,
    body: JSON.stringify({ action: "unprotect", slug }),
  });
  ok("unprotect page", unprotect.res.ok);

  const resolve = await req("/v1/moderation/act", {
    method: "POST",
    headers: modAuth,
    body: JSON.stringify({ action: "resolve-flag", id: flag.json?.flag?.id }),
  });
  ok("resolve flag", resolve.json?.ok === true);

  const memberRevert = await req("/v1/moderation/act", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ action: "revert", slug }),
  });
  ok("member cannot revert via API", memberRevert.res.status === 403);

  const deskLogin = await req("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "desk@namesofnote.com", password: "DeskNote26!" }),
  });
  const deskAuth = { Authorization: `Bearer ${deskLogin.json?.token}` };
  const overview = await req("/v1/admin/overview", { headers: deskAuth });
  ok("desk admin overview", typeof overview.json?.articles === "number");
  const memberOverview = await req("/v1/admin/overview", { headers: auth });
  ok("member cannot open admin", memberOverview.res.status === 403);

  const pw = await req("/v1/me/password", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ current: memberPass, next: "ReaderPass27!" }),
  });
  ok("change password", pw.json?.ok === true, pw.json?.error);

  const home = await html("/");
  ok("home SSR", home.res.status === 200 && home.text.includes("Names of Note") && home.text.includes("Search a name"));

  const person = await html("/people/malala-yousafzai");
  ok(
    "person SEO",
    person.text.includes("<title>Malala Yousafzai — Names of Note</title>") &&
      person.text.includes('rel="canonical"') &&
      person.text.includes('"@type":"Person"') &&
      person.text.includes("History"),
  );

  const robots = await html("/robots.txt");
  ok("robots disallow private", robots.text.includes("Disallow: /desk") && robots.text.includes("Disallow: /moderation"));

  const sitemap = await html("/sitemap.xml");
  ok("sitemap xml", sitemap.res.status === 200 && sitemap.text.includes("/directory"));

  const missing = await html("/people/this-name-does-not-exist");
  ok("article 404", missing.res.status === 404 && missing.text.includes("not filed"));

  const searchPage = await html("/search?q=malala");
  ok("search page", searchPage.res.status === 200 && searchPage.text.includes("Look up") && searchPage.text.includes("Malala Yousafzai"));

  const desk = await html("/desk");
  ok("desk redirects when signed out", desk.res.status === 307 || desk.res.status === 302);

  const history = await html(`/people/${slug}/history`);
  ok("history page", history.res.status === 200 && history.text.includes("History"));

  const directory = await html("/directory");
  ok("directory", directory.res.status === 200 && directory.text.includes("Directory"));

  console.log(`\n${results.filter((row) => row.pass).length}/${results.length} passed`);
  if (failed) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
