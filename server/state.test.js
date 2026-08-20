'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('./state');

function fakeParsed() {
  return {
    teamOrder: ['Alpha', 'Beta'],
    teams: {
      Alpha: { budget: 195, extraSlots: 0, roster: [{ id: 'a1', name: 'Starter A', pos: 'RB', team: 'DAL', bye: 7, contractValue: 5, contractYears: 1, yearsRemaining: 1, ir: false, wonThisSession: false }] },
      Beta: { budget: 200, extraSlots: 0, roster: [] },
    },
    availablePlayers: [{ name: 'Free Guy', pos: 'WR', team: 'MIA', bye: 8, sortValue: 0, cutAt: null }],
  };
}

function freshDraftState() {
  const s = S.startNewLeague(fakeParsed(), { pin: '1234' });
  S.startDraft(s, '1234');
  return s;
}

test('a player won at auction cannot be cut, but a pre-loaded player can', () => {
  const s = freshDraftState();
  S.nominate(s, 'Alpha', 'Free Guy', 5);
  s.currentAuction.timerEnd = Date.now() - 1; // force expiry
  S.applyTicks(s);

  const won = s.teams.Alpha.roster.find((p) => p.name === 'Free Guy');
  assert.ok(won.wonThisSession, 'newly won player should be flagged wonThisSession');
  assert.throws(() => S.cutPlayer(s, 'Alpha', won.id), /can't be cut/);

  const preloaded = s.teams.Alpha.roster.find((p) => p.name === 'Starter A');
  assert.strictEqual(preloaded.wonThisSession, false);
  assert.doesNotThrow(() => S.cutPlayer(s, 'Alpha', preloaded.id));
  assert.strictEqual(s.teams.Alpha.budget, 195); // $195 start - $5 winning bid + $5 contract freed by the cut
});

test('roster limit comes from settings.rosterBaseLimit + team.extraSlots, not an IR count', () => {
  const s = freshDraftState();
  assert.strictEqual(S.openSlots(s, 'Beta'), 23);
  S.setExtraSlots(s, 'Beta', 3, '1234');
  assert.strictEqual(S.openSlots(s, 'Beta'), 26);
  assert.throws(() => S.setExtraSlots(s, 'Beta', 2, 'wrong-pin'), /Incorrect commissioner PIN/);
});

test('a second device cannot claim a team already claimed by another device', () => {
  const s = freshDraftState();
  const token = S.claimTeam(s, 'Alpha', null);
  assert.throws(() => S.claimTeam(s, 'Alpha', null), /already claimed/);
  assert.doesNotThrow(() => S.claimTeam(s, 'Alpha', token)); // same device rejoins fine
});

test('bidding below the current bid, on your own team, or over cap is rejected', () => {
  const s = freshDraftState();
  S.nominate(s, 'Alpha', 'Free Guy', 5);
  assert.throws(() => S.placeBid(s, 'Alpha', 6), /already the high bidder/);
  assert.throws(() => S.placeBid(s, 'Beta', 5), /higher than/);
  assert.throws(() => S.placeBid(s, 'Beta', 999), /exceeds your remaining cap/);
  assert.doesNotThrow(() => S.placeBid(s, 'Beta', 10));
});

test('settings cannot change after the draft has started', () => {
  const s = freshDraftState();
  assert.throws(() => S.updateSettings(s, { capAmount: 300 }, '1234'), /after the draft has started/);
});
