'use strict';

// ESPN fantasy football -> small, display-ready matchup JSON for the Roku overlay.
//
// ESPN's fantasy API is unofficial and undocumented, so every field read here is
// defensive: it tries the likely keys in order and falls back rather than throwing.
// If something looks wrong on your league, run with ENABLE_RAW=1 and open /raw to
// see exactly what ESPN returned.

const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

// mTeam: team names/owners, mMatchupScore/mMatchup/mScoreboard: schedule + scores,
// mLiveScoring: in-progress scoring. Extra views are harmless; ESPN merges them.
const VIEWS = ['mTeam', 'mMatchupScore', 'mMatchup', 'mLiveScoring', 'mScoreboard'];

// An error whose message is safe and useful to show on the TV.
class UserError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

// The NFL season rolls over in the new year: Jan/Feb still belong to the previous season.
function defaultSeason(now = new Date()) {
  return now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
}

function buildUrl({ leagueId, season }) {
  const url = new URL(`${API_BASE}/${season}/segments/0/leagues/${leagueId}`);
  for (const view of VIEWS) url.searchParams.append('view', view);
  return url;
}

async function fetchRaw(cfg) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; jellyfin-roku-fantasy-proxy)',
  };
  // Public leagues need no cookies; private leagues need both.
  if (cfg.espnS2 && cfg.swid) headers.Cookie = `espn_s2=${cfg.espnS2}; SWID=${cfg.swid}`;

  let res;
  try {
    res = await fetch(buildUrl(cfg), { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new UserError('Could not reach ESPN');
  }

  if (res.status === 401 || res.status === 403) {
    throw new UserError(`ESPN login rejected (${res.status})`);
  }
  if (res.status === 404) throw new UserError('ESPN league not found');
  if (!res.ok) throw new UserError(`ESPN returned HTTP ${res.status}`);

  try {
    return await res.json();
  } catch (err) {
    // ESPN sometimes answers a bad cookie with an HTML sign-in page and a 200
    throw new UserError('ESPN sent unreadable data (check cookies)');
  }
}

const normalizeSwid = (value) => String(value || '').replace(/[{}]/g, '').toLowerCase();

function teamName(team) {
  if (!team) return 'Unknown';
  if (team.name) return String(team.name).trim();
  const combined = `${team.location || ''} ${team.nickname || ''}`.trim();
  return combined || team.abbrev || `Team ${team.id}`;
}

function ownerIds(team) {
  const ids = [];
  for (const owner of team.owners || []) {
    ids.push(normalizeSwid(typeof owner === 'string' ? owner : owner && owner.id));
  }
  if (team.primaryOwner) ids.push(normalizeSwid(team.primaryOwner));
  return ids;
}

// Your team: explicit TEAM_ID wins, otherwise the team whose owner matches your SWID cookie.
function findMyTeamId(teams, { teamId, swid }) {
  if (teamId) return Number(teamId);
  const wanted = normalizeSwid(swid);
  if (wanted) {
    const mine = teams.find((team) => ownerIds(team).includes(wanted));
    if (mine) return mine.id;
  }
  return null;
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Prefer the live total while games are in progress, then the regular total.
function pointsOf(side) {
  if (!side) return null;
  if (isNumber(side.totalPointsLive)) return side.totalPointsLive;
  if (isNumber(side.totalPoints)) return side.totalPoints;
  if (side.cumulativeScore && isNumber(side.cumulativeScore.score)) return side.cumulativeScore.score;
  return null;
}

function projectedOf(side) {
  if (!side) return null;
  if (isNumber(side.totalProjectedPointsLive)) return side.totalProjectedPointsLive;
  return null;
}

function formatSide(side, team) {
  const points = pointsOf(side);
  const projected = projectedOf(side);
  return {
    name: teamName(team),
    score: (points ?? 0).toFixed(2),
    proj: projected === null ? '' : `proj ${projected.toFixed(1)}`,
  };
}

// raw: ESPN league JSON. Returns the exact shape the Roku overlay renders.
function buildMatchup(raw, opts) {
  if (!raw || typeof raw !== 'object') throw new UserError('ESPN sent unreadable data');

  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  const byId = new Map(teams.map((team) => [team.id, team]));

  const myId = findMyTeamId(teams, opts);
  if (myId === null || !byId.has(myId)) {
    throw new UserError('Could not tell which team is yours (set TEAM_ID)', 500);
  }

  const period = (raw.status && raw.status.currentMatchupPeriod) || raw.scoringPeriodId;
  if (!period) throw new UserError('ESPN did not say which week it is');
  const label = `Week ${period}`;

  const schedule = Array.isArray(raw.schedule) ? raw.schedule : [];
  const entry = schedule.find(
    (m) =>
      m.matchupPeriodId === period &&
      ((m.home && m.home.teamId === myId) || (m.away && m.away.teamId === myId)),
  );

  const mySide = entry && (entry.home && entry.home.teamId === myId ? entry.home : entry.away);
  const oppSide = entry && (mySide === entry.home ? entry.away : entry.home);

  // Bye week, playoffs for an eliminated team, or no schedule yet
  if (!entry || !oppSide) {
    return { ok: true, label, bye: true, fetchedAt: new Date().toISOString() };
  }

  const me = formatSide(mySide, byId.get(myId));
  const opp = formatSide(oppSide, byId.get(oppSide.teamId));

  const myPoints = pointsOf(mySide) ?? 0;
  const oppPoints = pointsOf(oppSide) ?? 0;
  const lead = myPoints > oppPoints ? 'me' : oppPoints > myPoints ? 'opp' : 'tie';

  return { ok: true, label, lead, me, opp, fetchedAt: new Date().toISOString() };
}

// ESPN-shaped fake league so the overlay can be tried without credentials.
// Scores drift upward over time so you can watch the overlay update.
function sampleRaw(now = Date.now()) {
  const minutes = Math.floor(now / 60_000) % 240;
  return {
    scoringPeriodId: 8,
    status: { currentMatchupPeriod: 8 },
    teams: [
      { id: 1, name: 'Sample Squad', abbrev: 'SMPL', owners: ['{SAMPLE-SWID}'] },
      { id: 2, name: 'Gridiron Ghosts', abbrev: 'GHST', owners: ['{OTHER-SWID}'] },
    ],
    schedule: [
      {
        matchupPeriodId: 8,
        home: { teamId: 1, totalPoints: 61.4 + minutes * 0.35, totalProjectedPointsLive: 118.6 },
        away: { teamId: 2, totalPoints: 58.9 + minutes * 0.3, totalProjectedPointsLive: 109.2 },
      },
    ],
  };
}

module.exports = { UserError, defaultSeason, fetchRaw, buildUrl, buildMatchup, sampleRaw, findMyTeamId };
