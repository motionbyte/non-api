import test from "node:test";
import assert from "node:assert/strict";

test("line diff marks added and removed lines", async () => {
  const { lineDiff } = await import("./diff.mjs");
  const rows = lineDiff("alpha\nbeta", "alpha\ngamma");
  assert.equal(rows.some((row) => row.type === "removed" && row.text === "beta"), true);
  assert.equal(rows.some((row) => row.type === "added" && row.text === "gamma"), true);
});

test("thin filings are rejected", async () => {
  const { filingTooThin } = await import("./copy.mjs");
  assert.equal(filingTooThin({ headline: "Founder", origin: "Hi" }), true);
  assert.equal(
    filingTooThin({
      headline: "Founder",
      origin: "Public lead that says who this person is in enough words for a crawler.",
    }),
    false,
  );
});

test("member cannot revert", async () => {
  const { can, PERMISSIONS } = await import("./rbac.mjs");
  assert.equal(can({ role: "member" }, PERMISSIONS.REVERT_EDIT), false);
  assert.equal(can({ role: "moderator" }, PERMISSIONS.REVERT_EDIT), true);
  assert.equal(can({ role: "desk" }, PERMISSIONS.MANAGE_USERS), true);
});
