// scripts/fetch_repo_meta.js
// Fetches per-repo metadata including current stargazers_count and writes to data/derived/meta/owner__repo.json.
// Uses GET /repos/{owner}/{repo} (no special Accept needed). Provides stars_now for downstream JSONs. [web:8]
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
  const dirs = listQuarterDirs().sort().reverse();
  for (const d of dirs) {
    const f = path.join(DERIVED_DIR, d, "candidates.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  return [];
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
  if (!res.ok) throw new Error(`repo ${owner}/${repo} ${res.status}`);
  const j = await res.json();
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
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error("meta error", `${owner}/${repo}`, e.message);
    }
  }
})();
