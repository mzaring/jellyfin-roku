'use strict';

// Tiny HTTP service the Roku overlay polls. Needs Node 22.9+; the only dependency is optional
// (@resvg/resvg-js, used to turn SVG team logos into PNGs the Roku can draw).
//
//   GET /matchup           display-ready matchup JSON (cached)
//   GET /logo/<teamId>.png a team's logo, fetched from ESPN and served from here
//   GET /nfl/<abbr>.png    an NFL team's logo (small), fetched from ESPN and served from here
//   GET /health            liveness check
//   GET /raw               raw ESPN response, only when ENABLE_RAW=1 (for debugging)

const crypto = require('node:crypto');
const http = require('node:http');
const { UserError, defaultSeason, loadRaw, buildMatchup, sampleRaw, NFL_ABBRS } = require('./espn');
const { LogoError, loadLogo, samplePng } = require('./logo');

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
  sampleStepMs: (Number(env.SAMPLE_STEP_SECONDS) || 60) * 1000,
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

// teamId -> the logo address ESPN gave us, and the downloaded image once we have it
const logoSources = new Map();
const logoImages = new Map();
const logoWarned = new Set();

async function refresh() {
  const raw = cfg.sample ? sampleRaw(Date.now(), cfg.sampleStepMs) : await loadRaw(cfg);
  const body = buildMatchup(raw, cfg);
  for (const side of [body.me, body.opp]) {
    if (side && side.logo) logoSources.set(side.teamId, side.logo);
  }
  cache = { at: Date.now(), body };
  prefetchNflLogos(body);
  return body;
}

// The overlay is told to fetch logos from this proxy, using the same address it reached us at
function withLocalLogos(body, host) {
  if (!body || !body.me || !body.opp) return body;
  const localize = (side) => {
    const players = Array.isArray(side.players)
      ? side.players.map((p) => (p.team ? { ...p, logo: `http://${host}/nfl/${p.team}.png` } : p))
      : side.players;
    if (!side.logo) return { ...side, players };
    const version = crypto.createHash('sha1').update(side.logo).digest('hex').slice(0, 8);
    return { ...side, players, logo: `http://${host}/logo/${side.teamId}.png?v=${version}` };
  };
  return { ...body, me: localize(body.me), opp: localize(body.opp) };
}

async function getLogo(teamId) {
  const source = logoSources.get(teamId);
  if (!source) return null;

  if (!logoImages.has(source)) {
    if (cfg.sample) {
      logoImages.set(source, { type: 'image/png', bytes: samplePng(teamId === 1 ? [214, 106, 50] : [50, 120, 200]) });
    } else {
      const logo = await loadLogo(source);
      console.log(`Team ${teamId} logo ready (${logo.converted ? 'converted from SVG' : logo.type}): ${source}`);
      logoImages.set(source, logo);
    }
  }
  return logoImages.get(source);
}

// NFL team logos: ESPN serves a resized PNG, with the full-size file as a fallback
const nflLogos = new Map();
async function getNflLogo(abbr) {
  if (!nflLogos.has(abbr)) {
    if (cfg.sample) {
      const n = [...abbr].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      nflLogos.set(abbr, { type: 'image/png', bytes: samplePng([(n * 37) % 200 + 40, (n * 91) % 200 + 40, (n * 53) % 200 + 40], 64) });
    } else {
      const path = `/i/teamlogos/nfl/500/${abbr}.png`;
      let logo;
      try {
        logo = await loadLogo(`https://a.espncdn.com/combiner/i?img=${path}&w=64&h=64`);
      } catch (err) {
        logo = await loadLogo(`https://a.espncdn.com${path}`);
      }
      nflLogos.set(abbr, logo);
    }
  }
  return nflLogos.get(abbr);
}

// Download the NFL logos in the background as soon as we know which teams are playing, so the
// overlay's first requests are served from memory instead of waiting on ESPN
function prefetchNflLogos(body) {
  const abbrs = new Set();
  for (const side of [body.me, body.opp]) {
    for (const p of (side && side.players) || []) if (p.team && NFL_ABBRS.has(p.team)) abbrs.add(p.team);
  }
  for (const abbr of abbrs) {
    if (!nflLogos.has(abbr)) getNflLogo(abbr).catch(() => {});
  }
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
    if (path === '/matchup') {
      const host = req.headers.host || `localhost:${cfg.port}`;
      return send(res, 200, withLocalLogos(await getMatchup(), host));
    }

    const nflRoute = /^\/nfl\/([a-z]+)\.png$/.exec(path);
    if (nflRoute) {
      const abbr = nflRoute[1];
      if (!NFL_ABBRS.has(abbr)) return send(res, 404, { ok: false, error: 'No such team' });
      let logo;
      try {
        logo = await getNflLogo(abbr);
      } catch (err) {
        if (!logoWarned.has(abbr)) {
          logoWarned.add(abbr);
          console.warn(`[${new Date().toISOString()}] NFL logo ${abbr}: ${err.message}`);
        }
        throw err;
      }
      res.writeHead(200, { 'Content-Type': logo.type, 'Content-Length': logo.bytes.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(logo.bytes);
    }

    const logoRoute = /^\/logo\/(\d+)\.png$/.exec(path);
    if (logoRoute) {
      const teamId = Number(logoRoute[1]);
      // Logos are fetched on demand, so make sure we know which team is which first
      if (!logoSources.has(teamId)) await getMatchup();

      let logo;
      try {
        logo = await getLogo(teamId);
      } catch (err) {
        // A missing logo is cosmetic: say why once, not every 30 seconds
        const source = logoSources.get(teamId);
        if (err instanceof LogoError && !logoWarned.has(source)) {
          logoWarned.add(source);
          console.warn(`[${new Date().toISOString()}] Team ${teamId} logo: ${err.message} (${source})`);
        }
        throw err;
      }
      if (!logo) return send(res, 404, { ok: false, error: 'No logo for that team' });

      res.writeHead(200, {
        'Content-Type': logo.type,
        'Content-Length': logo.bytes.length,
        'Cache-Control': 'public, max-age=3600',
      });
      return res.end(logo.bytes);
    }

    if (path === '/raw' && cfg.enableRaw) {
      return send(res, 200, cfg.sample ? sampleRaw() : await loadRaw(cfg));
    }

    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    if (err instanceof UserError) {
      // Logo problems are already logged once, with the address that caused them
      if (!(err instanceof LogoError)) console.warn(`[${new Date().toISOString()}] ${err.message}`);
      return send(res, err.status, { ok: false, error: err.message });
    }
    console.error(err);
    return send(res, 500, { ok: false, error: 'Internal error' });
  }
});

server.listen(cfg.port, '0.0.0.0', () => {
  const mode = cfg.sample ? 'SAMPLE data' : `league ${cfg.leagueId}, season ${cfg.season}`;
  console.log(`fantasy-proxy listening on :${cfg.port} (${mode})`);
  console.log(`  try: http://localhost:${cfg.port}/matchup`);
});
