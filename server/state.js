'use strict';

const crypto = require('crypto');

class AppError extends Error {}

const DEFAULT_SETTINGS = {
  capAmount: 200,
  rosterBaseLimit: 23,
  nominateSeconds: 30,
  bidSeconds: 20,
};

let nextIdCounter = 1;
function newId() {
  return 'p' + (nextIdCounter++) + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function emptyState() {
  return {
    leagueLoaded: false,
    draftStarted: false,
    leagueName: null,
    commissionerPinHash: null,
    settings: { ...DEFAULT_SETTINGS },
    teamOrder: [],
    teams: {},
    availablePlayers: [],
    currentAuction: null,
    turnIndex: 0,
    turnDeadline: null,
    transactions: [],
    lastUpdated: Date.now(),
  };
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function verifyPin(state, pin) {
  return !!(state.commissionerPinHash && pin && hashPin(pin) === state.commissionerPinHash);
}

function requireCommissioner(state, pin) {
  if (!state.commissionerPinHash) throw new AppError('League has no commissioner PIN set yet.');
  if (!verifyPin(state, pin)) throw new AppError('Incorrect commissioner PIN.');
}

// Strips the PIN hash before state goes out over REST/WebSocket.
function publicState(state) {
  const { commissionerPinHash, ...rest } = state;
  return { ...rest, hasCommissioner: !!commissionerPinHash };
}

function logTx(state, entry) {
  entry.ts = Date.now();
  state.transactions.unshift(entry);
  if (state.transactions.length > 500) state.transactions.length = 500;
}

function teamLimit(state, team) {
  return state.settings.rosterBaseLimit + (team.extraSlots || 0);
}

function openSlots(state, teamName) {
  const team = state.teams[teamName];
  return teamLimit(state, team) - team.roster.length;
}

function nextEligibleIndex(state, fromIndex) {
  const n = state.teamOrder.length;
  if (!n) return -1;
  for (let i = 0; i < n; i++) {
    const idx = (fromIndex + i) % n;
    if (openSlots(state, state.teamOrder[idx]) > 0) return idx;
  }
  return -1;
}

function recalcBudgets(state) {
  state.teamOrder.forEach((name) => {
    const team = state.teams[name];
    const spent = team.roster.reduce((s, p) => s + p.contractValue, 0);
    team.budget = state.settings.capAmount - spent;
  });
}

function applyImportedRoster(state, parsed) {
  state.leagueName = parsed.leagueName || state.leagueName;
  state.teamOrder = parsed.teamOrder;
  state.teams = {};
  parsed.teamOrder.forEach((name) => {
    const t = parsed.teams[name];
    state.teams[name] = { budget: t.budget, extraSlots: t.extraSlots || 0, claimedBy: null, roster: t.roster };
  });
  state.availablePlayers = parsed.availablePlayers;
}

// --- League lifecycle -------------------------------------------------

function startNewLeague(parsed, { pin }) {
  if (!pin || String(pin).length < 4) throw new AppError('Choose a commissioner PIN of at least 4 characters.');
  const fresh = emptyState();
  fresh.leagueLoaded = true;
  fresh.commissionerPinHash = hashPin(pin);
  applyImportedRoster(fresh, parsed);
  logTx(fresh, { type: 'system', detail: `League data loaded — ${parsed.teamOrder.length} teams, ${parsed.availablePlayers.length} free agents` });
  return fresh;
}

function reimportLeague(state, parsed, { pin, newPin }) {
  requireCommissioner(state, pin);
  const fresh = emptyState();
  fresh.leagueLoaded = true;
  fresh.commissionerPinHash = newPin ? hashPin(newPin) : state.commissionerPinHash;
  fresh.settings = { ...state.settings };
  applyImportedRoster(fresh, parsed);
  logTx(fresh, { type: 'system', detail: `League re-imported — ${parsed.teamOrder.length} teams, ${parsed.availablePlayers.length} free agents` });
  return fresh;
}

function applyContracts(state, rows, pin) {
  requireCommissioner(state, pin);
  if (state.draftStarted) throw new AppError('Cannot edit contracts after the draft has started.');
  let matched = 0;
  rows.forEach((row) => {
    for (const teamName of state.teamOrder) {
      const team = state.teams[teamName];
      const player = team.roster.find((p) => p.name.toLowerCase() === row.player.toLowerCase());
      if (player) {
        player.contractValue = row.contractValue;
        player.contractYears = row.yearsRemaining;
        player.yearsRemaining = row.yearsRemaining;
        player.ir = row.ir;
        matched++;
        break;
      }
    }
  });
  recalcBudgets(state);
  logTx(state, { type: 'system', detail: `Contracts applied to ${matched} of ${rows.length} player(s)` });
  return { matched, total: rows.length };
}

function updateSettings(state, updates, pin) {
  requireCommissioner(state, pin);
  if (state.draftStarted) throw new AppError('Cannot change settings after the draft has started.');
  const allowed = ['capAmount', 'rosterBaseLimit', 'nominateSeconds', 'bidSeconds'];
  allowed.forEach((key) => {
    if (updates[key] != null) {
      const n = Number(updates[key]);
      if (!Number.isFinite(n) || n <= 0) throw new AppError(`Invalid value for ${key}.`);
      state.settings[key] = n;
    }
  });
  if (updates.capAmount != null) recalcBudgets(state);
  logTx(state, { type: 'system', detail: 'League settings updated' });
}

function setExtraSlots(state, teamName, value, pin) {
  requireCommissioner(state, pin);
  const team = state.teams[teamName];
  if (!team) throw new AppError('Unknown team.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new AppError('Extra slots must be zero or more.');
  team.extraSlots = Math.floor(n);
  logTx(state, { type: 'system', detail: `${teamName} roster limit set to ${teamLimit(state, team)} (${team.extraSlots} extra)` });
}

function startDraft(state, pin) {
  requireCommissioner(state, pin);
  if (!state.leagueLoaded) throw new AppError('Import a league first.');
  if (state.draftStarted) throw new AppError('Draft already started.');
  state.draftStarted = true;
  state.turnIndex = 0;
  state.turnDeadline = Date.now() + state.settings.nominateSeconds * 1000;
  logTx(state, { type: 'system', detail: 'Draft started' });
}

function resetLeague(state, pin) {
  requireCommissioner(state, pin);
  return emptyState();
}

// --- Team claiming ------------------------------------------------------

function claimTeam(state, teamName, existingToken) {
  const team = state.teams[teamName];
  if (!team) throw new AppError('Unknown team.');
  if (team.claimedBy && team.claimedBy !== existingToken) {
    throw new AppError(`${teamName} is already claimed on another device.`);
  }
  if (!team.claimedBy) {
    team.claimedBy = existingToken || crypto.randomUUID();
  }
  return team.claimedBy;
}

// --- Turn / auction clock -------------------------------------------------

function tickTurnLogic(state) {
  if (state.currentAuction) return;
  if (state.turnDeadline === null) {
    const idx = nextEligibleIndex(state, state.turnIndex);
    if (idx === -1) { state.turnDeadline = null; return; }
    state.turnIndex = idx;
    state.turnDeadline = Date.now() + state.settings.nominateSeconds * 1000;
    return;
  }
  if (Date.now() >= state.turnDeadline) {
    const skippedTeam = state.teamOrder[state.turnIndex];
    logTx(state, { type: 'skip', team: skippedTeam });
    const next = nextEligibleIndex(state, state.turnIndex + 1);
    if (next === -1) state.turnDeadline = null;
    else { state.turnIndex = next; state.turnDeadline = Date.now() + state.settings.nominateSeconds * 1000; }
  }
}

function maybeFinalizeAuction(state) {
  if (!state.currentAuction) return;
  if (Date.now() < state.currentAuction.timerEnd) return;
  const a = state.currentAuction;
  const winner = a.currentBidder;
  const bid = a.currentBid;
  const years = bid >= 5 ? 3 : (bid >= 2 ? 2 : 1);
  if (winner && state.teams[winner] && openSlots(state, winner) > 0) {
    state.teams[winner].budget -= bid;
    state.teams[winner].roster.push({
      id: newId(), name: a.player.name, pos: a.player.pos, team: a.player.team, bye: a.player.bye,
      contractValue: bid, contractYears: years, yearsRemaining: years, ir: false, wonThisSession: true,
    });
    logTx(state, { type: 'win', team: winner, player: a.player.name, pos: a.player.pos, bid, years });
  } else {
    state.availablePlayers.push({ name: a.player.name, pos: a.player.pos, team: a.player.team, bye: a.player.bye, sortValue: 0, cutAt: Date.now() });
    logTx(state, { type: 'unsold', player: a.player.name, pos: a.player.pos });
  }
  state.currentAuction = null;
  const idx = nextEligibleIndex(state, state.turnIndex);
  if (idx === -1) state.turnDeadline = null;
  else { state.turnIndex = idx; state.turnDeadline = Date.now() + state.settings.nominateSeconds * 1000; }
}

// Server owns the clock: call this on an interval and after every mutating
// request so timers resolve consistently regardless of which device is
// looking at the screen when a deadline passes.
function applyTicks(state) {
  if (!state.draftStarted) return false;
  const before = JSON.stringify([state.currentAuction, state.turnIndex, state.turnDeadline]);
  if (state.currentAuction) maybeFinalizeAuction(state);
  else tickTurnLogic(state);
  const after = JSON.stringify([state.currentAuction, state.turnIndex, state.turnDeadline]);
  return before !== after;
}

// --- Draft actions -------------------------------------------------------

function nominate(state, teamName, playerName, startBid) {
  if (state.currentAuction) throw new AppError('An auction is already running.');
  const turnTeam = state.teamOrder[state.turnIndex];
  if (teamName !== turnTeam) throw new AppError("It's not your turn to nominate.");
  if (openSlots(state, teamName) <= 0) throw new AppError('Your roster is full.');
  const team = state.teams[teamName];
  if (!Number.isFinite(startBid) || startBid < 0 || startBid > team.budget) {
    throw new AppError(`Starting bid must be between $0 and $${team.budget}`);
  }
  const pIdx = state.availablePlayers.findIndex((p) => p.name === playerName);
  if (pIdx === -1) throw new AppError('Player no longer available.');
  const player = state.availablePlayers[pIdx];
  state.availablePlayers.splice(pIdx, 1);
  state.currentAuction = {
    player, currentBid: startBid, currentBidder: teamName,
    timerEnd: Date.now() + state.settings.bidSeconds * 1000,
    bidHistory: [{ team: teamName, amount: startBid }],
  };
  logTx(state, { type: 'nominate', team: teamName, player: player.name, pos: player.pos, startBid });
  const idx = nextEligibleIndex(state, state.turnIndex + 1);
  state.turnIndex = idx === -1 ? state.turnIndex : idx;
  state.turnDeadline = null;
}

function placeBid(state, teamName, amount) {
  if (!state.currentAuction) throw new AppError('No auction is currently running.');
  const a = state.currentAuction;
  if (Date.now() >= a.timerEnd) throw new AppError('That auction just closed.');
  if (!Number.isFinite(amount) || amount <= a.currentBid) throw new AppError(`Bid must be higher than $${a.currentBid}`);
  if (openSlots(state, teamName) <= 0) throw new AppError("Your roster is full — cut someone first.");
  const team = state.teams[teamName];
  if (!team) throw new AppError('Unknown team.');
  if (amount > team.budget) throw new AppError(`Bid exceeds your remaining cap ($${team.budget})`);
  if (teamName === a.currentBidder) throw new AppError("You're already the high bidder.");
  a.currentBid = amount;
  a.currentBidder = teamName;
  a.timerEnd = Date.now() + state.settings.bidSeconds * 1000;
  a.bidHistory.unshift({ team: teamName, amount });
  logTx(state, { type: 'bid', team: teamName, player: a.player.name, amount });
}

function cutPlayer(state, teamName, playerId) {
  const team = state.teams[teamName];
  if (!team) throw new AppError('Unknown team.');
  const idx = team.roster.findIndex((p) => p.id === playerId);
  if (idx === -1) throw new AppError("Couldn't find that player on your roster.");
  const p = team.roster[idx];
  if (p.wonThisSession) {
    throw new AppError(`${p.name} was won at auction this draft and can't be cut.`);
  }
  team.roster.splice(idx, 1);
  team.budget += p.contractValue;
  state.availablePlayers.unshift({ name: p.name, pos: p.pos, team: p.team, bye: p.bye, sortValue: 0, cutAt: Date.now() });
  logTx(state, { type: 'cut', team: teamName, player: p.name, pos: p.pos, capFreed: p.contractValue });
}

module.exports = {
  AppError,
  newId,
  emptyState,
  publicState,
  verifyPin,
  startNewLeague,
  reimportLeague,
  applyContracts,
  updateSettings,
  setExtraSlots,
  startDraft,
  resetLeague,
  claimTeam,
  applyTicks,
  nominate,
  placeBid,
  cutPlayer,
  teamLimit,
  openSlots,
};
