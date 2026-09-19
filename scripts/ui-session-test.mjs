const WEB = "http://127.0.0.1:3010";
const API = "http://127.0.0.1:4010";

function ok(name, pass, extra = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!pass) process.exitCode = 1;
}

async function page(path, cookie) {
  const res = await fetch(`${WEB}${path}`, {
    headers: cookie ? { Cookie: `non_session=${cookie}` } : {},
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, text };
}

const login = await fetch(`${API}/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "moderator@namesofnote.com", password: "NoteMod26!" }),
});
const session = await login.json();
if (!session.token) {
  console.error("moderator login failed");
  process.exit(1);
}

const desk = await page("/desk", session.token);
ok("desk signed in", desk.status === 200 && desk.text.includes("Community Moderator") && desk.text.includes("Watchlist") && desk.text.includes("Moderation queue"));
ok("desk noindex", desk.text.includes("noindex") || desk.text.includes('"robots":{"index":false') || /name="robots"[^>]*noindex/i.test(desk.text));

const mod = await page("/moderation", session.token);
ok("moderation queue ui", mod.status === 200 && mod.text.includes("Pending edits") && mod.text.includes("Needs review") && mod.text.includes("Flags"));

const watch = await page("/watchlist", session.token);
ok("watchlist ui", watch.status === 200 && watch.text.includes("Watchlist"));

const settings = await page("/settings/security", session.token);
ok("settings ui", settings.status === 200 && settings.text.includes("Password") && settings.text.includes("Leave the desk"));

const join = await page("/join", session.token);
ok("join signed in", join.status === 200 && join.text.includes("Full name") && join.text.includes("File"));

const person = await page("/people/ada-lovelace-mu8d0c7x", session.token);
ok("article actions when signed in", person.status === 200 && person.text.includes("Edit") && person.text.includes("Watch") && person.text.includes("History"));

const edit = await page("/people/ada-lovelace-mu8d0c7x/edit", session.token);
ok("editor ui", edit.status === 200 && edit.text.includes("Edit summary") && edit.text.includes("Submit edit"));

const missing = await page("/people/no-such-name-xyz");
ok("404 copy", missing.status === 404 && missing.text.includes("not filed") && missing.text.includes("File this name"));

const search = await page("/search?q=Ada");
ok("search results ui", search.status === 200 && search.text.includes("Look up") && search.text.includes("Ada Lovelace"));

const editorialSearch = await page("/search?q=malala");
ok("editorial search", editorialSearch.status === 200 && editorialSearch.text.includes("Malala Yousafzai") && !editorialSearch.text.includes("No results"));

const profile = await page("/user/community-moderator");
ok("moderator profile", profile.status === 200 && profile.text.includes("Community Moderator") && profile.text.includes("community-moderator") && !profile.text.includes("passwordHash"));

const contrib = await page("/user/community-moderator/contributions");
ok("contributions ui", contrib.status === 200 && contrib.text.includes("Contributions") && contrib.text.includes("Community Moderator"));

const home = await page("/");
ok("home", home.status === 200 && home.text.includes("The free encyclopedia of people") && home.text.includes("Search a name"));

const directory = await page("/directory?q=Malala");
ok("directory search", directory.status === 200 && directory.text.includes("Malala Yousafzai"));

const categories = await page("/categories");
ok("categories", categories.status === 200 && categories.text.includes("Categories"));

const stories = await page("/stories");
ok("stories", stories.status === 200);

const about = await page("/about");
ok("about", about.status === 200);

const contact = await page("/contact");
ok("contact", contact.status === 200);

const boost = await page("/boost");
ok("boost", boost.status === 200);

const signIn = await page("/sign-in");
ok("sign-in", signIn.status === 200 && signIn.text.includes("Sign in") && signIn.text.includes("password"));

const signUp = await page("/sign-up");
ok("sign-up", signUp.status === 200 && signUp.text.includes("Create"));

const joinOut = await page("/join");
ok("join signed out", joinOut.status === 200 && joinOut.text.includes("Sign in") && joinOut.text.includes("Sign up"));

const malala = await page("/people/malala-yousafzai");
ok(
  "editorial article",
  malala.status === 200 && malala.text.includes("Malala Yousafzai") && malala.text.includes("Talk") && malala.text.includes("History") && malala.text.includes('"@type":"Person"'),
);

const editorialHistory = await page("/people/malala-yousafzai/history");
ok("editorial history page", editorialHistory.status === 200 && editorialHistory.text.includes("History"));

const deskOut = await page("/desk");
ok("desk redirect signed out", deskOut.status === 307 || deskOut.status === 302);

const watchOut = await page("/watchlist");
ok("watchlist redirect signed out", watchOut.status === 307 || watchOut.status === 302);

const settingsOut = await page("/settings/security");
ok("settings redirect signed out", settingsOut.status === 307 || settingsOut.status === 302);

const editOut = await page("/people/malala-yousafzai/edit");
ok("edit redirect signed out", editOut.status === 307 || editOut.status === 302);

const modsOut = await page("/moderation");
ok("moderation redirect signed out", modsOut.status === 307 || modsOut.status === 302);

const robots = await page("/robots.txt");
ok("robots", robots.text.includes("Disallow: /desk") && robots.text.includes("Sitemap:"));

const sitemap = await page("/sitemap.xml");
ok("sitemap", sitemap.status === 200 && sitemap.text.includes("/people/malala-yousafzai"));
