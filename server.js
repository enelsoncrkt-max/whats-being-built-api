#!/usr/bin/env node
/**
 * What's Being Built — public "research brain" service.
 *
 * A tiny dependency-free Node service (plain http). The app front-end asks it:
 *   - What projects do we already know about?   GET  /api/projects
 *   - What is being built at this place?        POST /api/identify
 *   - Go research this area live                POST /api/research
 *   - Liveness                                  GET  /health
 *
 * Live research is provider-pluggable via env vars (SEARCH_API_KEY,
 * LLM_API_KEY — or GEMINI_API_KEY when LLM_PROVIDER=gemini — plus
 * SEARCH_PROVIDER, LLM_PROVIDER). Without keys the service still
 * answers from its cache and reports research as unavailable —
 * it never crashes for missing keys.
 *
 * International-ready by design: endpoints accept optional `lang`
 * (default "en") and `country` (default "US"); both are stored on saved
 * projects and passed through to the geocoding / search / LLM layers.
 * The US Census geocoder is used only for US lookups; Nominatim
 * (OpenStreetMap, global) is the fallback everywhere.
 *
 * Persistence: the host's local disk is ephemeral, so when GITHUB_TOKEN
 * is set the service treats the GitHub repo's projects.json as the
 * durable store — it merges that file in at boot and pushes the full
 * project list back (debounced) whenever research saves new projects.
 * Repo, branch and path default to the public whats-being-built-api
 * repo and can be overridden with GITHUB_REPO / GITHUB_BRANCH /
 * GITHUB_DATA_PATH. Without a token the service runs local-only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_FILE = (() => {
  const nested = path.join(__dirname, 'data', 'projects.json');
  try { require('fs').accessSync(nested); return nested; } catch (e) { return path.join(__dirname, 'projects.json'); }
})();
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const LLM_MODEL = process.env.LLM_MODEL || '';
// The extraction LLM's key: the gemini provider uses GEMINI_API_KEY,
// falling back to LLM_API_KEY; every other provider uses LLM_API_KEY.
function llmKey() {
  return LLM_PROVIDER === 'gemini' ? (GEMINI_API_KEY || LLM_API_KEY) : LLM_API_KEY;
}
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'enelsoncrkt-max/whats-being-built-api';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || 'projects.json';
const UA = 'WhatsBeingBuilt/1.0 (+https://whatsbeingbuiltapp.com)';
const NEARBY_MILES = 25;

// ---------------- tiny JSON file store ----------------
let db;
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch { db = { projects: [] }; }
if (!Array.isArray(db.projects)) db.projects = [];
function save() {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1));
}

// ---------------- durable store: GitHub repo file ----------------
// The host's disk is wiped on every recycle, so the repo copy of
// projects.json is the source of truth. hydrateFromGithub() merges it
// in at boot; pushToGithub() writes the full list back after research
// saves something new. Both are best-effort: any failure is logged and
// the service keeps running from its local copy.
function githubHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}
function githubContentsUrl() {
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
}
async function hydrateFromGithub() {
  try {
    const j = await fetchJson(`${githubContentsUrl()}?ref=${GITHUB_BRANCH}`, { headers: githubHeaders() });
    const remote = JSON.parse(Buffer.from(String(j.content || '').replace(/\s/g, ''), 'base64').toString('utf8'));
    const rp = Array.isArray(remote.projects) ? remote.projects : [];
    if (!rp.length) return;
    const byKey = new Map(db.projects.map(p => [projectKey(p), p]));
    let added = 0;
    for (const p of rp) {
      const k = projectKey(p);
      if (!byKey.has(k)) { db.projects.push(p); byKey.set(k, p); added++; }
    }
    if (added) {
      save();
      console.log(`[persist] hydrated ${added} project(s) from GitHub (total ${db.projects.length})`);
    } else {
      console.log(`[persist] GitHub copy checked: ${rp.length} project(s), nothing new (local ${db.projects.length})`);
    }
  } catch (e) {
    console.warn('[persist] hydrate from GitHub failed:', String(e.message || e).slice(0, 160));
  }
}
let ghPushTimer = null, ghPushRunning = false, ghPushQueued = false;
function scheduleGithubPush() {
  if (!GITHUB_TOKEN) return;
  if (ghPushRunning) { ghPushQueued = true; return; }
  if (ghPushTimer) return;
  ghPushTimer = setTimeout(() => { ghPushTimer = null; pushToGithub().catch(() => {}); }, 3000);
}
async function pushToGithub() {
  if (!GITHUB_TOKEN || ghPushRunning) return;
  ghPushRunning = true;
  try {
    const content = Buffer.from(JSON.stringify(db, null, 1), 'utf8').toString('base64');
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await fetchJson(`${githubContentsUrl()}?ref=${GITHUB_BRANCH}`, { headers: githubHeaders() }).catch(() => null);
      const body = { message: `Update projects.json (${db.projects.length} projects)`, content, branch: GITHUB_BRANCH };
      if (cur && cur.sha) body.sha = cur.sha;
      try {
        await fetchJson(githubContentsUrl(), {
          method: 'PUT',
          headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        console.log(`[persist] pushed ${db.projects.length} projects to GitHub`);
        return;
      } catch (e) {
        if (attempt === 1) throw e; // one retry with a fresh sha, then give up
      }
    }
  } catch (e) {
    console.warn('[persist] GitHub push failed:', String(e.message || e).slice(0, 160));
  } finally {
    ghPushRunning = false;
    if (ghPushQueued) { ghPushQueued = false; scheduleGithubPush(); }
  }
}

// ---------------- helpers ----------------
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const projectKey = p => norm(p.name) + '|' + norm(p.city);
function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = d => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function researchState() {
  return SEARCH_API_KEY && llmKey()
    ? { status: 'available', searchProvider: SEARCH_PROVIDER, llmProvider: LLM_PROVIDER }
    : { status: 'unavailable', reason: 'no_api_keys' };
}
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) {
    let detail = '';
    try {
      const t = await r.text();
      try { const j = JSON.parse(t); detail = (j.error && j.error.message) || ''; } catch (e) { detail = t; }
    } catch (e) {}
    detail = String(detail).replace(/\s+/g, ' ').slice(0, 220);
    throw new Error(`HTTP ${r.status} from ${new URL(url).host}${detail ? ': ' + detail : ''}`);
  }
  return r.json();
}
function projectsNear(lat, lng, miles = NEARBY_MILES) {
  return db.projects
    .filter(p => p.lat != null && p.lng != null)
    .map(p => ({ ...p, distanceMiles: Math.round(milesBetween(lat, lng, p.lat, p.lng) * 10) / 10 }))
    .filter(p => p.distanceMiles <= miles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}
function projectsForArea(city, state) {
  return db.projects.filter(p =>
    (!city || norm(p.city) === norm(city)) && (!state || norm(p.state) === norm(state)));
}

// ---------------- geocoding (Census for US, Nominatim global fallback) ----------------
async function geocodeCensus(query) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
    '?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(query);
  const j = await fetchJson(url);
  const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!m) return null;
  return { lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress, source: 'census', precision: 'address' };
}
async function geocodeNominatim(query, country) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(query) + (country ? '&countrycodes=' + country.toLowerCase() : '');
  const j = await fetchJson(url);
  const m = Array.isArray(j) && j[0];
  if (!m) return null;
  return { lat: +m.lat, lng: +m.lon, label: m.display_name, source: 'nominatim', precision: 'place' };
}
async function geocode(query, country = 'US') {
  if ((country || 'US').toUpperCase() === 'US') {
    const c = await geocodeCensus(query).catch(() => null);
    if (c) return c;
  }
  return geocodeNominatim(query, country).catch(() => null);
}
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
  const j = await fetchJson(url).catch(() => null);
  const a = (j && j.address) || {};
  return { city: a.city || a.town || a.village || '', state: a.state || '' };
}

// ---------------- live research pipeline (pluggable providers) ----------------
async function searchWeb(query, lang, country) {
  if (SEARCH_PROVIDER === 'tavily') {
    const j = await fetchJson('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: SEARCH_API_KEY, query, max_results: 8 }),
    });
    return (j.results || []).map(r => ({ title: r.title, url: r.url, text: r.content || '' }));
  }
  if (SEARCH_PROVIDER === 'serpapi') {
    const u = 'https://serpapi.com/search.json?engine=google&api_key=' + encodeURIComponent(SEARCH_API_KEY) +
      '&q=' + encodeURIComponent(query) + '&hl=' + lang + '&gl=' + country.toLowerCase();
    const j = await fetchJson(u);
    return (j.organic_results || []).map(r => ({ title: r.title, url: r.link, text: r.snippet || '' }));
  }
  if (SEARCH_PROVIDER === 'brave') {
    const u = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
      '&count=8&search_lang=' + lang + '&country=' + country;
    const j = await fetchJson(u, { headers: { 'X-Subscription-Token': SEARCH_API_KEY, Accept: 'application/json' } });
    return ((j.web && j.web.results) || []).map(r => ({ title: r.title, url: r.url, text: r.description || '' }));
  }
  throw new Error(`unknown SEARCH_PROVIDER "${SEARCH_PROVIDER}"`);
}

async function extractProjects(areaLabel, results, lang) {
  const prompt = [
    `You extract construction projects from web search results for this area: ${areaLabel}.`,
    `Write field values in this language (ISO code): ${lang}.`,
    'Return ONLY a JSON array. Each item: {"name","what","status","category","address","locationLabel","city","state","timeline","costSize","developer","sourceUrl","sourceLabel"}.',
    '"what" is 1-3 sentences on what is being built. "status" is like "Under construction", "Planned" or "Opening soon".',
    'Only include real, specific construction projects supported by a result; use that result\'s URL as sourceUrl. Use "" for unknown fields. No commentary.',
    'SEARCH RESULTS:',
    ...results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text}`),
  ].join('\n');
  let text;
  if (LLM_PROVIDER === 'gemini') {
    const model = LLM_MODEL || 'gemini-3.5-flash-lite';
    const j = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': llmKey() },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000, responseMimeType: 'application/json' },
      }),
    });
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    text = parts.map(p => p.text || '').join('');
  } else if (LLM_PROVIDER === 'anthropic') {
    const j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': llmKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: LLM_MODEL || 'claude-haiku-4-5', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    });
    text = (j.content || []).map(b => b.text || '').join('');
  } else { // openai-compatible
    const j = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmKey()}` },
      body: JSON.stringify({ model: LLM_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] }),
    });
    text = (j.choices && j.choices[0] && j.choices[0].message.content) || '';
  }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

async function runResearch({ city, state, lat, lng, lang, country }) {
  const areaLabel = [city, state].filter(Boolean).join(', ') || `${lat}, ${lng}`;
  const queries = [
    `${areaLabel} planning commission agenda new development`,
    `${areaLabel} building permits new construction project`,
    `${areaLabel} new development project announced`,
    `what is being built in ${areaLabel} construction`,
  ];
  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const hits = await searchWeb(q, lang, country).catch(() => []);
    for (const h of hits) if (h.url && !seen.has(h.url)) { seen.add(h.url); results.push(h); }
  }
  const candidates = await extractProjects(areaLabel, results.slice(0, 24), lang);
  const known = new Set(db.projects.map(projectKey));
  const fresh = [];
  for (const c of candidates) {
    if (!c.name) continue;
    const p = {
      name: c.name, category: c.category || '', status: c.status || '', what: c.what || '',
      locationLabel: c.locationLabel || '', address: c.address || '',
      city: c.city || city || '', state: c.state || state || '',
      lat: null, lng: null, costSize: c.costSize || '', developer: c.developer || '',
      timeline: c.timeline || '',
      source1Label: c.sourceLabel || c.sourceUrl || '', source1Url: c.sourceUrl || '',
      source2Label: '', source2Url: '', lang, country,
    };
    if (known.has(projectKey(p))) continue;
    const g = await geocode([p.address || p.locationLabel, p.city, p.state].filter(Boolean).join(', '), country);
    if (g) { p.lat = g.lat; p.lng = g.lng; p.geocodePrecision = g.precision; p.geocodeSource = g.source; }
    db.projects.push(p); known.add(projectKey(p)); fresh.push(p);
  }
  if (fresh.length) { save(); scheduleGithubPush(); }
  return fresh;
}

// ---------------- HTTP plumbing ----------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

async function handleIdentify(body) {
  const lang = body.lang || 'en';
  const country = (body.country || 'US').toUpperCase();
  const query = (body.query || '').trim();
  if (!query) return [400, { error: 'missing "query"' }];
  const location = await geocode(query, country);
  let projects = [];
  if (location) {
    projects = projectsNear(location.lat, location.lng);
  } else {
    // Geocoding failed: fall back to matching the text against the cache.
    const q = norm(query);
    projects = db.projects.filter(p =>
      q.includes(norm(p.city)) || q.includes(norm(p.name)) || norm(p.locationLabel).split(' ').some(w => w.length > 4 && q.includes(w)));
  }
  return [200, { query, lang, country, location, projects, research: researchState() }];
}

async function handleResearch(body) {
  const lang = body.lang || 'en';
  const country = (body.country || 'US').toUpperCase();
  let city = body.city || '', state = body.state || '';
  let lat = body.lat != null ? +body.lat : null, lng = body.lng != null ? +body.lng : null;
  if (lat != null && lng != null && !city) {
    const r = await reverseGeocode(lat, lng);
    city = r.city; state = r.state || state;
  }
  const cached = (lat != null && lng != null && !city)
    ? projectsNear(lat, lng) : projectsForArea(city, state);
  if (!SEARCH_API_KEY || !llmKey()) {
    return [200, { research: 'unavailable', reason: 'no_api_keys', area: { city, state, lat, lng }, lang, country, newProjects: [], projects: cached }];
  }
  try {
    const fresh = await runResearch({ city, state, lat, lng, lang, country });
    const all = city ? projectsForArea(city, state) : projectsNear(lat, lng);
    return [200, { research: 'complete', area: { city, state, lat, lng }, lang, country, newProjects: fresh, projects: all }];
  } catch (err) {
    return [200, { research: 'error', reason: String(err.message || err).slice(0, 200), area: { city, state, lat, lng }, lang, country, newProjects: [], projects: cached }];
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'whats-being-built', projects: db.projects.length, research: researchState(), persist: GITHUB_TOKEN ? 'github' : 'local-only' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, { service: "What's Being Built — research brain", endpoints: ['GET /health', 'GET /api/projects?city=&state=&q=&lang=&country=', 'POST /api/identify {query, lang?, country?}', 'POST /api/research {city, state} or {lat, lng} (+ lang?, country?)'] });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const city = url.searchParams.get('city'), state = url.searchParams.get('state');
      const q = norm(url.searchParams.get('q') || '');
      const lang = url.searchParams.get('lang'), country = url.searchParams.get('country');
      let out = db.projects.filter(p =>
        (!city || norm(p.city) === norm(city)) &&
        (!state || norm(p.state) === norm(state)) &&
        (!lang || (p.lang || 'en') === lang) &&
        (!country || (p.country || 'US') === country.toUpperCase()) &&
        (!q || norm([p.name, p.what, p.locationLabel, p.developer, p.city].join(' ')).includes(q)));
      return send(res, 200, { count: out.length, projects: out });
    }
    if (req.method === 'POST' && url.pathname === '/api/identify') {
      const [code, payload] = await handleIdentify(await readBody(req));
      return send(res, code, payload);
    }
    if (req.method === 'POST' && url.pathname === '/api/research') {
      const [code, payload] = await handleResearch(await readBody(req));
      return send(res, code, payload);
    }
    return send(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

hydrateFromGithub();
server.listen(PORT, () => console.log(`whats-being-built server listening on :${PORT} (${db.projects.length} projects cached, research ${researchState().status})`));
