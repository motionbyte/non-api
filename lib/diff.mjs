export function lineDiff(before, after) {
  const a = String(before || "").split(/\n/);
  const b = String(after || "").split(/\n/);
  const max = Math.max(a.length, b.length);
  const rows = [];
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      if (left != null) rows.push({ type: "same", text: left });
    } else {
      if (left != null && left !== "") rows.push({ type: "removed", text: left });
      if (right != null && right !== "") rows.push({ type: "added", text: right });
    }
  }
  return rows;
}

export function snapshotText(snap) {
  if (!snap) return "";
  const body = Array.isArray(snap.body) ? snap.body.join("\n") : String(snap.body || "");
  return [
    snap.name,
    snap.headline,
    snap.dek,
    snap.city,
    snap.country,
    (snap.achievements || []).map((item) => item.text || item).join("\n"),
    snap.origin,
    snap.building,
    snap.story,
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

export function diffSnapshots(previous, next) {
  return lineDiff(snapshotText(previous), snapshotText(next));
}
