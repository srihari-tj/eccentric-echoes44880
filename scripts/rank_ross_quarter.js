// scripts/rank_ross_quarter.js
import fs from "fs";
import path from "path";
import { quarterBounds } from "./utils/time.js";

const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";
const COMPANY_DIR = "data/derived/owner"; // optional owner enrichment (location/website) attach
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
function loadStarsNow(metaFile) {
  try {
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      return meta.stars_now ?? null;
    }
  } catch {}
  return null;
}
function loadOwner(ownerFile) {
  try {
    if (fs.existsSync(ownerFile)) {
      return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    }
  } catch {}
  return null;
}
function rankRossQuarter(year, q) {
  const { start: quarterStart, end: quarterEnd } = quarterBounds(year, q);
  const rows = [];
  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));
    const stars_now = loadStarsNow(path.join(META_DIR, f));
    const ownerInfo = loadOwner(path.join(COMPANY_DIR, f)); // optional attach
    const best = maxRossWindowForQuarter(p.cumulative, quarterStart, quarterEnd);
    if (!best.start || best.rel_gain <= 0) continue;
    rows.push({
      repo: p.repo,
      quarter: `${year}-Q${q}`,
      stars_now,
      best_window_start: best.start,
      best_window_end: best.end,
      window_start_stars: best.start_val,
      window_end_stars: best.end_val,
      abs_gain_90d: best.abs_gain,
      rel_gain_90d: Number(best.rel_gain.toFixed(6)),
      owner: ownerInfo ? {
        owner: ownerInfo.owner,
        owner_type: ownerInfo.owner_type,
        location: ownerInfo.location,
        website: ownerInfo.website
      } : null
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
