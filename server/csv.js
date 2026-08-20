'use strict';

const DEFAULT_CAP = 200;

function splitLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().length);
}

function headerIndex(headers, key) {
  return headers.indexOf(key);
}

function normalizeHeader(h) {
  return h.trim().toLowerCase().replace(/\s+/g, '');
}

// Full league import: Team, Player, Position, NFL Team, Bye, Contract value,
// Years remaining, IR. Rows with Team = "Free Agent" seed the auction pool;
// every other row builds that team's starting roster.
function parseFullRosterCsv(text, newId, capAmount) {
  const lines = splitLines(text);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(normalizeHeader);
  const idx = {
    team: headerIndex(headers, 'team'),
    player: headerIndex(headers, 'player'),
    pos: headerIndex(headers, 'position'),
    nflteam: headerIndex(headers, 'nflteam'),
    bye: headerIndex(headers, 'bye'),
    value: headerIndex(headers, 'contractvalue'),
    yrs: headerIndex(headers, 'yearsremaining'),
    ir: headerIndex(headers, 'ir'),
  };
  if (idx.team === -1 || idx.player === -1) return null;

  const teams = {};
  const teamOrder = [];
  const availablePlayers = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const teamRaw = cols[idx.team];
    if (!teamRaw) continue;
    const name = cols[idx.player];
    const pos = idx.pos > -1 ? (cols[idx.pos] || '').toUpperCase() : '';
    const nflTeam = idx.nflteam > -1 ? cols[idx.nflteam] : '';
    const bye = idx.bye > -1 ? parseInt(cols[idx.bye], 10) || null : null;
    const val = idx.value > -1 ? parseFloat(cols[idx.value]) || 0 : 0;
    const yrs = idx.yrs > -1 ? parseInt(cols[idx.yrs], 10) || 0 : 0;
    const irYes = idx.ir > -1 ? /^y/i.test(cols[idx.ir]) : false;

    if (teamRaw.trim().toLowerCase() === 'free agent') {
      availablePlayers.push({ name, pos, team: nflTeam, bye, sortValue: val, cutAt: null });
      continue;
    }
    if (!teams[teamRaw]) {
      teams[teamRaw] = { budget: capAmount, extraSlots: 0, roster: [] };
      teamOrder.push(teamRaw);
    }
    teams[teamRaw].roster.push({
      id: newId(), name, pos, team: nflTeam, bye,
      contractValue: val, contractYears: yrs, yearsRemaining: yrs,
      ir: irYes, wonThisSession: false,
    });
  }

  teamOrder.forEach((name) => {
    const spent = teams[name].roster.reduce((s, p) => s + p.contractValue, 0);
    teams[name].budget = capAmount - spent;
  });

  return { teamOrder, teams, availablePlayers };
}

// Contracts-only import, used to lay contract value/years/IR onto a roster
// that was already pulled in live from Sleeper: Player, Contract value,
// Years remaining, IR (Team column is optional and only used to sanity-check
// the player landed on the roster you expected).
function parseContractsCsv(text) {
  const lines = splitLines(text);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(normalizeHeader);
  const idx = {
    team: headerIndex(headers, 'team'),
    player: headerIndex(headers, 'player'),
    value: headerIndex(headers, 'contractvalue'),
    yrs: headerIndex(headers, 'yearsremaining'),
    ir: headerIndex(headers, 'ir'),
  };
  if (idx.player === -1) return null;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const player = cols[idx.player];
    if (!player) continue;
    rows.push({
      team: idx.team > -1 ? cols[idx.team] : null,
      player,
      contractValue: idx.value > -1 ? parseFloat(cols[idx.value]) || 0 : 0,
      yearsRemaining: idx.yrs > -1 ? parseInt(cols[idx.yrs], 10) || 0 : 0,
      ir: idx.ir > -1 ? /^y/i.test(cols[idx.ir]) : false,
    });
  }
  return rows;
}

// Inverse of parseFullRosterCsv: rosters + the free-agent pool, back into the
// exact header format expected on import, so a season's final export can be
// re-uploaded as next season's starting point.
function buildFullRosterCsv({ teamOrder, teams, availablePlayers }) {
  const lines = ['Team,Player,Position,NFL Team,Bye,Contract value,Years remaining,IR'];
  teamOrder.forEach((name) => {
    teams[name].roster.forEach((p) => {
      lines.push([name, p.name, p.pos, p.team, p.bye != null ? p.bye : '', p.contractValue, p.yearsRemaining, p.ir ? 'Y' : 'N'].join(','));
    });
  });
  availablePlayers.forEach((p) => {
    lines.push(['Free Agent', p.name, p.pos, p.team, p.bye != null ? p.bye : '', p.sortValue || 0, 0, 'N'].join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseFullRosterCsv, parseContractsCsv, buildFullRosterCsv, DEFAULT_CAP };
