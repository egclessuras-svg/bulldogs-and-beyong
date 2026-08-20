'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const csv = require('./csv');
const sleeper = require('./sleeper');
const S = require('./state');

const PORT = process.env.PORT || 3000;
const TICK_MS = 250;

let state = null;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastState() {
  const payload = JSON.stringify({ type: 'state', state: S.publicState(state), serverNow: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

async function commit() {
  await store.saveState(state);
  broadcastState();
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof S.AppError) {
        res.status(400).json({ error: err.message });
      } else {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

function currentCapAmount() {
  return state.leagueLoaded ? state.settings.capAmount : csv.DEFAULT_CAP;
}

// --- League setup / commissioner routes ------------------------------

app.post('/api/league/import-csv', asyncRoute(async (req, res) => {
  const { csvText, pin, newPin } = req.body || {};
  if (typeof csvText !== 'string') throw new S.AppError('Missing CSV text.');
  const parsed = csv.parseFullRosterCsv(csvText, S.newId, currentCapAmount());
  if (!parsed) throw new S.AppError('Could not read that CSV. Expected header row: Team,Player,Position,NFL Team,Bye,Contract value,Years remaining,IR');
  state = state.leagueLoaded
    ? S.reimportLeague(state, parsed, { pin, newPin })
    : S.startNewLeague(parsed, { pin });
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/import-sleeper', asyncRoute(async (req, res) => {
  const { leagueId, pin, newPin } = req.body || {};
  if (!leagueId) throw new S.AppError('Enter a Sleeper league ID.');
  let parsed;
  try {
    parsed = await sleeper.getLeagueImport(String(leagueId).trim(), { capAmount: currentCapAmount(), newId: S.newId });
  } catch (err) {
    throw new S.AppError(err.message);
  }
  state = state.leagueLoaded
    ? S.reimportLeague(state, parsed, { pin, newPin })
    : S.startNewLeague(parsed, { pin });
  state.leagueName = parsed.leagueName || state.leagueName;
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/contracts', asyncRoute(async (req, res) => {
  const { csvText, pin } = req.body || {};
  if (typeof csvText !== 'string') throw new S.AppError('Missing CSV text.');
  const rows = csv.parseContractsCsv(csvText);
  if (!rows) throw new S.AppError('Could not read that CSV. Expected header row: Player,Contract value,Years remaining,IR');
  const result = S.applyContracts(state, rows, pin);
  await commit();
  res.json({ ok: true, ...result, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/settings', asyncRoute(async (req, res) => {
  const { updates, pin } = req.body || {};
  S.updateSettings(state, updates || {}, pin);
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/extra-slots', asyncRoute(async (req, res) => {
  const { teamName, value, pin } = req.body || {};
  S.setExtraSlots(state, teamName, value, pin);
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/start-draft', asyncRoute(async (req, res) => {
  const { pin } = req.body || {};
  S.startDraft(state, pin);
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/reset', asyncRoute(async (req, res) => {
  const { pin } = req.body || {};
  state = S.resetLeague(state, pin);
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/league/verify-pin', asyncRoute(async (req, res) => {
  const { pin } = req.body || {};
  res.json({ ok: S.verifyPin(state, pin) });
}));

// --- Team claiming -----------------------------------------------------

app.post('/api/team/claim', asyncRoute(async (req, res) => {
  const { teamName, token } = req.body || {};
  const finalToken = S.claimTeam(state, teamName, token);
  await commit();
  res.json({ ok: true, token: finalToken, state: S.publicState(state), serverNow: Date.now() });
}));

// --- Draft actions -------------------------------------------------------

app.post('/api/auction/nominate', asyncRoute(async (req, res) => {
  const { teamName, playerName, startBid } = req.body || {};
  S.applyTicks(state);
  S.nominate(state, teamName, playerName, Number(startBid));
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/auction/bid', asyncRoute(async (req, res) => {
  const { teamName, amount } = req.body || {};
  S.applyTicks(state);
  S.placeBid(state, teamName, Number(amount));
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.post('/api/roster/cut', asyncRoute(async (req, res) => {
  const { teamName, playerId } = req.body || {};
  S.cutPlayer(state, teamName, playerId);
  await commit();
  res.json({ ok: true, state: S.publicState(state), serverNow: Date.now() });
}));

app.get('/api/state', (req, res) => {
  res.json({ state: S.publicState(state), serverNow: Date.now() });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: S.publicState(state), serverNow: Date.now() }));
});

async function tickLoop() {
  try {
    const changed = S.applyTicks(state);
    if (changed) await commit();
  } catch (err) {
    console.error('Tick loop error:', err);
  }
}

async function main() {
  state = await store.loadState(S.emptyState);
  setInterval(tickLoop, TICK_MS);
  server.listen(PORT, () => {
    console.log(`Bulldogs & Beyond FA auction listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
