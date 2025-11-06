// scripts/forecast.js
import fs from "fs";
import path from "path";

const WEEKLY_DIR = "data/derived/weekly";
const QUARTER_DIR = "data/derived/quarter";
const OUT_DIR = "data/derived/forecast";
fs.mkdirSync(OUT_DIR, { recursive: true });

function holtWintersAdditive(series, seasonLen=52, alpha=0.3, beta=0.1, gamma=0.3, horizon=12) {
  if (series.length < seasonLen + 2) return { forecast: Array(horizon).fill(0) };
  let level = series[0];
  let trend = series[1] - series[0];
  const season = series.slice(0, seasonLen).map((y)=>y - level);
  for (let t=0; t<series.length; t++) {
    const y = series[t];
    const sIdx = (t % seasonLen);
    const lastLevel = level;
    level = alpha * (y - season[sIdx]) + (1 - alpha) * (level + trend);
    trend = beta  * (level - lastLevel) + (1 - beta) * trend;
    season[sIdx] = gamma * (y - level) + (1 - gamma) * season[sIdx];
  }
  const fc = [];
  const lastIdx = series.length - 1;
  for (let h=1; h<=horizon; h++) {
    const sIdx = ((lastIdx + h) % seasonLen);
    fc.push((level + h * trend) + season[sIdx]);
  }
  return { forecast: fc.map(x => Math.max(0, Math.round(x))) };
}

function iso(d) { return d.toISOString().slice(0,10); }

function forecastTop(quarterKey, horizon=12) {
  const top = JSON.parse(fs.readFileSync(path.join(QUARTER_DIR, `${quarterKey}.json`),"utf8"));
  for (const r of top) {
    const fname = r.repo.replace("/","__") + ".json";
    const w = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, fname),"utf8"));
    const series = w.weekly.map(x => x.total);
    const { forecast } = holtWintersAdditive(series, 52, 0.3, 0.1, 0.3, horizon);

    const last = w.weekly.at(-1);
    const start = new Date(last.end + "T00:00:00Z");
    const out = {
      repo: r.repo,
      horizon_weeks: horizon,
      last_week: last?.week,
      forecast: forecast.map((pred, i) => {
        const weekStart = new Date(start);
        weekStart.setUTCDate(start.getUTCDate() + 1 + i*7);
        const weekEnd = new Date(weekStart);
        weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
        return { week: `+${i+1}`, start: iso(weekStart), end: iso(weekEnd), pred };
      })
    };
    fs.writeFileSync(path.join(OUT_DIR, fname), JSON.stringify(out, null, 2));
    console.log("forecasted", r.repo);
  }
}

forecastTop(process.argv[2], 12);
