// scripts/rank_ross_quarter.js
// ROSS-style ranking with repo meta embedded in output rows.
// For a given quarter, compute maximum relative 90-day star growth among windows ending inside the quarter,
// require window start stars >= 1000, and attach stars_now, forks, open_issues, subscribers (from meta).
//
// Usage: node scripts/rank_ross_quarter.js YEAR Q
//
// Inputs:
// - data/derived/weekly/owner__repo.json (must include 'cumulative' series)
// - data/derived/meta/owner__repo.json (provides stars_now, forks, open_issues, subscribers)
// Optional attach (owner context):
// - data/derived/owner/owner__repo.json (location, website, etc.)

import fs from "fs";
import path from "path";
import { quarterBounds } from "./utils/time.js";

const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";
const OWNER_DIR = "data/derived/owner";
const OUT_DIR = "data/derived/quarter-ross";

fs.mkdirSync(OUT_DIR, { recursive: true });

function cumAt(cumulative, dateISO) {
  let last = 0;
  for (const r of cumulative) {
    if (r.date <= dateISO) last = r.value;
    else break;
  }
  return last;
}
function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function maxRossWindowForQuarter(cumulative, quarterStart, quarterEnd) {
  if (!Array.isArray(cumulative) || cumulative.length === 0) {
    return { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };
  }
  let best = { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };
  for (let end = new Date(quarterStart + "T00:00:00Z"); end <= new Date(quarterEnd + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 1)) {
    const endISO = end.toISOString().slice(0,10);
    const startISO = addDays(endISO, -89);
    const startVal = cumAt(cumulative, startISO);
    const endVal = cumAt(cumulative, endISO);
    const gain = endVal - startVal;
    if (startVal < 1000) continue;
    const rel = startVal > 0 ? gain / startVal : 0;
    if (rel > best.rel_gain) best = { rel_gain: rel, abs_gain: gain, start: startISO, end: endISO, start_val: startVal, end_val: endVal };
  }
  return best;
}
function loadMeta(metaFile) {
  try {
    if (!fs.existsSync(metaFile)) return null;
    const m = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return {
      stars_now: m.stargazers_count ?? m.stars_now ?? null,
      forks: m.forks_count ?? m.forks ?? null,
      open_issues: m.open_issues_count ?? m.open_issues ?? null,
      subscribers: m.subscribers_count ?? m.subscribers ?? null
    };
  } catch { return null; }
}
function loadOwner(ownerFile) {
  try {
    if (!fs.existsSync(ownerFile)) return null;
    const o = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    return {
      owner: o.owner ?? null,
      owner_type: o.owner_type ?? null,
      location: o.location ?? null,
      website: o.website ?? null
    };
  } catch { return null; }
}

function rankRossQuarter(year, q) {
  const { start: quarterStart, end: quarterEnd } = quarterBounds(year, q);
  const rows = [];

  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const weekly = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));

    const meta = loadMeta(path.join(META_DIR, f));           // repo meta (stars_now + counts)
    const ownerInfo = loadOwner(path.join(OWNER_DIR, f));    // optional owner context

    const best = maxRossWindowForQuarter(weekly.cumulative, quarterStart, quarterEnd);
    if (!best.start || best.rel_gain <= 0) continue;

    rows.push({
      repo: weekly.repo,
      quarter: `${year}-Q${q}`,
      // Embedded repo meta
      stars_now: meta?.stars_now ?? null,
      forks: meta?.forks ?? null,
      open_issues: meta?.open_issues ?? null,
      subscribers: meta?.subscribers ?? null,
      // ROSS diagnostics
      best_window_start: best.start,
      best_window_end: best.end,
      window_start_stars: best.start_val,
      window_end_stars: best.end_val,
      abs_gain_90d: best.abs_gain,
      rel_gain_90d: Number(best.rel_gain.toFixed(6)),
      // Optional owner context (non-blocking)
      owner: ownerInfo ?? null
    });
  }

  rows.sort((a, b) => b.rel_gain_90d - a.rel_gain_90d);
  const top100 = rows.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));

  const outPath = path.join(OUT_DIR, `${year}-Q${q}.json`);
  fs.writeFileSync(outPath, JSON.stringify(top100, null, 2));
  console.log(`ROSS ranked ${year}-Q${q} -> ${outPath} (${top100.length} rows)`);
}

const year = Number(process.argv[2]);
const q = Number(process.argv[3]);
if (!year || !q) { console.error("Usage: node scripts/rank_ross_quarter.js YEAR Q"); process.exit(1); }
rankRossQuarter(year, q);
