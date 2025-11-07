// scripts/enrich_startups.js
// Enrich repos with company metadata and flags: is_startup, is_funded, website.
// Heuristics + optional overrides at data/derived/company_overrides.json.
// Outputs per-repo files in data/derived/company/owner__repo.json.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const WEEKLY_DIR = "data/derived/weekly";
const OUT_DIR = "data/derived/company";
const OVERRIDES = "data/derived/company_overrides.json"; // optional
fs.mkdirSync(OUT_DIR, { recursive: true });

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDES, "utf8")); } catch { return {}; }
}

function yearFromISO(iso) {
  if (!iso) return null;
  const y = Number((iso+"").slice(0,4));
  return Number.isFinite(y) ? y : null;
}

function guessCompanyName(orgJson, repoJson) {
  // Prefer org name; fallback to repo owner string; fallback to repo name.
  const fromOrg = orgJson?.name && orgJson.name.trim();
  const ownerLogin = repoJson?.owner?.login;
  const repoName = repoJson?.name;
  return fromOrg || ownerLogin || repoName || null;
}

function normalizeURL(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  // GitHub org.blog often blank or non-URL; try to coerce
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { new URL(s); return s; } catch { return null; }
}

function looksLikeStartup(orgCreatedYear, companyName, homepage, repoCreatedYear) {
  // Heuristics: age < 10y, non-foundations, excludes obvious large corps.
  const now = new Date().getUTCFullYear();
  const age = orgCreatedYear ? (now - orgCreatedYear) : (repoCreatedYear ? now - repoCreatedYear : null);

  const name = (companyName || "").toLowerCase();
  const corpHints = ["microsoft","google","alphabet","meta","facebook","amazon","aws","ibm","oracle","apache","linux foundation","mozilla","red hat","canonical","jetbrains","openai","nvidia","intel","sap","adobe"];
  const isLarge = corpHints.some(x => name.includes(x));

  // If homepage includes obvious corp domains, treat as not startup.
  const home = (homepage || "").toLowerCase();
  const corpDomains = ["microsoft.com","google.com","meta.com","facebook.com","amazon.com","aws.amazon.com","ibm.com","oracle.com","apache.org","linuxfoundation.org","mozilla.org","redhat.com","canonical.com","jetbrains.com","openai.com","nvidia.com","intel.com","sap.com","adobe.com"];
  const largeDomain = corpDomains.some(d => home.includes(d));

  const young = age == null ? true : age < 10;
  return !isLarge && !largeDomain && young;
}

function extractFundingHints(text) {
  if (!text) return { funded: false, notes: [] };
  const t = text.toLowerCase();
  const notes = [];
  const patterns = [
    {k:"seed", re:/seed\s+round|pre-seed|seed[-\s]?fund/i},
    {k:"series_a", re:/series\s*a/i},
    {k:"series_b", re:/series\s*b/i},
    {k:"series_c", re:/series\s*c/i},
    {k:"raised_$", re:/raised\s+\$[0-9,.]+/i},
    {k:"investors", re:/investors?:|backed by|led by/i},
    {k:"vc", re:/venture\s+capital|vc\s+firm/i}
  ];
  for (const p of patterns) {
    if (p.re.test(text)) notes.push(p.k);
  }
  return { funded: notes.length>0, notes };
}

async function respectfulSleep(ms=250){ await new Promise(r=>setTimeout(r,ms)); }

async function fetchGitHubOrg(owner, GH_TOKEN) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? {"Authorization":`Bearer ${GH_TOKEN}`} : {})
  };
  const url = `https://api.github.com/orgs/${owner}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null; // user, not org
  if (!res.ok) return null;
  const j = await res.json();
  await respectfulSleep();
  return j;
}

async function fetchGitHubRepo(owner, repo, GH_TOKEN) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(GH_TOKEN ? {"Authorization":`Bearer ${GH_TOKEN}`} : {})
  };
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const j = await res.json();
  await respectfulSleep();
  return j;
}

async function fetchText(url, timeoutMs=8000) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    const text = await res.text();
    await respectfulSleep();
    return text;
  } catch { return null; }
}

async function enrichOne(owner, repo, overrides, GH_TOKEN) {
  const overrideKey = `${owner}/${repo}`;
  const ovr = overrides[overrideKey] || {};
  // Fetch GitHub repo/org
  const repoJson = await fetchGitHubRepo(owner, repo, GH_TOKEN);
  const orgJson = await fetchGitHubOrg(owner, GH_TOKEN);

  const repoCreatedYear = yearFromISO(repoJson?.created_at);
  const orgCreatedYear = yearFromISO(orgJson?.created_at);
  const homepageRepo = normalizeURL(repoJson?.homepage);
  const homepageOrg = normalizeURL(orgJson?.blog);
  const website = ovr.website || homepageRepo || homepageOrg || null;

  const companyName = ovr.company_name || guessCompanyName(orgJson, repoJson) || overrideKey;
  const foundedGuess = ovr.founded_year || orgCreatedYear || repoCreatedYear || null;

  // Fetch About/README/Website text for funding hints (best-effort)
  let pagesText = "";
  // GitHub repo homepage may be README; also try website/about
  const candidates = [];
  if (website) {
    candidates.push(website);
    if (website.endsWith("/")) {
      candidates.push(website + "about");
      candidates.push(website + "company");
      candidates.push(website + "press");
    } else {
      candidates.push(website + "/about");
      candidates.push(website + "/company");
      candidates.push(website + "/press");
    }
  }
  // Add org page
  candidates.push(`https://github.com/${owner}`);
  // Try to read a bit of text from 2-3 endpoints
  for (const u of candidates.slice(0, 3)) {
    const txt = await fetchText(u);
    if (txt) pagesText += "\n" + txt.slice(0, 100000); // cap
  }

  const funding = ovr.is_funded !== undefined
    ? { funded: !!ovr.is_funded, notes: ovr.funding_notes || [] }
    : extractFundingHints(pagesText);

  const startup = ovr.is_startup !== undefined
    ? !!ovr.is_startup
    : looksLikeStartup(orgCreatedYear, companyName, website, repoCreatedYear);

  return {
    repo: `${owner}/${repo}`,
    company_name: companyName,
    website,
    founded_year_guess: foundedGuess,
    is_startup: startup,
    is_funded: funding.funded,
    funding_notes: funding.notes,
    sources: {
      repo_api: !!repoJson,
      org_api: !!orgJson,
      pages_scanned: candidates.slice(0,3)
    },
    enriched_at: new Date().toISOString()
  };
}

function listReposFromWeekly() {
  const list = [];
  for (const f of fs.readdirSync(WEEKLY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR,f),"utf8"));
    if (p?.repo) {
      const [owner, repo] = p.repo.split("/");
      list.push({ owner, repo, file: f });
    }
  }
  return list;
}

(async () => {
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const overrides = loadOverrides();
  const repos = listReposFromWeekly();
  for (const { owner, repo } of repos) {
    const out = path.join(OUT_DIR, `${owner}__${repo}.json`);
    try {
      const enriched = await enrichOne(owner, repo, overrides, GH_TOKEN);
      fs.writeFileSync(out, JSON.stringify(enriched, null, 2));
      console.log("enriched", enriched.repo, enriched.is_startup ? "startup" : "org", enriched.is_funded ? "funded" : "unfunded");
    } catch (e) {
      console.error("enrich error", `${owner}/${repo}`, e.message);
    }
  }
})();
