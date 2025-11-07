// scripts/enrich_owner.js
// Enrich each repo with owner details from GitHub API (user or org):
// fields: login, type, name, company, bio, location, blog, created_at, followers, public_repos.
// Writes to data/derived/owner/owner__repo.json.
//
// Usage: node scripts/enrich_owner.js
// Requires that data/derived/weekly/* exists to enumerate repos.
// Token: set GH_TOKEN (preferred) or rely on GITHUB_TOKEN in Actions.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const WEEKLY_DIR = "data/derived/weekly";
const OUT_DIR = "data/derived/owner";
fs.mkdirSync(OUT_DIR, { recursive: true });

function listReposFromWeekly() {
  const list = [];
  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));
    if (!p?.repo) continue;
    const [owner, repo] = p.repo.split("/");
    list.push({ owner, repo, file: f });
  }
  return list;
}

function normalizeURL(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { new URL(s); return s; } catch { return null; }
}

async function respectfulSleep(ms=200){ await new Promise(r=>setTimeout(r,ms)); }

async function fetchOwner(owner, GH_TOKEN) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {})
  };
  // Try org first, then user
  const orgUrl = `https://api.github.com/orgs/${owner}`;
  let res = await fetch(orgUrl, { headers });
  if (res.status === 200) {
    const j = await res.json();
    await respectfulSleep();
    return {
      owner_login: j.login,
      owner_type: "Organization",
      name: j.name ?? null,
      company: null,
      bio: j.description ?? null,
      location: j.location ?? null,
      website: normalizeURL(j.blog ?? null),
      created_at: j.created_at ?? null,
      followers: null,          // orgs don’t have followers count in same way
      public_repos: j.public_repos ?? null,
      raw: { org_url: orgUrl }
    };
  }
  if (res.status !== 404) {
    await respectfulSleep();
  }
  const userUrl = `https://api.github.com/users/${owner}`;
  res = await fetch(userUrl, { headers });
  if (res.status === 200) {
    const j = await res.json();
    await respectfulSleep();
    return {
      owner_login: j.login,
      owner_type: "User",
      name: j.name ?? null,
      company: j.company ?? null,
      bio: j.bio ?? null,
      location: j.location ?? null,
      website: normalizeURL(j.blog ?? null),
      created_at: j.created_at ?? null,
      followers: j.followers ?? null,
      public_repos: j.public_repos ?? null,
      raw: { user_url: userUrl }
    };
  }
  await respectfulSleep();
  return null;
}

(async () => {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const repos = listReposFromWeekly();
  for (const { owner, repo } of repos) {
    const outPath = path.join(OUT_DIR, `${owner}__${repo}.json`);
    try {
      const info = await fetchOwner(owner, GH_TOKEN);
      const payload = {
        repo: `${owner}/${repo}`,
        owner: info?.owner_login ?? owner,
        owner_type: info?.owner_type ?? null,
        name: info?.name ?? null,
        company: info?.company ?? null,
        bio: info?.bio ?? null,
        location: info?.location ?? null,
        website: info?.website ?? null,
        created_at: info?.created_at ?? null,
        followers: info?.followers ?? null,
        public_repos: info?.public_repos ?? null,
        enriched_at: new Date().toISOString()
      };
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log("owner", payload.repo, "->", payload.owner_type || "unknown", payload.location || "");
    } catch (e) {
      console.error("owner enrich error", `${owner}/${repo}`, e.message);
    }
  }
})();
