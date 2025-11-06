// scripts/aggregate_weekly.js
import fs from "fs";
import path from "path";
import { isoWeekKey, weeksToBounds } from "./utils/time.js";

const RAW = "data/raw/stars";
const OUT = "data/derived/weekly";
fs.mkdirSync(OUT, { recursive: true });

function toDaily(ts) {
  const m = new Map();
  for (const iso of ts) {
    const d = iso.slice(0,10);
    m.set(d, (m.get(d)||0)+1);
  }
  return [...m.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([date, daily])=>({date, daily}));
}
function toWeekly(daily) {
  const m = new Map();
  for (const r of daily) {
    const wk = isoWeekKey(r.date);
    m.set(wk, (m.get(wk)||0) + r.daily);
  }
  return [...m.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([week, total]) => ({week, total, ...weeksToBounds(week)}));
}
function toCumulative(daily) {
  let cum = 0;
  return daily.map(r => ({date:r.date, value:(cum += r.daily)}));
}

for (const f of fs.readdirSync(RAW)) {
  if (!f.endsWith(".json")) continue;
  const [owner, repo] = f.replace(".json","").split("__");
  const ts = JSON.parse(fs.readFileSync(path.join(RAW,f),"utf8")).sort();
  const daily = toDaily(ts);
  const weekly = toWeekly(daily);
  const cumulative = toCumulative(daily);
  const payload = { repo: `${owner}/${repo}`, weekly, cumulative };
  fs.writeFileSync(path.join(OUT, f), JSON.stringify(payload, null, 2));
  console.log("weekly wrote", owner+"/"+repo);
}
