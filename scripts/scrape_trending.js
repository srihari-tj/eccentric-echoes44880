// scripts/scrape_trending.js
// Scrapes github.com/trending (overall + languages) weekly snapshot.
// Note: There is no official Trending API; scraping HTML is the path. [web:30]
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const OUT_DIR = "data/raw/weekly_trending";
fs.mkdirSync(OUT_DIR, { recursive: true });

const LANGS = [
  "javascript","typescript","python","go","rust","java","c%2B%2B","c","php","ruby","kotlin"
];

function isoWeekKeyUTC(date=new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  const thurs = new Date(d);
  thurs.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(thurs.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thurs - week1) / 604800000);
  const year = thurs.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, "0")}`;
}

async function fetchTrending(lang=null) {
  const base = "https://github.com/trending";
  const url = lang ? `${base}/${lang}?since=weekly` : `${base}?since=weekly`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "trending-scraper",
      "Accept": "text/html"
    }
  });
  const html = await res.text();
  // Heuristic parse: look for <h2 class="h3 lh-condensed"> <a href="/owner/repo">
  // Keep robust: extract /owner/repo from hrefs under trending list.
  const repos = [];
  const re = /<h2[^>]*>\s*<a[^>]*href="\/([^\/]+)\/([^"\/]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const owner = m[1];
    const repo = m[2];
    repos.push({ owner, repo });
  }
  return repos;
}

(async () => {
  const ww = isoWeekKeyUTC();
  const outPath = path.join(OUT_DIR, `${ww}.json`);
  const overall = await fetchTrending();
  const byLang = {};
  for (const L of LANGS) {
    try {
      byLang[decodeURIComponent(L)] = await fetchTrending(L);
    } catch (e) {
      byLang[decodeURIComponent(L)] = [];
    }
    await new Promise(r => setTimeout(r, 400));
  }
  const payload = {
    week: ww,
    captured_at: new Date().toISOString(),
    overall,
    by_language: byLang
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log("wrote weekly trending", ww, outPath);
})();
