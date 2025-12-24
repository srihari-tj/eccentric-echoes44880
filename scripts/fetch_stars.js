// scripts/fetch_stars.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const RAW_DIR = "data/raw/stars";
const DERIVED_DIR = "data/derived";
const STATE_DIR = "data/state";
const STATE_FILE = path.join(STATE_DIR, "fetch_stars_state.json");

// Ensure directories exist
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

// Timeboxing inside the script, separate from job's timeout-minutes
const START_TIME = Date.now();
const MAX_RUN_MS = Number(process.env.MAX_RUN_MS || 5 * 60 * 60 * 1000); // default 5h

function listQuarterDirs() {
  if (!fs.existsSync(DERIVED_DIR)) return [];
  return fs
    .readdirSync(DERIVED_DIR)
    .filter((d) => /^\d{4}-Q[1-4]$/.test(d));
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

async function respectfulSleep(res, base = 250) {
  const remaining = Number(res.headers.get("x-ratelimit-remaining") || "0");
  const reset = Number(res.headers.get("x-ratelimit-reset") || "0");

  if (res.status === 403 && reset) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 5000;
    console.log("rate-limited; sleeping", waitMs, "ms");
    await new Promise((r) => setTimeout(r, waitMs));
  } else {
    const extra = remaining > 0 && remaining < 50 ? 2000 : 0;
    await new Promise((r) => setTimeout(r, base + extra));
  }
}

async function fetchStargazerTimestamps(owner, repo, knownNewest) {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!GH_TOKEN) throw new Error("Missing GH_TOKEN or GITHUB_TOKEN");

  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github.v3.star+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const acc = [];
  let page = 1;
  const per_page = 100;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=${per_page}&page=${page}`;
    const res = await fetch(url, { headers });

    if (res.status === 404) {
      await respectfulSleep(res);
      break;
    }
    if (res.status === 403) {
      await respectfulSleep(res);
      continue;
    }

    const items = await res.json();
    await respectfulSleep(res);

    if (!Array.isArray(items) || items.length === 0) break;

    let overlap = false;
    for (const it of items) {
      const ts = it.starred_at;
      if (!ts) continue;
      if (knownNewest && ts <= knownNewest) {
        overlap = true;
        break;
      }
      acc.push(ts);
    }

    if (overlap || items.length < per_page) break;
    page++;
  }

  return acc.sort();
}

(async () => {
  const candidates = loadCandidates();
  const state = loadState();
  let idx = state.index || 0;

  console.log(
    `Resuming fetch_stars from index ${idx}/${candidates.length}`
  );

  for (; idx < candidates.length; idx++) {
    const { owner, repo } = candidates[idx];
    const fname = `${owner}__${repo}.json`;
    const fpath = path.join(RAW_DIR, fname);

    let existing = [];
    if (fs.existsSync(fpath)) {
      existing = JSON.parse(fs.readFileSync(fpath, "utf8"));
    }
    const knownNewest = existing.length ? existing[existing.length - 1] : null;

    try {
      const newest = await fetchStargazerTimestamps(
        owner,
        repo,
        knownNewest
      );
      if (newest.length > 0) {
        const merged = [...existing, ...newest].sort();
        fs.writeFileSync(fpath, JSON.stringify(merged, null, 2));
        console.log("updated", owner + "/" + repo, `+${newest.length}`);
      } else {
        console.log("no new stars", owner + "/" + repo);
      }
    } catch (e) {
      console.error("error", owner + "/" + repo, e.message);
    }

    // periodically save progress
    if (idx % 10 === 0) {
      saveState({ index: idx + 1 });
    }

    // hard timebox to avoid hitting the 6h job limit
    if (Date.now() - START_TIME > MAX_RUN_MS) {
      console.log("Max run time reached, saving state and exiting");
      saveState({ index: idx + 1 });
      process.exit(0);
    }
  }

  // finished all candidates, mark state as complete
  saveState({ index: candidates.length });
  console.log("fetch_stars done for all candidates");
})();
