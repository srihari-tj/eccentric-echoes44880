// scripts/rank_quarter.js
import fs from "fs";
import path from "path";
import { quarterBounds } from "./utils/time.js";

const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";
const OUT_DIR = "data/derived/quarter";
fs.mkdirSync(OUT_DIR, { recursive: true });

function cumAt(cumulative, date) {
  let last = 0;
  for (const r of cumulative) {
    if (r.date <= date) last = r.value;
    else break;
  }
  return last;
}

function rankQuarter(year, q) {
  const {start, end} = quarterBounds(year, q);
  const rows = [];

  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR,f),"utf8"));
    const startVal = cumAt(p.cumulative, start);
    const endVal   = cumAt(p.cumulative, end);

    // Prefer stars_now from weekly payload; fallback to meta file if needed
    let stars_now = p.stars_now ?? null;
    if (stars_now == null) {
      try {
        const metaPath = path.join(META_DIR, f);
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          stars_now = meta.stars_now ?? null;
        }
      } catch {}
    }

    rows.push({
      repo: p.repo,
      cumulative_start: startVal,
      cumulative_end: endVal,
      delta: endVal - startVal,
      stars_now
    });
  }

  rows.sort((a,b)=>b.delta - a.delta);
  const top100 = rows.slice(0,100).map((r,i)=>({...r, rank:i+1}));
  fs.writeFileSync(
    path.join(OUT_DIR, `${year}-Q${q}.json`),
    JSON.stringify(top100, null, 2)
  );
  console.log(`ranked ${year}-Q${q}`);
}

const year = Number(process.argv[2]);
const q = Number(process.argv[3]); // 1..4
rankQuarter(year, q);
