// scripts/fetch_repo_meta.js
// Enrich and store repo metadata only in meta files to keep downstream outputs lean.
// Writes data/derived/meta/owner__repo.json with expanded fields.

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

async function respectfulSleep(ms=200){ await new Promise(r=>setTimeout(r,ms)); }

async function fetchRepo(owner, repo) {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {})
  };
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    await respectfulSleep();
    throw new Error(`repo ${owner}/${repo} ${res.status}`);
  }
  const j = await res.json();
  await respectfulSleep();

  // Normalize and select useful fields
  return {
    // identification
    owner,
    repo: `${owner}/${repo}`,
    name: j.name ?? repo,
    full_name: j.full_name ?? `${owner}/${repo}`,

    // descriptive
    description: j.description ?? null,
    homepage: j.homepage || j.html_url || null,
    language: j.language ?? null,
    license: j.license?.spdx_id ?? null,
    topics: Array.isArray(j.topics) ? j.topics : null,

    // lifecycle flags
    default_branch: j.default_branch ?? "main",
    archived: !!j.archived,
    disabled: !!j.disabled,

    // activity and size
    created_at: j.created_at ?? null,
    pushed_at: j.pushed_at ?? null,
    size: j.size ?? null,

    // counters
    stars_now: j.stargazers_count ?? 0,
    forks: j.forks_count ?? j.network_count ?? 0,
    open_issues: j.open_issues_count ?? 0,
    subscribers: j.subscribers_count ?? 0,
    watchers: j.watchers_count ?? null,

    // URLs
    html_url: j.html_url ?? `https://github.com/${owner}/${repo}`,
    api_url: j.url ?? url,

    // fetch meta
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
      console.log("meta", meta.repo, "stars:", meta.stars_now, "lang:", meta.language, "license:", meta.license);
    } catch (e) {
      console.error("meta error", `${owner}/${repo}`, e.message);
    }
  }
})();
