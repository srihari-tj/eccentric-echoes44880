// scripts/build_candidates.js
// Usage:
//   node scripts/build_candidates.js 2025 Q4
// Strategy:
// - If weekly trending snapshots exist for quarter, union them.
// - Else fall back to GitHub Search: top N by stars updated recently. [web:1]
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const TREND_DIR = "data/raw/weekly_trending";
const OUT_DIR = "data/derived";
fs.mkdirSync(OUT_DIR, { recursive: true });

function parseArgs() {
  const year = Number(process.argv[2]);
  const qstr = process.argv[3];
  if (!year || !qstr?.startsWith("Q")) {
    throw new Error("Usage: node scripts/build_candidates.js YEAR Qn (e.g., 2025 Q4)");
  }
  const q = Number(qstr.replace("Q",""));
  return { year, q };
}
function quarterBounds(year, q) {
  const starts = ["01-01","04-01","07-01","10-01"];
  const ends   = ["03-31","06-30","09-30","12-31"];
  return {
    start: `${year}-${starts[q-1]}`,
    end:   `${year}-${ends[q-1]}`
  };
}
function isoWeeksInQuarter(year, q) {
  const {start, end} = quarterBounds(year, q);
  // Naive generate all Mondays between start..end and convert to ISO-W key used by scraper
  const weeks = new Set();
  const s = new Date(start+"T00:00:00Z");
  const e = new Date(end+"T00:00:00Z");
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate()+7)) {
    const day = (d.getUTCDay()+6)%7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate()-day);
    weeks.add(isoWeekKey(monday.toISOString().slice(0,10)));
  }
  return [...weeks];
}
function isoWeekKey(isoDate) {
  const d = new Date(isoDate+"T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  const thurs = new Date(d);
  thurs.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(thurs.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thurs - week1) / 604800000);
  const year = thurs.getUTCFullYear();
  return `${year}-W${String(week).padStart(2,'0')}`;
}

function fromTrendingSnapshots(year, q) {
  const weeks = new Set(isoWeeksInQuarter(year, q));
  const candidates = new Set();
  if (!fs.existsSync(TREND_DIR)) return [];
  for (const f of fs.readdirSync(TREND_DIR)) {
    if (!f.endsWith(".json")) continue;
    const wk = f.replace(".json","");
    if (!weeks.has(wk)) continue;
    const p = JSON.parse(fs.readFileSync(path.join(TREND_DIR,f),"utf8"));
    for (const r of p.overall || []) {
      candidates.add(`${r.owner}/${r.repo}`);
    }
    for (const lang of Object.keys(p.by_language||{})) {
      for (const r of p.by_language[lang]||[]) {
        candidates.add(`${r.owner}/${r.repo}`);
      }
    }
  }
  return [...candidates].sort();
}

async function searchFallback(year, q, topN=5000) {
  // Use GitHub search to find popular repositories with recent activity. [web:1]
  // GitHub doesn't have "Trending" API; use search with sort=stars & pushed qualifier. [web:30][web:1]
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!GH_TOKEN) throw new Error("Missing GH_TOKEN for search fallback");
  const { start } = quarterBounds(year, q);
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const results = new Set();
  let page = 1;
  // GitHub search caps at 1000 results; iterate variants to approach topN. [web:1]
  // Partition by language buckets to expand coverage.
  const langs = ["javascript","typescript","python","go","rust","java","c%2B%2B","c","php","ruby","kotlin","shell","dart"];
  for (const L of langs) {
    page = 1;
    while (page <= 10 && results.size < topN) {
      const url = `https://api.github.com/search/repositories?q=language:${L}+pushed:>${start}&sort=stars&order=desc&per_page=100&page=${page}`;
      const res = await fetch(url, { headers });
      if (res.status === 422) break;
      const json = await res.json();
      const items = json.items || [];
      for (const it of items) results.add(`${it.owner.login}/${it.name}`);
      if (items.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return [...results].slice(0, topN).sort();
}

(async () => {
  const { year, q } = parseArgs();
  let list = fromTrendingSnapshots(year, q);
  if (list.length === 0) {
    console.log("No weekly trending snapshots found; using search fallback");
    list = await searchFallback(year, q, 5000);
  }
  const outDir = path.join(OUT_DIR, `${year}-Q${q}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "candidates.json");
  fs.writeFileSync(outPath, JSON.stringify(list.map(x => {
    const [owner, repo] = x.split("/");
    return { owner, repo };
  }), null, 2));
  console.log("candidate wrote", outPath, list.length);
})();
