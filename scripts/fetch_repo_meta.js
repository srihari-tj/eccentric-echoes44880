// scripts/fetch_repo_meta.js
// Fetches repo metadata (stars_now/forks/issues/subscribers) into data/derived/meta/owner__repo.json. [web:8]
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const DERIVED_DIR = "data/derived";
const META_DIR = "data/derived/meta";
fs.mkdirSync(META_DIR, { recursive: true });

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
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
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

async function fetchRepo(owner, repo) {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {})
  };
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    await respectfulSleep(res);
    throw new Error(`repo ${owner}/${repo} ${res.status}`);
  }
  const j = await res.json();
  await respectfulSleep(res);
  return {
    repo: `${owner}/${repo}`,
    stars_now: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
    open_issues: j.open_issues_count ?? 0,
    subscribers: j.subscribers_count ?? 0,
    default_branch: j.default_branch ?? "main",
    fetched_at: new Date().toISOString()
  };
}

(async () => {
  const candidates = loadCandidates();
  for (const { owner, repo } of candidates) {
    const outPath = path.join(META_DIR, `${owner}__${repo}.json`);
    try {
      const meta = await fetchRepo(owner, repo);
      fs.writeFileSync(outPath, JSON.stringify(meta, null, 2));
      console.log("meta", meta.repo, meta.stars_now);
    } catch (e) {
      console.error("meta error", `${owner}/${repo}`, e.message);
    }
  }
})();
