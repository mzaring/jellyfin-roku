'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMatchup, sampleRaw, findMyTeamId, buildUrl, defaultSeason, UserError } = require('./espn');

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

test('formats a matchup for display and marks the leader', () => {
  const out = buildMatchup(league(), { swid: '{AAAA-1111}' });
  assert.equal(out.ok, true);
  assert.equal(out.label, 'Week 8');
  assert.equal(out.lead, 'me');
  assert.deepEqual(out.me, { name: 'Mine', score: '101.24', proj: '' });
  assert.deepEqual(out.opp, { name: 'Their Team', score: '99.50', proj: '' });
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

test('prefers live totals and shows live projection when ESPN provides them', () => {
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
  assert.equal(out.me.proj, 'proj 120.0');
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

test('sample data runs through the same parser', () => {
  const out = buildMatchup(sampleRaw(), { teamId: '1' });
  assert.equal(out.me.name, 'Sample Squad');
  assert.equal(out.opp.name, 'Gridiron Ghosts');
  assert.match(out.me.score, /^\d+\.\d{2}$/);
});

test('request URL targets the right league and season with all views', () => {
  const url = buildUrl({ leagueId: '123', season: 2026 });
  assert.equal(url.host, 'lm-api-reads.fantasy.espn.com');
  assert.equal(url.pathname, '/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123');
  assert.ok(url.searchParams.getAll('view').includes('mMatchupScore'));
});

test('season rolls over after the new year', () => {
  assert.equal(defaultSeason(new Date(2026, 9, 26)), 2026); // Oct
  assert.equal(defaultSeason(new Date(2027, 0, 15)), 2026); // Jan, still last season
  assert.equal(defaultSeason(new Date(2027, 2, 1)), 2027); // Mar
});
