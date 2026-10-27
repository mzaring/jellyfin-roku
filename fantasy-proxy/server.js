'use strict';

// Tiny HTTP service the Roku overlay polls. Needs Node 20+; no dependencies.
//
//   GET /matchup   display-ready matchup JSON (cached)
//   GET /health    liveness check
//   GET /raw       raw ESPN response, only when ENABLE_RAW=1 (for debugging)

const http = require('node:http');
const { UserError, defaultSeason, fetchRaw, buildMatchup, sampleRaw } = require('./espn');

const env = process.env;
const cfg = {
  sample: env.SAMPLE === '1',
  leagueId: env.LEAGUE_ID,
  season: env.SEASON || defaultSeason(),
  espnS2: env.ESPN_S2,
  swid: env.SWID,
  teamId: env.TEAM_ID || (env.SAMPLE === '1' ? '1' : undefined),
  port: Number(env.PORT) || 8765,
  cacheMs: (Number(env.CACHE_SECONDS) || 30) * 1000,
  enableRaw: env.ENABLE_RAW === '1',
};

// If ESPN is briefly unreachable, keep serving the last good scores (marked stale) for this long.
const STALE_MAX_MS = 10 * 60 * 1000;

if (!cfg.sample && !cfg.leagueId) {
  console.error('LEAGUE_ID is required (or set SAMPLE=1 to try the overlay with fake data). See README.md.');
  process.exit(1);
}
if (!cfg.sample && Boolean(cfg.espnS2) !== Boolean(cfg.swid)) {
  console.error('Set both ESPN_S2 and SWID for a private league, or neither for a public one.');
  process.exit(1);
}

let cache = { at: 0, body: null };
let inflight = null;

async function refresh() {
  const raw = cfg.sample ? sampleRaw() : await fetchRaw(cfg);
  const body = buildMatchup(raw, cfg);
  cache = { at: Date.now(), body };
  return body;
}

async function getMatchup() {
  if (cache.body && Date.now() - cache.at < cfg.cacheMs) return cache.body;

  // Several TVs polling at once share one ESPN request
  if (!inflight) inflight = refresh().finally(() => (inflight = null));

  try {
    return await inflight;
  } catch (err) {
    if (cache.body && Date.now() - cache.at < STALE_MAX_MS) return { ...cache.body, stale: true };
    throw err;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' });
  if (path === '/health') return send(res, 200, { ok: true });

  try {
    if (path === '/matchup') return send(res, 200, await getMatchup());

    if (path === '/raw' && cfg.enableRaw) {
      return send(res, 200, cfg.sample ? sampleRaw() : await fetchRaw(cfg));
    }

    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    if (err instanceof UserError) {
      console.warn(`[${new Date().toISOString()}] ${err.message}`);
      return send(res, err.status, { ok: false, error: err.message });
    }
    console.error(err);
    return send(res, 500, { ok: false, error: 'Internal error' });
  }
});

server.listen(cfg.port, () => {
  const mode = cfg.sample ? 'SAMPLE data' : `league ${cfg.leagueId}, season ${cfg.season}`;
  console.log(`fantasy-proxy listening on :${cfg.port} (${mode})`);
  console.log(`  try: http://localhost:${cfg.port}/matchup`);
});
