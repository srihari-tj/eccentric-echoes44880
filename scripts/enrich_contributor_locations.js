// scripts/enrich_contributor_locations.js
// For each repo in data/derived/weekly, fetch contributor list and build a location distribution,
// then merge into data/derived/meta/owner__repo.json as { contributor_locations: { location: count, ... } }.
// Requires GH_TOKEN or GITHUB_TOKEN for higher rate limits.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";

function listRepos() {
  if (!fs.existsSync(WEEKLY_DIR)) return [];
  return fs.readdirSync(WEEKLY_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));
      const [owner, repo] = (p.repo || f.replace(".json","").replace("__","/")).split("/");
      return { owner, repo, file: f };
    });
}

function normalizeLocation(loc) {
  if (!loc) return "unknown";
  let s = String(loc).trim().toLowerCase();
  if (!s) return "unknown";
  // quick normalizations
  s = s.replace(/\s+/g, " ");
  const aliases = {
    "usa": "united states",
    "u.s.a.": "united states",
    "us": "united states",
    "united states of america": "united states",
    "uk": "united kingdom",
    "u.k.": "united kingdom",
    "uae": "united arab emirates",
    "russia": "russian federation"
  };
  if (aliases[s]) return aliases[s];
  return s;
}

async function respectfulSleep(ms=200){ await new Promise(r=>setTimeout(r,ms)); }

async function githubJson(url, GH_TOKEN) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {})
  };
  const res = await fetch(url, { headers });
  if (res.status === 204) return null;
  if (!res.ok) return { error: res.status };
  const j = await res.json();
  await respectfulSleep();
  return j;
}

async function listContributors(owner, repo, GH_TOKEN, maxPages=10) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100&page=${page}`;
    const j = await githubJson(url, GH_TOKEN); // array of contributors
    if (!Array.isArray(j) || j.length === 0) break;
    all.push(...j);
    if (j.length < 100) break;
  }
  // unique by login
  const seen = new Set();
  const uniq = [];
  for (const c of all) {
    if (c && c.login && !seen.has(c.login)) {
      uniq.push(c.login);
      seen.add(c.login);
    }
  }
  return uniq;
}

async function fetchUserLocation(login, GH_TOKEN) {
  const url = `https://api.github.com/users/${login}`;
  const j = await githubJson(url, GH_TOKEN);
  if (!j || j.error) return "unknown";
  return normalizeLocation(j.location || "");
}

function mergeIntoMeta(owner, repo, distribution) {
  const metaPath = path.join(META_DIR, `${owner}__${repo}.json`);
  let current = {};
  if (fs.existsSync(metaPath)) {
    try { current = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
  } else {
    // ensure minimal shape if meta wasn't created yet
    current = { owner, repo: `${owner}/${repo}` };
  }
  current.contributor_locations = distribution;
  current.contributor_locations_updated_at = new Date().toISOString();
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(current, null, 2));
}

(async () => {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const repos = listRepos();
  for (const { owner, repo } of repos) {
    try {
      const logins = await listContributors(owner, repo, GH_TOKEN, 10);
      const counts = Object.create(null);
      // Throttle: simple sequential user lookups; adjust if needed
      for (const login of logins) {
        const loc = await fetchUserLocation(login, GH_TOKEN);
        counts[loc] = (counts[loc] || 0) + 1;
      }
      mergeIntoMeta(owner, repo, counts);
      console.log(`locations ${owner}/${repo}: ${Object.keys(counts).length} regions, ${logins.length} users`);
    } catch (e) {
      console.error("location enrich error", `${owner}/${repo}`, e.message);
    }
  }
})();
