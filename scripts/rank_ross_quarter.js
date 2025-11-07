// scripts/rank_ross_quarter.js
// ROSS-style ranking: for a given quarter, rank repos by the maximum 90-day relative star growth
// among all 90-day windows whose END falls within the target quarter. [ROSS methodology]
// Eligibility: window is valid only if stars_start >= 1000. A repo's score is the max over valid windows.
// Outputs top 100 to data/derived/quarter-ross/YYYY-Qn.json with detailed diagnostics.
//
// Usage: node scripts/rank_ross_quarter.js 2025 3
//
// Inputs:
// - data/derived/weekly/owner__repo.json (must contain cumulative array of {date, value})
// - data/derived/meta/owner__repo.json (optional; provides stars_now)
// Optional startup filter:
// - data/derived/startup_allowlist.txt (lines of owner/repo to include); if present, only include these.

import fs from "fs";
import path from "path";
import { quarterBounds } from "./utils/time.js";

const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";
const OUT_DIR = "data/derived/quarter-ross";
const ALLOWLIST = "data/derived/startup_allowlist.txt"; // optional

fs.mkdirSync(OUT_DIR, { recursive: true });

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST)) return null;
  const s = fs.readFileSync(ALLOWLIST, "utf8");
  const set = new Set();
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    set.add(t);
  }
  return set;
}

function cumAt(cumulative, dateISO) {
  // cumulative is sorted daily [{date, value}] (end-of-day cumulative)
  // Find last entry <= dateISO.
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
  // Consider window ends within [quarterStart .. quarterEnd], compute 90-day window starts.
  // Score = (stars_end - stars_start) / max(1, stars_start), only if stars_start >= 1000.
  // Return best {start, end, start_val, end_val, abs_gain, rel_gain}
  if (!cumulative || cumulative.length === 0) {
    return { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };
  }
  let best = { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };
  // Iterate over each calendar day end in the quarter as window end candidate
  for (let end = new Date(quarterStart + "T00:00:00Z"); end <= new Date(quarterEnd + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 1)) {
    const endISO = end.toISOString().slice(0,10);
    const startISO = addDays(endISO, -89); // 90-day window inclusive
    // If startISO precedes available cumulative start, cumAt will just return 0.
    const startVal = cumAt(cumulative, startISO);
    const endVal = cumAt(cumulative, endISO);
    const gain = endVal - startVal;
    if (startVal < 1000) continue; // ROSS eligibility for the window [web:171][web:177]
    const rel = startVal > 0 ? gain / startVal : 0;
    if (rel > best.rel_gain) {
      best = { rel_gain: rel, abs_gain: gain, start: startISO, end: endISO, start_val: startVal, end_val: endVal };
    }
  }
  return best;
}

function rankRossQuarter(year, q) {
  const { start: quarterStart, end: quarterEnd } = quarterBounds(year, q);
  const allow = loadAllowlist();
  const rows = [];

  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));
    if (allow && !allow.has(p.repo)) continue; // restrict to startup allowlist if provided

    // Load meta for stars_now if present
    let stars_now = null;
    const metaPath = path.join(META_DIR, f);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        stars_now = meta.stars_now ?? null;
      } catch {}
    }

    const best = maxRossWindowForQuarter(p.cumulative, quarterStart, quarterEnd);
    // Skip repos with zero rel_gain (either not enough stars at window start or no growth)
    if (!best.start || best.rel_gain <= 0) continue;

    rows.push({
      repo: p.repo,
      stars_now,
      quarter: `${year}-Q${q}`,
      best_window_start: best.start,
      best_window_end: best.end,
      window_start_stars: best.start_val,
      window_end_stars: best.end_val,
      abs_gain_90d: best.abs_gain,
      rel_gain_90d: Number(best.rel_gain.toFixed(6)) // relative growth rate over best 90d window
    });
  }

  rows.sort((a, b) => b.rel_gain_90d - a.rel_gain_90d);
  const top100 = rows.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));

  const outPath = path.join(OUT_DIR, `${year}-Q${q}.json`);
  fs.writeFileSync(outPath, JSON.stringify(top100, null, 2));
  console.log(`ROSS ranked ${year}-Q${q} -> ${outPath} (${top100.length} rows)`);
}

const year = Number(process.argv[2]);
const q = Number(process.argv[3]); // 1..4
if (!year || !q) {
  console.error("Usage: node scripts/rank_ross_quarter.js YEAR Q");
  process.exit(1);
}
rankRossQuarter(year, q);
