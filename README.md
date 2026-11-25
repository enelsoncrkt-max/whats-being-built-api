# What's Being Built — Research Brain (server)

The public back-end for the **What's Being Built** app. A user anywhere in
America enters an address or place; this service answers *what is being
built there* — first from its cache of researched, source-linked projects,
and (when API keys are configured) by researching the area live.

Dependency-free Node.js (plain `http`, Node 18+). No build step.

## Run it

```bash
node server.js            # or: npm start
# listens on PORT (env) or 8080
node geocode-seed.js      # one-time: fill lat/lng for seed projects (already run)
```

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /health` | `{ ok, projects: <cache size>, research: {...} }` |
| `GET /api/projects?city=&state=&q=&lang=&country=` | Cached projects, filterable. `q` is a free-text search over name/description/location/developer/city. |
| `POST /api/identify` `{ "query": "construction near 5th & Main, Austin TX", "lang": "en", "country": "US" }` | Geocodes the free-text place (US Census Geocoder for US addresses, Nominatim as global fallback), then returns cached projects within ~25 miles, each with `distanceMiles`, plus the geocoded `location`. If geocoding fails it falls back to text-matching the cache. |
| `POST /api/research` `{ "city": "Austin", "state": "TX" }` or `{ "lat": 30.27, "lng": -97.74 }` (+ optional `lang`/`country`) | Live-research pipeline (below). Without API keys it responds `{ "research": "unavailable", "reason": "no_api_keys", ... }` and still returns any cached projects for the area — it never crashes for missing keys. |

All responses are JSON with open CORS headers so the front-end can call
the API directly.

## Live research pipeline

`POST /api/research` runs, in order:

1. **Queries** — builds web searches for the area: planning-commission
   agendas, building permits / new construction, development news.
2. **Search provider** — calls the configured search API, dedupes results
   by URL.
3. **Extraction** — sends the results to the configured LLM, which returns
   structured candidate projects (name, what, status, location, timeline,
   cost, developer, source link).
4. **Dedupe & save** — candidates are deduped against the cache by
   normalized name + city, geocoded best-effort, saved to the store with
   their `lang`/`country`, and returned as `newProjects`.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `SEARCH_API_KEY` | — | Key for the search provider. Research is `unavailable` without it. |
| `SEARCH_PROVIDER` | `tavily` | `tavily` \| `serpapi` \| `brave`. |
| `LLM_API_KEY` | — | Key for the extraction LLM. Research is `unavailable` without it. Not used by the `gemini` provider when `GEMINI_API_KEY` is set. |
| `GEMINI_API_KEY` | — | Google AI Studio key, used when `LLM_PROVIDER=gemini`; if unset, the gemini provider falls back to `LLM_API_KEY`. |
| `LLM_PROVIDER` | `openai` | `openai` (OpenAI-compatible chat completions) \| `anthropic` \| `gemini` (Google AI Studio `generateContent`). |
| `LLM_MODEL` | provider default | Optional model override. Gemini default: `gemini-3.5-flash-lite` (Flash-Lite class — the roomiest free-tier limits; `gemini-2.5-flash-lite` also works). |

**Launch runs on the free tier ($0):** `SEARCH_PROVIDER=tavily` on Tavily's
free plan plus `LLM_PROVIDER=gemini` with a free Google AI Studio key in
`GEMINI_API_KEY` — Gemini is the free-tier launch default for extraction.

## Data store

`data/projects.json` — a single JSON file (`{ projects: [...] }`), seeded
from the app's researched feed (34 Minnesota projects) and appended to by
the research pipeline. Project fields mirror the app's feed (`name`,
`what`, `status`, `category`, `address`, `locationLabel`, `city`, `state`,
`lat`, `lng`, `costSize`, `developer`, `timeline`, `source1Label/Url`,
`source2Label/Url`) plus `lang`, `country`, and geocode provenance
(`geocodePrecision`: `address` \| `place` \| `city`, `geocodeSource`).

Seed geocoding status: **25 of 34** projects have coordinates — 6 from the
original feed, 6 exact Census address matches, 5 Nominatim place matches,
8 city centroids (marked `"city"`). The other 9 have only vague location
labels and were deliberately left un-geocoded rather than guessed. Every
Nominatim hit is distance-checked against its city so a same-named place
in the wrong state can't slip in.

## Deployment notes

- Deploy `server.js` + `data/` to any Node host (a small VPS, Render,
  Railway, Fly.io, etc.): `node server.js` with `PORT` set by the host.
- Point the domain at it: e.g. an `api.whatsbeingbuiltapp.com` DNS record
  to the host (or a reverse proxy on the apex). The front-end at
  **whatsbeingbuiltapp.com** calls these endpoints cross-origin (CORS is
  already open).
- Give the host a **persistent disk** for `data/projects.json`, or the
  cache resets on redeploy. When outgrown, this file is the migration
  source for a real database.
- Set `SEARCH_API_KEY` and the LLM key (and provider vars) in the host's
  env to switch live research on — for the free-tier launch that's
  `LLM_PROVIDER=gemini` + `GEMINI_API_KEY`; the service is fully useful
  from cache without them.
- Geocoders are free and keyless: US Census Geocoder (US addresses) and
  Nominatim/OpenStreetMap (global fallback, ~1 req/sec politeness built
  into the seed script).

## Roadmap — worldwide, multilingual

The design is international-ready today; translations are not built yet:

- Every endpoint already accepts optional `lang` and `country`
  (defaults `en` / `US`) and passes them through the whole pipeline —
  search providers get them as locale parameters, the LLM is instructed
  to write field values in `lang`, and saved projects/areas store both
  fields, so new territories don't need a schema change.
- Geocoding is not US-only logic: the Census geocoder is used *only* for
  US lookups; **Nominatim is the global path** and becomes the primary
  geocoder for any other `country`.
- Still to add when expanding: per-country research sources (permit and
  planning portals differ by country), localized search-query templates,
  and UI string translation in the front-end. The API contract above
  stays the same.
