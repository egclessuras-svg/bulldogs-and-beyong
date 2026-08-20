'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DATA_DIR } = require('./store');

const BASE_URL = 'https://api.sleeper.app/v1';
const PLAYERS_CACHE_FILE = path.join(DATA_DIR, 'players-cache.json');
const PLAYERS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Sleeper's player dump barely changes intra-day
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Couldn't reach Sleeper (${url}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Sleeper API returned ${res.status} for ${url}`);
  }
  return res.json();
}

// The full /players/nfl dump is several MB and rarely changes, so it's cached
// to disk instead of re-fetched on every import.
async function getPlayersCached() {
  try {
    const stat = await fsp.stat(PLAYERS_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < PLAYERS_CACHE_MAX_AGE_MS) {
      const raw = await fsp.readFile(PLAYERS_CACHE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const players = await fetchJson(`${BASE_URL}/players/nfl`);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(PLAYERS_CACHE_FILE, JSON.stringify(players), 'utf8');
  return players;
}

// Pulls a league's current rosters/owners from Sleeper and lays them into the
// same { teamOrder, teams, availablePlayers } shape the CSV importer produces.
// Contracts (value/years/IR) aren't a Sleeper concept, so every roster player
// comes in with a $0 / 0yr placeholder contract for the commissioner to fill
// in afterward (via the contracts-only CSV or the admin edit screen). Sleeper
// also doesn't expose per-player bye week, so bye is left null here.
async function getLeagueImport(leagueId, { capAmount, newId }) {
  const [league, rosters, users, players] = await Promise.all([
    fetchJson(`${BASE_URL}/league/${leagueId}`),
    fetchJson(`${BASE_URL}/league/${leagueId}/rosters`),
    fetchJson(`${BASE_URL}/league/${leagueId}/users`),
    getPlayersCached(),
  ]);
  if (!league || league.sport !== 'nfl') {
    throw new Error('That Sleeper league ID did not resolve to an NFL league.');
  }

  const userById = {};
  (users || []).forEach((u) => { userById[u.user_id] = u; });

  const teams = {};
  const teamOrder = [];
  const rosteredPlayerIds = new Set();

  (rosters || []).forEach((roster) => {
    const owner = userById[roster.owner_id];
    const teamName = (owner && (owner.metadata?.team_name || owner.display_name)) || `Team ${roster.roster_id}`;
    teams[teamName] = { budget: capAmount, extraSlots: 0, roster: [] };
    teamOrder.push(teamName);
    (roster.players || []).forEach((playerId) => {
      rosteredPlayerIds.add(playerId);
      const p = players[playerId];
      if (!p) return;
      teams[teamName].roster.push({
        id: newId(),
        name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        pos: p.position || '',
        team: p.team || 'FA',
        bye: null,
        contractValue: 0,
        contractYears: 0,
        yearsRemaining: 0,
        ir: false,
        wonThisSession: false,
      });
    });
  });

  const availablePlayers = Object.keys(players)
    .filter((id) => !rosteredPlayerIds.has(id))
    .map((id) => players[id])
    .filter((p) => p.team && FANTASY_POSITIONS.has(p.position) && p.status !== 'Inactive')
    .map((p) => ({
      name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      pos: p.position,
      team: p.team,
      bye: null,
      sortValue: 0,
      cutAt: null,
    }));

  return { leagueName: league.name, teamOrder, teams, availablePlayers };
}

module.exports = { getLeagueImport, getPlayersCached };
