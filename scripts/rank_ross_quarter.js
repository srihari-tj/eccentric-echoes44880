// scripts/rank_ross_quarter.js
// ROSS-style ranking:
// For a given quarter, compute for each repo the maximum relative 90-day star growth
// over all 90-day windows whose END lies inside the quarter, with eligibility requiring
// at least 1000 stars at the window start, then rank by that relative growth. [ROSS methodology]
// Outputs Top-100 to data/derived/quarter-ross/YYYY-Qn.json with diagnostic fields. [web:171]
//
// Usage:
//   node scripts/rank_ross_quarter.js 2025 3
//
// Inputs required:
// - data/derived/weekly/owner__repo.json (weekly + cumulative daily series) [web:29]
// Optional inputs:
// - data/derived/meta/owner__repo.json for stars_now passthrough [web:8]
// - data/derived/company/owner__repo.json if you want to enforce is_startup && is_funded filters [web:8]
//
// Notes:
// - This script does not fetch data; it only reads local derived JSONs and writes rankings. [web:29]

import fs from "fs";
import path from "path";
import { quarterBounds } from "./utils/time.js"; // uses your existing time helpers [web:29]

const WEEKLY_DIR = "data/derived/weekly"; // source per-repo weekly + cumulative JSONs [web:29]
const META_DIR = "data/derived/meta";     // optional stars_now per repo [web:8]
const COMPANY_DIR = "data/derived/company"; // optional enrichment per repo (startup/funded/website) [web:8]
const OUT_DIR = "data/derived/quarter-ross"; // ROSS outputs live here [web:171]

fs.mkdirSync(OUT_DIR, { recursive: true }); // ensure output dir exists [web:29]

// Read last cumulative value on or before a given ISO date (YYYY-MM-DD). [web:29]
function cumAt(cumulative, dateISO) {
  let last = 0;
  for (const r of cumulative) {
    if (r.date <= dateISO) last = r.value;
    else break;
  }
  return last;
}

// Add N days to an ISO date and return ISO YYYY-MM-DD. [web:29]
function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

// Compute best 90-day window within the quarter by relative growth,
// requiring window start stars >= 1000. Returns diagnostics and score. [web:171]
function maxRossWindowForQuarter(cumulative, quarterStart, quarterEnd) {
  if (!Array.isArray(cumulative) || cumulative.length === 0) {
    return { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };
  }

  let best = { rel_gain: 0, abs_gain: 0, start: null, end: null, start_val: 0, end_val: 0 };

  // Iterate calendar days in the quarter as candidate window ends. [web:171]
  for (let end = new Date(quarterStart + "T00:00:00Z"); end <= new Date(quarterEnd + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 1)) {
    const endISO = end.toISOString().slice(0,10);
    const startISO = addDays(endISO, -89); // 90-day inclusive window [web:171]

    const startVal = cumAt(cumulative, startISO);
    const endVal = cumAt(cumulative, endISO);
    const gain = endVal - startVal;

    // Eligibility: window valid only if startVal >= 1000. [web:171]
    if (startVal < 1000) continue;

    const rel = startVal > 0 ? gain / startVal : 0;
    if (rel > best.rel_gain) {
      best = { rel_gain: rel, abs_gain: gain, start: startISO, end: endISO, start_val: startVal, end_val: endVal };
    }
  }

  return best;
}

// Try to load stars_now from meta if available. [web:8]
function loadStarsNow(metaFile) {
  try {
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      return meta.stars_now ?? null;
    }
  } catch {}
  return null;
}

// Try to load company enrichment for startup/funded filtering and website/name. [web:8]
function loadCompanyInfo(companyFile) {
  try {
    if (fs.existsSync(companyFile)) {
      return JSON.parse(fs.readFileSync(companyFile, "utf8"));
    }
  } catch {}
  return null;
}

function rankRossQuarter(year, q, opts = { requireStartupFunded: false }) {
  const { start: quarterStart, end: quarterEnd } = quarterBounds(year, q); // e.g., Q1 Jan-1..Mar-31 [web:29]
  const rows = [];

  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;

    // Load weekly-derived payload (must contain cumulative array). [web:29]
    const weeklyPath = path.join(WEEKLY_DIR, f);
    const p = JSON.parse(fs.readFileSync(weeklyPath, "utf8"));

    // Optional: load company enrichment for filtering. [web:8]
    let companyInfo = null;
    if (opts.requireStartupFunded) {
      companyInfo = loadCompanyInfo(path.join(COMPANY_DIR, f));
      if (!companyInfo || !(companyInfo.is_startup && companyInfo.is_funded)) {
        continue; // enforce startup && funded if requested [web:171]
      }
    } else {
      companyInfo = loadCompanyInfo(path.join(COMPANY_DIR, f)); // attach if present [web:8]
    }

    // Optional: stars_now passthrough from meta. [web:8]
    const stars_now = loadStarsNow(path.join(META_DIR, f));

    // Compute best 90d relative window ending inside the quarter. [web:171]
    const best = maxRossWindowForQuarter(p.cumulative, quarterStart, quarterEnd);

    // Skip repos with no valid 90d window or zero/negative relative gain. [web:171]
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
      company: companyInfo
        ? {
            name: companyInfo.company_name ?? null,
            website: companyInfo.website ?? null,
            founded_year_guess: companyInfo.founded_year_guess ?? null,
            is_startup: companyInfo.is_startup ?? null,
            is_funded: companyInfo.is_funded ?? null
          }
        : null
    });
  }

  // Rank by relative growth descending, output Top-100. [web:171]
  rows.sort((a, b) => b.rel_gain_90d - a.rel_gain_90d);
  const top100 = rows.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));

  const outPath = path.join(OUT_DIR, `${year}-Q${q}.json`);
  fs.writeFileSync(outPath, JSON.stringify(top100, null, 2));
  console.log(`ROSS ranked ${year}-Q${q} -> ${outPath} (${top100.length} rows)`);
}

// Entrypoint: node scripts/rank_ross_quarter.js YEAR Q [--startup-funded]
// If --startup-funded is present, require company.is_startup && company.is_funded. [web:171]
const year = Number(process.argv[2]);
const q = Number(process.argv[3]); // 1..4
const requireStartupFunded = process.argv.includes("--startup-funded");
if (!year || !q) {
  console.error("Usage: node scripts/rank_ross_quarter.js YEAR Q [--startup-funded]");
  process.exit(1);
}
rankRossQuarter(year, q, { requireStartupFunded });
