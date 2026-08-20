'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const CACHE_FILE = path.join(DATA_DIR, 'players-cache.json');

const FAKE_LEAGUE = { league_id: 'L1', name: 'Test League', sport: 'nfl' };
const FAKE_USERS = [
  { user_id: 'U1', display_name: 'Alice', metadata: { team_name: 'Alpha' } },
  { user_id: 'U2', display_name: 'Bob', metadata: {} },
];
const FAKE_ROSTERS = [
  { roster_id: 1, owner_id: 'U1', players: ['P1'] },
  { roster_id: 2, owner_id: 'U2', players: ['P2'] },
];
const FAKE_PLAYERS = {
  P1: { full_name: 'Josh Allen', position: 'QB', team: 'BUF', status: 'Active' },
  P2: { full_name: "Ja'Marr Chase", position: 'WR', team: 'CIN', status: 'Active' },
  P3: { full_name: 'Free Guy', position: 'RB', team: 'DAL', status: 'Active' },
  P4: { full_name: 'No Team Guy', position: 'WR', team: null, status: 'Active' },
  P5: { full_name: 'Not Fantasy', position: 'LS', team: 'DAL', status: 'Active' },
};

function mockFetch(url) {
  if (url.endsWith('/league/L1')) return jsonResponse(FAKE_LEAGUE);
  if (url.endsWith('/league/L1/rosters')) return jsonResponse(FAKE_ROSTERS);
  if (url.endsWith('/league/L1/users')) return jsonResponse(FAKE_USERS);
  if (url.endsWith('/players/nfl')) return jsonResponse(FAKE_PLAYERS);
  throw new Error('Unexpected URL: ' + url);
}

function jsonResponse(obj) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
}

test('getLeagueImport builds teams from Sleeper rosters and pool from unrostered fantasy players', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    const sleeper = require('./sleeper');
    let idCounter = 0;
    const result = await sleeper.getLeagueImport('L1', { capAmount: 200, newId: () => 'id' + (++idCounter) });

    assert.strictEqual(result.leagueName, 'Test League');
    assert.deepStrictEqual(result.teamOrder, ['Alpha', 'Bob']);

    assert.strictEqual(result.teams.Alpha.budget, 200);
    assert.strictEqual(result.teams.Alpha.extraSlots, 0);
    assert.strictEqual(result.teams.Alpha.roster.length, 1);
    assert.strictEqual(result.teams.Alpha.roster[0].name, 'Josh Allen');
    assert.strictEqual(result.teams.Alpha.roster[0].contractValue, 0);
    assert.strictEqual(result.teams.Alpha.roster[0].wonThisSession, false);

    assert.strictEqual(result.teams.Bob.roster[0].name, "Ja'Marr Chase");

    // P3 (Free Guy) is fantasy-position + has a team + unrostered -> in the pool.
    // P4 has no team, P5 isn't a fantasy position, P1/P2 are already rostered -> excluded.
    const poolNames = result.availablePlayers.map((p) => p.name).sort();
    assert.deepStrictEqual(poolNames, ['Free Guy']);
  } finally {
    global.fetch = originalFetch;
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  }
});
