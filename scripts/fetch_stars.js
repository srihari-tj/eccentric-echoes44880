// scripts/fetch_stars.js
// Fetches stargazers with timestamps; supports chunking via CANDIDATES_CHUNK and rate-limit backoff. [web:1]
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const RAW_DIR = "data/raw/stars";
const DERIVED_DIR = "data/derived";
fs.mkdirSync(RAW_DIR, { recursive: true });

function listQuarterDirs() {
  if (!fs.existsSync(DERIVED_DIR)) return [];
  return fs.readdirSync(DERIVED_DIR).filter(d => /^\d{4}-Q[1-4]$/.test(d));
}

function loadCandidates() {
  const chunk = process.env.CANDIDATES_CHUNK;
  if (chunk && fs.existsSync(chunk)) {
    return JSON.parse(fs.readFileSync(chunk, "utf8"));
  }
  const dirs = listQuarterDirs().sort().reverse();
  for (const d of dirs) {
    const f = path.join(DERIVED_DIR, d, "candidates.json");
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    }
  }
  return [];
}

async function respectfulSleep(res, base=250) {
  const remaining = Number(res.headers.get("x-ratelimit-remaining") || "0");
  const reset = Number(res.headers.get("x-ratelimit-reset") || "0");
  if (res.status === 403 && reset) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 5000;
    console.log("rate-limited; sleeping", waitMs, "ms");
    await new Promise(r => setTimeout(r, waitMs));
  } else {
    const extra = remaining > 0 && remaining < 50 ? 2000 : 0;
    await new Promise(r => setTimeout(r, base + extra));
  }
}

async function fetchStargazerTimestamps(owner, repo, knownNewest) {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!GH_TOKEN) throw new Error("Missing GH_TOKEN");
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github.v3.star+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const acc = [];
  let page = 1;
  const per_page = 100;
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=${per_page}&page=${page}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) { await respectfulSleep(res); break; }
    if (res.status === 403) { await respectfulSleep(res); continue; }
    const items = await res.json();
    await respectfulSleep(res);
    if (!Array.isArray(items) || items.length === 0) break;
    let overlap = false;
    for (const it of items) {
      const ts = it.starred_at;
      if (!ts) continue;
      if (knownNewest && ts <= knownNewest) { overlap = true; break; }
      acc.push(ts);
    }
    if (overlap || items.length < per_page) break;
    page++;
  }
  return acc.sort();
}

(async () => {
  const candidates = loadCandidates();
  for (const { owner, repo } of candidates) {
    const fname = `${owner}__${repo}.json`;
    const fpath = path.join(RAW_DIR, fname);
    let existing = [];
    if (fs.existsSync(fpath)) existing = JSON.parse(fs.readFileSync(fpath, "utf8"));
    const knownNewest = existing.length ? existing[existing.length - 1] : null;
    try {
      const newest = await fetchStargazerTimestamps(owner, repo, knownNewest);
      if (newest.length > 0) {
        const merged = [...existing, ...newest].sort();
        fs.writeFileSync(fpath, JSON.stringify(merged, null, 2));
        console.log("updated", owner+"/"+repo, `+${newest.length}`);
      } else {
        console.log("no new stars", owner+"/"+repo);
      }
    } catch (e) {
      console.error("error", owner+"/"+repo, e.message);
    }
  }
})();
