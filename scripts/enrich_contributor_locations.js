// scripts/enrich_contributor_locations.js
// Contributor location enrichment with pause-on-rate-limit and disk cache.
// For each repo in data/derived/weekly, it:
// 1) Lists contributors via /repos/{owner}/{repo}/contributors (paginated)
// 2) Fetches each contributor's user profile via /users/{login}, reads "location"
// 3) Normalizes and aggregates into a map: { "<location>": count, ... }
// 4) Merges the map into data/derived/meta/owner__repo.json as "contributor_locations"
// Rate-limit handling:
// - On 403 with Retry-After or X-RateLimit-Reset, sleep then retry the same request
// - Exponential backoff on 5xx
// Caching:
// - Caches user locations by login in data/cache/user_locations.json with 7-day TTL


import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { execSync } from 'child_process';


const WEEKLY_DIR = "data/derived/weekly";
const META_DIR = "data/derived/meta";
const CACHE_DIR = "data/cache";
const STATE_DIR = "data/state";
const USER_CACHE_FILE = path.join(CACHE_DIR, "user_locations.json");
const STATE_FILE = path.join(STATE_DIR, "enrich_locations_state.json");


const PER_PAGE = 100;
const MAX_PAGES_PER_REPO = Number(process.env.LOCN_MAX_PAGES || 10);
const MAX_RUN_MS = Number(process.env.MAX_RUN_MS || 5 * 60 * 60 * 1000);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKPOINT_COMMIT_EVERY = 20;


const START_TIME = Date.now();


fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });


function loadUserCache() {
  try {
    if (fs.existsSync(USER_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(USER_CACHE_FILE, "utf8"));
    }
  } catch {}
  return {};
}


function saveUserCache(cache) {
  try {
    fs.writeFileSync(USER_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}


function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { index: 0 };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { index: 0 };
  }
}


function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}


function commitCheckpoint(idx) {
  console.log(`Committing checkpoint at index ${idx}`);
  try {
    execSync('git pull', { stdio: 'inherit' });
    execSync('git add data/derived/meta data/cache/user_locations.json data/state/enrich_locations_state.json', { stdio: 'inherit' });
    execSync('git config user.name "github-actions[bot]"', { stdio: 'inherit' });
    execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"', { stdio: 'inherit' });
    execSync(`git commit -m "locations checkpoint ${idx} ($(date -u +'%Y-%m-%dT%H:%M:%SZ'))" || echo "no changes"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log("✅ Checkpoint committed to Git");
  } catch (e) {
    console.error("Commit failed:", e.message);
  }
}


function listRepos() {
  if (!fs.existsSync(WEEKLY_DIR)) return [];
  return fs.readdirSync(WEEKLY_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, f), "utf8"));
      const full = p.repo || f.replace(".json","").replace("__","/");
      const [owner, repo] = full.split("/");
      return { owner, repo, file: f };
    });
}


function normalizeLocation(loc) {
  if (!loc) return "unknown";
  let s = String(loc).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "unknown";
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
  return aliases[s] || s;
}


function msUntil(resetEpochSec) {
  const now = Date.now();
  return Math.max(0, resetEpochSec * 1000 - now) + 2000;
}


async function sleep(ms) { 
  return new Promise(r => setTimeout(r, ms)); 
}


async function githubRequest(url, GH_TOKEN, attempt = 1) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {})
  };
  
  const res = await fetch(url, { headers });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") || "0");
  const reset = Number(res.headers.get("x-ratelimit-reset") || "0");
  const retryAfter = Number(res.headers.get("retry-after") || "0");


  if (res.status === 403 && retryAfter) {
    const waitMs = retryAfter * 1000 + 1000;
    console.log(`403 secondary limit; sleeping ${waitMs}ms -> ${url}`);
    await sleep(waitMs);
    return githubRequest(url, GH_TOKEN, attempt + 1);
  }


  if (res.status === 403 && reset) {
    const waitMs = msUntil(reset);
    console.log(`403 primary limit; remaining=${remaining}; sleeping ${waitMs}ms -> ${url}`);
    await sleep(waitMs);
    return githubRequest(url, GH_TOKEN, attempt + 1);
  }


  if (res.status >= 500 && attempt <= 6) {
    const backoff = Math.min(120000, 1000 * Math.pow(2, attempt));
    console.log(`5xx=${res.status}; backoff ${backoff}ms -> ${url}`);
    await sleep(backoff);
    return githubRequest(url, GH_TOKEN, attempt + 1);
  }


  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch {}
    return { ok: false, status: res.status, json, headers: { remaining, reset } };
  }


  let json = null;
  try { json = await res.json(); } catch {}
  await sleep(150);
  return { ok: true, status: res.status, json, headers: { remaining, reset } };
}


async function listContributors(owner, repo, GH_TOKEN) {
  const logins = [];
  for (let page = 1; page <= MAX_PAGES_PER_REPO; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=${PER_PAGE}&page=${page}`;
    const { ok, json, status } = await githubRequest(url, GH_TOKEN);
    
    if (status === 404) {
      console.log(`Repository ${owner}/${repo} not found (404)`);
      break;
    }
    
    if (!ok || !Array.isArray(json) || json.length === 0) break;
    
    for (const c of json) {
      if (c?.login) logins.push(c.login);
    }
    
    if (json.length < PER_PAGE) break;
  }
  return [...new Set(logins)];
}


async function fetchUserLocation(login, GH_TOKEN, cache) {
  const cached = cache[login];
  if (cached && cached.value && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_TTL_MS) return cached.value;
  }
  
  const url = `https://api.github.com/users/${login}`;
  const resp = await githubRequest(url, GH_TOKEN);
  let loc = "unknown";
  
  if (resp.ok && resp.json) {
    loc = normalizeLocation(resp.json.location || "");
  } else if (resp.status === 404) {
    loc = "unknown";
  }
  
  cache[login] = { value: loc, fetched_at: new Date().toISOString() };
  return loc;
}


function hasContributorLocations(owner, repo) {
  const metaPath = path.join(META_DIR, `${owner}__${repo}.json`);
  if (!fs.existsSync(metaPath)) return false;
  
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return meta.contributor_locations && Object.keys(meta.contributor_locations).length > 0;
  } catch {
    return false;
  }
}


function mergeIntoMeta(owner, repo, distribution) {
  const metaPath = path.join(META_DIR, `${owner}__${repo}.json`);
  let current = {};
  
  if (fs.existsSync(metaPath)) {
    try { 
      current = JSON.parse(fs.readFileSync(metaPath, "utf8")); 
    } catch {}
  } else {
    current = { owner, repo: `${owner}/${repo}` };
  }
  
  current.contributor_locations = distribution;
  current.contributor_locations_updated_at = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(current, null, 2));
}


(async () => {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!GH_TOKEN) {
    console.error("Missing GH_TOKEN or GITHUB_TOKEN environment variable");
    process.exit(1);
  }
  
  const cache = loadUserCache();
  const repos = listRepos();
  const state = loadState();
  let idx = state.index || 0;


  if (idx >= repos.length) {
    console.log("All repos processed, nothing to do");
    process.exit(0);
  }


  console.log(`Resuming enrich_contributor_locations from index ${idx}/${repos.length}`);


  for (; idx < repos.length; idx++) {
    const { owner, repo } = repos[idx];


    if (hasContributorLocations(owner, repo)) {
      console.log(`skip ${owner}/${repo} - contributor_locations already exists`);
      continue;
    }


    try {
      const logins = await listContributors(owner, repo, GH_TOKEN);
      
      if (logins.length === 0) {
        console.log(`no contributors ${owner}/${repo}`);
        mergeIntoMeta(owner, repo, {});
        continue;
      }
      
      const counts = Object.create(null);


      for (const login of logins) {
        if (Date.now() - START_TIME > MAX_RUN_MS) {
          console.log("Max run time reached during user fetch loop");
          break;
        }
        
        const loc = await fetchUserLocation(login, GH_TOKEN, cache);
        counts[loc] = (counts[loc] || 0) + 1;
      }


      mergeIntoMeta(owner, repo, counts);
      console.log(`locations ${owner}/${repo}: ${Object.keys(counts).length} regions from ${logins.length} users`);
      
    } catch (e) {
      console.error("location enrich error", `${owner}/${repo}`, e.message);
    }


    if (idx % 10 === 0) {
      saveState({ index: idx + 1 });
      saveUserCache(cache);
    }


    if (idx % CHECKPOINT_COMMIT_EVERY === 0 && idx > 0) {
      saveState({ index: idx + 1 });
      saveUserCache(cache);
      commitCheckpoint(idx + 1);
    }


    if (Date.now() - START_TIME > MAX_RUN_MS) {
      console.log("Max run time reached, saving final state and committing...");
      saveState({ index: idx + 1 });
      saveUserCache(cache);
      commitCheckpoint(idx + 1);
      console.log("Time limit checkpoint committed to Git, exiting cleanly");
      process.exit(0);
    }
  }


  saveState({ index: repos.length });
  saveUserCache(cache);
  commitCheckpoint(repos.length);
  console.log("enrich_contributor_locations COMPLETED");
})();
