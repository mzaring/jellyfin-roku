'use strict';

// ESPN fantasy football -> small, display-ready matchup JSON for the Roku overlay.
//
// ESPN's fantasy API is unofficial and undocumented, so every field read here is
// defensive: it tries the likely keys in order and falls back rather than throwing.
// If something looks wrong on your league, run with ENABLE_RAW=1 and open /raw to
// see exactly what ESPN returned.

const API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

// mTeam: team names/owners/logos. mMatchupScore, mMatchup, mScoreboard, mLiveScoring: schedule + scores.
// mBoxscore: each side's lineup with per-player points. Extra views are harmless; ESPN merges them.
const VIEWS = ['mTeam', 'mMatchupScore', 'mMatchup', 'mLiveScoring', 'mScoreboard', 'mBoxscore'];

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

function buildUrl({ leagueId, season }, { scoringPeriodId } = {}) {
  const url = new URL(`${API_BASE}/${season}/segments/0/leagues/${leagueId}`);
  for (const view of VIEWS) url.searchParams.append('view', view);
  if (scoringPeriodId) url.searchParams.set('scoringPeriodId', String(scoringPeriodId));
  return url;
}

// extra.scoringPeriodId / extra.matchupPeriodId: ask for one specific week, as ESPN's own site does.
async function fetchRaw(cfg, extra = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; jellyfin-roku-fantasy-proxy)',
  };
  // Public leagues need no cookies; private leagues need both.
  if (cfg.espnS2 && cfg.swid) headers.Cookie = `espn_s2=${cfg.espnS2}; SWID=${cfg.swid}`;
  if (extra.matchupPeriodId) {
    headers['x-fantasy-filter'] = JSON.stringify({
      schedule: { filterMatchupPeriodIds: { value: [extra.matchupPeriodId] } },
    });
  }

  let res;
  try {
    res = await fetch(buildUrl(cfg, extra), { headers, signal: AbortSignal.timeout(10_000) });
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

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function currentPeriod(raw) {
  return (raw && raw.status && raw.status.currentMatchupPeriod) || (raw && raw.scoringPeriodId) || null;
}

function rosterEntries(side) {
  return (side && side.rosterForCurrentScoringPeriod && side.rosterForCurrentScoringPeriod.entries) || [];
}

function hasLineups(raw, period) {
  const schedule = Array.isArray(raw && raw.schedule) ? raw.schedule : [];
  return schedule.some(
    (m) => m.matchupPeriodId === period && (rosterEntries(m.home).length > 0 || rosterEntries(m.away).length > 0),
  );
}

// Loads ESPN data for the current week. The normal response usually includes each side's lineup;
// if it doesn't, ask again with the week spelled out. Lineups are a nice-to-have, so if the second
// request fails or still has none, keep the scores we already have.
async function loadRaw(cfg, fetcher = fetchRaw) {
  const raw = await fetcher(cfg);
  const period = currentPeriod(raw);
  if (!period || hasLineups(raw, period)) return raw;

  try {
    const detailed = await fetcher(cfg, { scoringPeriodId: period, matchupPeriodId: period });
    if (hasLineups(detailed, period)) return { ...raw, schedule: detailed.schedule };
  } catch (err) {
    // fall through to the scores-only response
  }
  return raw;
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

// ESPN lineup slot ids -> the short labels shown in the overlay
const SLOT_LABELS = {
  0: 'QB', 1: 'TQB', 2: 'RB', 3: 'R/W', 4: 'WR', 5: 'W/T', 6: 'TE', 7: 'OP',
  8: 'DT', 9: 'DE', 10: 'LB', 11: 'DL', 12: 'CB', 13: 'S', 14: 'DB', 15: 'DP',
  16: 'D/ST', 17: 'K', 18: 'P', 19: 'HC', 23: 'FLEX',
};
const NON_STARTER_SLOTS = new Set([20, 21]); // bench, injured reserve
// Display order, matching ESPN's own box score: QB, RB, WR, TE, FLEX, D/ST, K
const SLOT_ORDER = [0, 2, 3, 4, 5, 6, 7, 23, 16, 17];

const slotRank = (slotId) => {
  const index = SLOT_ORDER.indexOf(slotId);
  return index === -1 ? SLOT_ORDER.length + (isNumber(slotId) ? slotId : 99) : index;
};

// One stat line for a player in one week. statSourceId 0 = actual, 1 = projected.
function playerStat(player, period, sourceId) {
  const stats = Array.isArray(player.stats) ? player.stats : [];
  const hit = stats.find((s) => s.scoringPeriodId === period && s.statSourceId === sourceId);
  return hit && isNumber(hit.appliedTotal) ? hit.appliedTotal : null;
}

// Compact names to save width: "Joe Burrow" -> "J. Burrow", "Kyle Pitts Sr." -> "K. Pitts Sr.",
// "Amon-Ra St. Brown" -> "A. St. Brown". Team defenses have no first name ("Bears D/ST" -> "Bears",
// since the slot column already says D/ST).
function playerName(player) {
  const full =
    (player.fullName || `${player.firstName || ''} ${player.lastName || ''}`).trim() || 'Unknown';
  if (/\s+D\/ST$/i.test(full)) return full.replace(/\s+D\/ST$/i, '');

  const [first, ...rest] = full.split(/\s+/);
  if (rest.length === 0) return full;
  return `${first[0].toUpperCase()}. ${rest.join(' ')}`;
}

// How a player's points should be colored on the TV:
//   zero     hasn't scored (game not started, or a true zero)  -> dimmed
//   negative below zero                                        -> red
//   beat     at or above the projection                        -> green
//   scored   on the board but short of the projection          -> white
function pointsState(actual, projected) {
  if (actual < 0) return 'negative';
  if (actual === 0) return 'zero';
  if (projected !== null && actual >= projected) return 'beat';
  return 'scored';
}

// ESPN style: one decimal when that says it all (19.0, 16.7), two otherwise (22.12)
function formatPlayerPoints(value) {
  const two = value.toFixed(2);
  return two.endsWith('0') ? value.toFixed(1) : two;
}

// Starting lineup for one side of the matchup, in display order
// ESPN's numeric NFL team ids -> the abbreviations ESPN's logo files are named by
const NFL_TEAMS = {
  1: 'atl', 2: 'buf', 3: 'chi', 4: 'cin', 5: 'cle', 6: 'dal', 7: 'den', 8: 'det', 9: 'gb',
  10: 'ten', 11: 'ind', 12: 'kc', 13: 'lv', 14: 'lar', 15: 'mia', 16: 'min', 17: 'ne', 18: 'no',
  19: 'nyg', 20: 'nyj', 21: 'phi', 22: 'ari', 23: 'pit', 24: 'lac', 25: 'sf', 26: 'sea', 27: 'tb',
  28: 'wsh', 29: 'car', 30: 'jax', 33: 'bal', 34: 'hou',
};
const NFL_ABBRS = new Set(Object.values(NFL_TEAMS));

function lineupOf(side, statPeriod) {
  const starters = [];
  for (const entry of rosterEntries(side)) {
    const slotId = entry.lineupSlotId;
    const pool = entry.playerPoolEntry;
    const player = pool && pool.player;
    if (!player || NON_STARTER_SLOTS.has(slotId)) continue;

    let actual = pool.appliedStatTotal;
    if (!isNumber(actual)) actual = playerStat(player, statPeriod, 0);

    starters.push({
      slotId,
      name: playerName(player),
      team: NFL_TEAMS[player.proTeamId] || '',
      proj: playerStat(player, statPeriod, 1),
      actual: isNumber(actual) ? actual : 0,
    });
  }
  return starters.sort((a, b) => slotRank(a.slotId) - slotRank(b.slotId));
}

function logoOf(team) {
  return team && typeof team.logo === 'string' && /^https?:\/\//i.test(team.logo) ? team.logo : '';
}

function formatSide(side, team, statPeriod) {
  const starters = lineupOf(side, statPeriod);

  // Projected total is the sum of the starters' projections, like ESPN's TOTALS row
  let projected = null;
  if (starters.length > 0) {
    projected = starters.reduce((sum, p) => sum + (p.proj === null ? 0 : p.proj), 0);
  } else {
    projected = projectedOf(side);
  }

  return {
    teamId: team ? team.id : null,
    name: teamName(team),
    score: (pointsOf(side) ?? 0).toFixed(2),
    proj: projected === null ? '' : projected.toFixed(1),
    logo: logoOf(team),
    players: starters.map((p) => ({
      slot: SLOT_LABELS[p.slotId] || '',
      name: p.name,
      team: p.team,
      proj: p.proj === null ? '--' : p.proj.toFixed(1),
      pts: formatPlayerPoints(p.actual),
      state: pointsState(p.actual, p.proj),
    })),
  };
}

// Normal CDF (Abramowitz-Stegun erf approximation)
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

// Estimated chance (whole percent, 1-99) that side A wins.  This is the proxy's own estimate, used
// only when ESPN supplies no win probability: each team's expected final is what it has scored plus its projection scaled by how
// much of the week is left (guessed from points scored vs. projected), and the spread shrinks as the
// week is played.  Returns [a, b] summing to 100.
const WIN_SPREAD = 50;
function winPercents(aScore, aProj, bScore, bProj) {
  const projSum = aProj + bProj;
  const played = projSum > 0 ? Math.min(1, Math.max(0, (aScore + bScore) / projSum)) : 0;
  const left = 1 - played;
  const diff = aScore + aProj * left - (bScore + bProj * left);
  const spread = WIN_SPREAD * Math.sqrt(Math.max(left, 0.02));
  const a = Math.min(99, Math.max(1, Math.round(normalCdf(diff / spread) * 100)));
  return [a, 100 - a];
}

// ESPN's own win probability, if the response carries one.  I have not seen a real response, so this
// accepts a "winProbability" number on either team's side of the matchup (0-1 or 0-100), or one on the
// matchup itself, which is taken to be the home team's.  Returns [me, opp] summing to 100, or null.
function findWinKey(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const key = Object.keys(obj).find((k) => /^win.?prob/i.test(k));
  const value = key === undefined ? null : Number(obj[key]);
  return Number.isFinite(value) ? value : null;
}

function toPercent(value) {
  const pct = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.min(99, Math.max(1, Math.round(pct)));
}

function espnWinPercents(entry, mySide, oppSide) {
  const mine = findWinKey(mySide);
  if (mine !== null) return [toPercent(mine), 100 - toPercent(mine)];

  const theirs = findWinKey(oppSide);
  if (theirs !== null) return [100 - toPercent(theirs), toPercent(theirs)];

  const home = findWinKey(entry);
  if (home !== null) {
    const homePct = toPercent(home);
    return mySide === entry.home ? [homePct, 100 - homePct] : [100 - homePct, homePct];
  }
  return null;
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

  const period = currentPeriod(raw);
  if (!period) throw new UserError('ESPN did not say which week it is');
  const label = `Week ${period}`;
  const statPeriod = raw.scoringPeriodId || period;

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

  const me = formatSide(mySide, byId.get(myId), statPeriod);
  const opp = formatSide(oppSide, byId.get(oppSide.teamId), statPeriod);

  const myPoints = pointsOf(mySide) ?? 0;
  const oppPoints = pointsOf(oppSide) ?? 0;
  const [myWin, oppWin] =
    espnWinPercents(entry, mySide, oppSide) ||
    winPercents(myPoints, parseFloat(me.proj) || 0, oppPoints, parseFloat(opp.proj) || 0);
  me.win = myWin;
  opp.win = oppWin;
  // Also sent as text: the Roku reads numbers from JSON unreliably, text always works
  me.winPct = String(myWin);
  opp.winPct = String(oppWin);

  const lead = myPoints > oppPoints ? 'me' : oppPoints > myPoints ? 'opp' : 'tie';

  const meIsHome = mySide === entry.home;

  return { ok: true, label, lead, meIsHome, me, opp, fetchedAt: new Date().toISOString() };
}

// ---- Sample data -----------------------------------------------------------------------------
// ESPN-shaped fake league so the overlay can be tried without credentials. Points grow over a
// four-hour loop so you can watch the overlay update.

const SAMPLE_LINEUPS = {
  1: [
    [0, 'Casey Archer', 18.2], [2, 'Dana Brooks', 15.4], [2, 'Eli Carter', 13.9],
    [4, 'Finn Dawson', 16.8], [4, 'Gus Ellison', 12.3], [6, 'Hal Foster', 9.6],
    [23, 'Ira Gibbs', 11.1], [16, 'Harbor City D/ST', 7.5], [17, 'Jay Hollis', 8.9, 0], // 0: hasn't played yet
    [20, 'Bench Player', 5.0],
  ],
  2: [
    [0, 'Kit Landry', 20.1], [2, 'Lou Mercer', 14.2], [2, 'Max Norwood', 12.8],
    [4, 'Ned Overton', 17.4], [4, 'Oz Prescott', 13.5], [6, 'Pat Quill', 8.7],
    [23, 'Quinn Rowe', 10.3], [16, 'Lakeside D/ST', 6.8, -2], [17, 'Reed Sutton', 9.2], // -2: a bad defense day
    [20, 'Reserve Player', 4.0],
  ],
};

// Some players run ahead of their projection and some behind, so every color shows up
const SAMPLE_WOBBLE = [1.3, 0.8, 1.1, 1.5, 0.7, 0.95, 1.2, 1, 0.9];

const SAMPLE_TEAM_IDS = [26, 3, 12, 9, 25, 7, 21, 16, 2, 34];

function sampleSide(teamId, progress, factor, period) {
  const entries = SAMPLE_LINEUPS[teamId].map(([lineupSlotId, fullName, proj, fixedPoints], index) => {
    const benched = NON_STARTER_SLOTS.has(lineupSlotId);
    const wobble = SAMPLE_WOBBLE[index % SAMPLE_WOBBLE.length];
    const actual = benched
      ? 0
      : fixedPoints !== undefined
        ? fixedPoints
        : Math.round(proj * (factor + 0.9 * progress) * wobble * 100) / 100;
    return {
      lineupSlotId,
      playerPoolEntry: {
        appliedStatTotal: actual,
        player: { fullName, proTeamId: SAMPLE_TEAM_IDS[(teamId * 7 + index * 5) % SAMPLE_TEAM_IDS.length], stats: [{ scoringPeriodId: period, statSourceId: 1, appliedTotal: proj }] },
      },
    };
  });
  const total = entries
    .filter((e) => !NON_STARTER_SLOTS.has(e.lineupSlotId))
    .reduce((sum, e) => sum + e.playerPoolEntry.appliedStatTotal, 0);
  return { teamId, totalPoints: Math.round(total * 100) / 100, rosterForCurrentScoringPeriod: { entries } };
}

function sampleRaw(now = Date.now()) {
  const progress = (Math.floor(now / 60_000) % 240) / 240;
  return {
    scoringPeriodId: 8,
    status: { currentMatchupPeriod: 8 },
    teams: [
      // sample.invalid is never fetched: sample mode serves a generated logo instead
      { id: 1, name: 'Sample Squad', abbrev: 'SMPL', owners: ['{SAMPLE-SWID}'], logo: 'https://sample.invalid/logo-1.png' },
      { id: 2, name: 'Gridiron Ghosts of the Midwest', abbrev: 'GHST', owners: ['{OTHER-SWID}'], logo: 'https://sample.invalid/logo-2.png' },
    ],
    schedule: [
      {
        matchupPeriodId: 8,
        home: sampleSide(1, progress, 0.4, 8),
        away: sampleSide(2, progress, 0.35, 8),
      },
    ],
  };
}

module.exports = {
  UserError,
  defaultSeason,
  fetchRaw,
  loadRaw,
  buildUrl,
  buildMatchup,
  sampleRaw,
  findMyTeamId,
  winPercents,
  espnWinPercents,
  NFL_ABBRS,
};
