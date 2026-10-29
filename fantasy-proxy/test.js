'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMatchup,
  sampleRaw,
  findMyTeamId,
  buildUrl,
  defaultSeason,
  loadRaw,
  UserError,
} = require('./espn');

const league = (overrides = {}) => ({
  scoringPeriodId: 8,
  status: { currentMatchupPeriod: 8 },
  teams: [
    { id: 1, name: 'Mine', owners: ['{AAAA-1111}'] },
    { id: 2, location: 'Their', nickname: 'Team', owners: ['{BBBB-2222}'] },
    { id: 3, abbrev: 'BYE', owners: ['{CCCC-3333}'] },
  ],
  schedule: [
    {
      matchupPeriodId: 8,
      home: { teamId: 1, totalPoints: 101.236 },
      away: { teamId: 2, totalPoints: 99.5 },
    },
  ],
  ...overrides,
});

// One roster entry in the shape ESPN uses
const entry = (lineupSlotId, fullName, { proj, actual, period = 8 } = {}) => ({
  lineupSlotId,
  playerPoolEntry: {
    ...(actual === undefined ? {} : { appliedStatTotal: actual }),
    player: {
      fullName,
      stats: proj === undefined ? [] : [{ scoringPeriodId: period, statSourceId: 1, appliedTotal: proj }],
    },
  },
});

const withRosters = (homeEntries, awayEntries = []) =>
  league({
    schedule: [
      {
        matchupPeriodId: 8,
        home: { teamId: 1, totalPoints: 10, rosterForCurrentScoringPeriod: { entries: homeEntries } },
        away: { teamId: 2, totalPoints: 5, rosterForCurrentScoringPeriod: { entries: awayEntries } },
      },
    ],
  });

test('formats a matchup for display and marks the leader', () => {
  const out = buildMatchup(league(), { swid: '{AAAA-1111}' });
  assert.equal(out.ok, true);
  assert.equal(out.label, 'Week 8');
  assert.equal(out.lead, 'me');
  assert.deepEqual(out.me, { teamId: 1, name: 'Mine', score: '101.24', proj: '', logo: '', players: [], win: 51 });
  assert.deepEqual(out.opp, { teamId: 2, name: 'Their Team', score: '99.50', proj: '', logo: '', players: [], win: 49 });
});

test('works when my team is the away side', () => {
  const out = buildMatchup(league(), { swid: '{BBBB-2222}' });
  assert.equal(out.me.name, 'Their Team');
  assert.equal(out.opp.name, 'Mine');
  assert.equal(out.lead, 'opp');
});

test('matches SWID regardless of braces and case', () => {
  const teams = league().teams;
  assert.equal(findMyTeamId(teams, { swid: 'aaaa-1111' }), 1);
  assert.equal(findMyTeamId(teams, { swid: '{AAAA-1111}' }), 1);
  assert.equal(findMyTeamId(teams, { swid: '{nope}' }), null);
});

test('explicit TEAM_ID wins over SWID', () => {
  assert.equal(findMyTeamId(league().teams, { teamId: '2', swid: '{AAAA-1111}' }), 2);
});

test('tie has no leader', () => {
  const raw = league({
    schedule: [{ matchupPeriodId: 8, home: { teamId: 1, totalPoints: 50 }, away: { teamId: 2, totalPoints: 50 } }],
  });
  assert.equal(buildMatchup(raw, { teamId: 1 }).lead, 'tie');
});

test('prefers live totals and uses the live projection when there is no lineup', () => {
  const raw = league({
    schedule: [
      {
        matchupPeriodId: 8,
        home: { teamId: 1, totalPoints: 10, totalPointsLive: 42.5, totalProjectedPointsLive: 120.04 },
        away: { teamId: 2, totalPoints: 10, totalPointsLive: 40 },
      },
    ],
  });
  const out = buildMatchup(raw, { teamId: 1 });
  assert.equal(out.me.score, '42.50');
  assert.equal(out.me.proj, '120.0');
  assert.equal(out.opp.proj, '');
});

test('missing points render as zero rather than crashing', () => {
  const raw = league({
    schedule: [{ matchupPeriodId: 8, home: { teamId: 1 }, away: { teamId: 2 } }],
  });
  const out = buildMatchup(raw, { teamId: 1 });
  assert.equal(out.me.score, '0.00');
  assert.equal(out.lead, 'tie');
});

test('bye week when there is no matchup for the current period', () => {
  const out = buildMatchup(league(), { teamId: 3 });
  assert.equal(out.bye, true);
  assert.equal(out.label, 'Week 8');
});

test('bye week when the opponent side is missing', () => {
  const raw = league({ schedule: [{ matchupPeriodId: 8, home: { teamId: 1, totalPoints: 0 } }] });
  assert.equal(buildMatchup(raw, { teamId: 1 }).bye, true);
});

test('only matchups from the current period are used', () => {
  const raw = league({
    schedule: [
      { matchupPeriodId: 7, home: { teamId: 1, totalPoints: 999 }, away: { teamId: 2, totalPoints: 1 } },
      { matchupPeriodId: 8, home: { teamId: 1, totalPoints: 5 }, away: { teamId: 2, totalPoints: 6 } },
    ],
  });
  const out = buildMatchup(raw, { teamId: 1 });
  assert.equal(out.me.score, '5.00');
});

test('falls back to scoringPeriodId when status is missing', () => {
  const raw = league({ status: undefined, scoringPeriodId: 8 });
  assert.equal(buildMatchup(raw, { teamId: 1 }).label, 'Week 8');
});

test('unknown team gives a clear, TV-sized error', () => {
  assert.throws(() => buildMatchup(league(), { swid: '{nobody}' }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /TEAM_ID/);
    assert.ok(err.message.length < 60, 'must fit on one line of the overlay');
    return true;
  });
});

test('garbage input is rejected cleanly', () => {
  assert.throws(() => buildMatchup(null, {}), UserError);
  assert.throws(() => buildMatchup('<html>', {}), UserError);
});

// ---- Lineups ---------------------------------------------------------------------------------

test('lists starters only, in ESPN box score order, with slot labels', () => {
  const raw = withRosters([
    entry(17, 'Kicker Kyle', { proj: 8.8, actual: 14 }),
    entry(20, 'Bench Ben', { proj: 5, actual: 0 }),
    entry(23, 'Flex Fran', { proj: 3.1, actual: 5.8 }),
    entry(4, 'Wide Walt', { proj: 10.2, actual: 10.9 }),
    entry(0, 'Quarter Quinn', { proj: 17.6, actual: 22.12 }),
    entry(16, 'Bears D/ST', { proj: 4.8, actual: 3 }),
    entry(2, 'Run Rita', { proj: 16.3, actual: 19 }),
    entry(21, 'Injured Ivy', { proj: 9, actual: 0 }),
    entry(6, 'Tight Tom', { proj: 11.5, actual: 19.9 }),
  ]);
  const { players } = buildMatchup(raw, { teamId: 1 }).me;
  assert.deepEqual(
    players.map((p) => p.slot),
    ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'],
  );
  assert.ok(!players.some((p) => /Ben|Ivy/.test(p.name)), 'bench and IR are left out');
});

test('formats per-player points the way ESPN does', () => {
  const raw = withRosters([
    entry(0, 'A', { proj: 17.6, actual: 22.12 }),
    entry(2, 'B', { proj: 16.25, actual: 19 }),
    entry(4, 'C', { proj: 10, actual: 16.7 }),
    entry(6, 'D', { proj: 0.04, actual: 0 }),
  ]);
  const { players } = buildMatchup(raw, { teamId: 1 }).me;
  assert.deepEqual(
    players.map((p) => [p.proj, p.pts]),
    [['17.6', '22.12'], ['16.3', '19.0'], ['10.0', '16.7'], ['0.0', '0.0']],
  );
});

test('strips the D/ST suffix because the slot column already says it', () => {
  const raw = withRosters([entry(16, 'Bears D/ST', { proj: 4.8, actual: 3 })]);
  const [dst] = buildMatchup(raw, { teamId: 1 }).me.players;
  assert.equal(dst.name, 'Bears');
  assert.equal(dst.slot, 'D/ST');
});

test('shortens player names to first initial and last name', () => {
  const names = [
    'Joe Burrow',
    'Kyle Pitts Sr.',
    'Amon-Ra St. Brown',
    'Jaxon Smith-Njigba',
    'C.J. Stroud',
    "D'Andre Swift",
    'Marvin Harrison Jr.',
    'Cher',
  ];
  const raw = withRosters(names.map((name, i) => entry(i === 0 ? 0 : 4, name, { proj: 1, actual: 1 })));
  assert.deepEqual(
    buildMatchup(raw, { teamId: 1 }).me.players.map((p) => p.name),
    ['J. Burrow', 'K. Pitts Sr.', 'A. St. Brown', 'J. Smith-Njigba', 'C. Stroud', 'D. Swift', 'M. Harrison Jr.', 'Cher'],
  );
});

test('each player gets a color state: zero, scored, beat the projection, or negative', () => {
  const raw = withRosters([
    entry(0, 'Not Yet', { proj: 17.6, actual: 0 }),
    entry(2, 'Some Points', { proj: 16.3, actual: 8.1 }),
    entry(4, 'Hit It', { proj: 10, actual: 10 }),
    entry(6, 'Beat It', { proj: 9.5, actual: 19.9 }),
    entry(16, 'Bad Day D/ST', { proj: 5, actual: -2 }),
    entry(17, 'No Projection', { actual: 4 }),
  ]);
  // Display order is QB, RB, WR, TE, D/ST, K
  const players = buildMatchup(raw, { teamId: 1 }).me.players;
  assert.deepEqual(
    players.map((p) => [p.name, p.state]),
    [
      ['N. Yet', 'zero'],
      ['S. Points', 'scored'],
      ['H. It', 'beat'], // exactly the projection counts as hitting it
      ['B. It', 'beat'],
      ['Bad Day', 'negative'],
      ['N. Projection', 'scored'], // nothing to compare against, so just "on the board"
    ],
  );
});

test('team ids are passed along so logos can be addressed', () => {
  const out = buildMatchup(league(), { teamId: 1 });
  assert.deepEqual([out.me.teamId, out.opp.teamId], [1, 2]);
});

test('projected total is the sum of the starters, ignoring the bench', () => {
  const raw = withRosters([
    entry(0, 'A', { proj: 17.6, actual: 1 }),
    entry(2, 'B', { proj: 16.3, actual: 1 }),
    entry(20, 'Bench', { proj: 50, actual: 0 }),
  ]);
  assert.equal(buildMatchup(raw, { teamId: 1 }).me.proj, '33.9');
});

test('actual points come from the stat line when appliedStatTotal is absent', () => {
  const raw = withRosters([
    {
      lineupSlotId: 0,
      playerPoolEntry: {
        player: {
          fullName: 'Fallback Fred',
          stats: [
            { scoringPeriodId: 8, statSourceId: 0, appliedTotal: 12.5 },
            { scoringPeriodId: 8, statSourceId: 1, appliedTotal: 15 },
            { scoringPeriodId: 7, statSourceId: 0, appliedTotal: 99 },
          ],
        },
      },
    },
  ]);
  const [p] = buildMatchup(raw, { teamId: 1 }).me.players;
  assert.deepEqual([p.proj, p.pts], ['15.0', '12.5']);
});

test('a player with no projection shows a dash and a missing score shows zero', () => {
  const raw = withRosters([entry(0, 'No Proj')]);
  const [p] = buildMatchup(raw, { teamId: 1 }).me.players;
  assert.deepEqual([p.proj, p.pts], ['--', '0.0']);
});

test('empty slots and malformed entries are skipped', () => {
  const raw = withRosters([{ lineupSlotId: 0 }, null, { lineupSlotId: 2, playerPoolEntry: {} }, entry(4, 'Real', { proj: 1, actual: 2 })].filter(Boolean));
  assert.deepEqual(buildMatchup(raw, { teamId: 1 }).me.players.map((p) => p.name), ['Real']);
});

test('team logo is passed through only when it is a web address', () => {
  const raw = league({
    teams: [
      { id: 1, name: 'Mine', logo: 'https://example.test/logo.png', owners: [] },
      { id: 2, name: 'Theirs', logo: 'not-a-url', owners: [] },
    ],
  });
  const out = buildMatchup(raw, { teamId: 1 });
  assert.equal(out.me.logo, 'https://example.test/logo.png');
  assert.equal(out.opp.logo, '');
});

// ---- Asking ESPN -----------------------------------------------------------------------------

test('if the normal response has no lineups, asks again for the specific week and merges it', async () => {
  const calls = [];
  const lineup = [entry(0, 'Quarter Quinn', { proj: 10, actual: 12 })];
  const fetcher = async (cfg, extra) => {
    calls.push(extra);
    return extra ? withRosters(lineup) : league();
  };
  const raw = await loadRaw({}, fetcher);
  assert.deepEqual(calls, [undefined, { scoringPeriodId: 8, matchupPeriodId: 8 }]);
  assert.equal(buildMatchup(raw, { teamId: 1 }).me.players.length, 1);
  assert.equal(raw.teams.length, 3, 'keeps the team list from the first response');
});

test('does not ask twice when the first response already has lineups', async () => {
  let calls = 0;
  await loadRaw({}, async () => {
    calls += 1;
    return withRosters([entry(0, 'A', { proj: 1, actual: 1 })]);
  });
  assert.equal(calls, 1);
});

test('keeps the scores if the second request fails', async () => {
  const fetcher = async (cfg, extra) => {
    if (extra) throw new UserError('Could not reach ESPN');
    return league();
  };
  const raw = await loadRaw({}, fetcher);
  assert.equal(buildMatchup(raw, { teamId: 1 }).me.players.length, 0);
});

test('a failure on the first request still surfaces', async () => {
  await assert.rejects(
    loadRaw({}, async () => {
      throw new UserError('ESPN login rejected (401)');
    }),
    /login rejected/,
  );
});

test('request URL targets the right league and season with all views', () => {
  const url = buildUrl({ leagueId: '123', season: 2026 });
  assert.equal(url.host, 'lm-api-reads.fantasy.espn.com');
  assert.equal(url.pathname, '/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123');
  assert.ok(url.searchParams.getAll('view').includes('mMatchupScore'));
  assert.ok(url.searchParams.getAll('view').includes('mBoxscore'));
  assert.equal(url.searchParams.has('scoringPeriodId'), false);
});

test('request URL can name a specific week', () => {
  const url = buildUrl({ leagueId: '123', season: 2026 }, { scoringPeriodId: 8 });
  assert.equal(url.searchParams.get('scoringPeriodId'), '8');
});

test('season rolls over after the new year', () => {
  assert.equal(defaultSeason(new Date(2026, 9, 26)), 2026); // Oct
  assert.equal(defaultSeason(new Date(2027, 0, 15)), 2026); // Jan, still last season
  assert.equal(defaultSeason(new Date(2027, 2, 1)), 2027); // Mar
});

// ---- Sample data -----------------------------------------------------------------------------

test('sample data runs through the same parser, with full lineups', () => {
  const out = buildMatchup(sampleRaw(), { teamId: '1' });
  assert.equal(out.me.name, 'Sample Squad');
  assert.equal(out.opp.name, 'Gridiron Ghosts of the Midwest', 'long on purpose, to show the wrapped team name');
  assert.match(out.me.logo, /^https:\/\//);
  assert.match(out.me.score, /^\d+\.\d{2}$/);
  assert.equal(out.me.players.length, 9);
  assert.equal(out.opp.players.length, 9);
  assert.deepEqual(
    out.me.players.map((p) => p.slot),
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'],
  );
});

test('sample team totals equal the sum of the listed players', () => {
  for (const now of [0, 30 * 60_000, 150 * 60_000]) {
    const out = buildMatchup(sampleRaw(now), { teamId: '1' });
    const sum = out.me.players.reduce((total, p) => total + Number(p.pts), 0);
    assert.ok(Math.abs(sum - Number(out.me.score)) < 0.2, `${sum} vs ${out.me.score}`);
  }
});

test('win percentages: even teams split 50/50, leaders favored, always sum to 100', () => {
  const { winPercents } = require('./espn');
  assert.deepEqual(winPercents(0, 100, 0, 100), [50, 50]);
  const [a, b] = winPercents(0, 135.6, 0, 102.3);
  assert.ok(a > 50 && a < 99);
  assert.equal(a + b, 100);
  // A big lead late in the week is close to decided
  const [lead] = winPercents(150, 100, 100, 100);
  assert.ok(lead >= 95);
});

test('matchup includes a win percentage for each side', () => {
  const m = buildMatchup(sampleRaw(), { teamId: 1 });
  assert.equal(m.me.win + m.opp.win, 100);
});
