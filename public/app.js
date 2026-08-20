(function () {
'use strict';

var socketState = null;
var lastStateJson = null;
var clockOffset = 0;
var ws = null;
var wsRetryMs = 1000;
var pollHandle = null;
var tickHandle = null;

var myTeam = localStorage.getItem('fa_myTeam') || null;
var activeTab = 'auction';
var nomFilter = '';
var errorMsg = '';
var showAdmin = false;
var adminUnlocked = false;
var importMode = 'csv';
var busy = false;

function tokenKey(teamName) { return 'fa_token_' + teamName; }
function myToken(teamName) { return localStorage.getItem(tokenKey(teamName)); }
function saveToken(teamName, token) { localStorage.setItem(tokenKey(teamName), token); }

function posColor(pos) {
  var m = { QB: '#D4A73C', RB: '#3C8C5C', WR: '#4A8FD6', TE: '#B25FD6', K: '#8A8A85', DEF: '#C1443A' };
  return m[pos] || '#8A8A85';
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function fmtSecs(ms) { return Math.max(0, Math.ceil(ms / 1000)); }
function serverNow() { return Date.now() + clockOffset; }

function teamLimit(team) {
  if (!socketState) return 0;
  return socketState.settings.rosterBaseLimit + (team.extraSlots || 0);
}
function openSlots(teamName) {
  var team = socketState.teams[teamName];
  return teamLimit(team) - team.roster.length;
}

// --- Networking -----------------------------------------------------

async function api(path, body) {
  var res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || 'Request failed');
  if (data.state) onServerMessage({ state: data.state, serverNow: data.serverNow || Date.now() });
  return data;
}

// The poll fallback (and every WS push) calls this on a timer regardless of
// whether anything actually changed. render() does a full innerHTML replace,
// which would otherwise wipe out an in-progress PIN entry or a chosen file
// out from under the user every few seconds — so skip the re-render (and the
// DOM reset that comes with it) when the incoming state is identical to what
// is already on screen.
function onServerMessage(payload) {
  clockOffset = payload.serverNow - Date.now();
  var incoming = JSON.stringify(payload.state);
  if (incoming === lastStateJson) return;
  lastStateJson = incoming;
  socketState = payload.state;
  render();
}

async function fetchStateOnce() {
  try {
    var res = await fetch('/api/state');
    var data = await res.json();
    onServerMessage(data);
  } catch (e) { /* transient; poll or ws will retry */ }
}

function connectWs() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onmessage = function (ev) {
    try { onServerMessage(JSON.parse(ev.data)); } catch (e) {}
  };
  ws.onopen = function () { wsRetryMs = 1000; };
  ws.onclose = function () {
    setTimeout(connectWs, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs * 2, 15000);
  };
  ws.onerror = function () { ws.close(); };
}

function startPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(fetchStateOnce, 4000); // fallback if WS drops
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(renderTimerOnly, 250);
}

function flashError(msg) {
  errorMsg = msg;
  render();
  setTimeout(function () { errorMsg = ''; render(); }, 3000);
}

async function runAction(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (e) { flashError(e.message); }
  finally { busy = false; }
}

// --- Render dispatch --------------------------------------------------

function render() {
  var root = document.getElementById('fa-root');
  if (!socketState) { root.innerHTML = '<div style="padding:2rem;text-align:center;color:#9A9A94;">Connecting…</div>'; syncAdminModal(); return; }
  if (!socketState.leagueLoaded) { renderImport(root); syncAdminModal(); return; }
  if (!myTeam || !socketState.teams[myTeam]) { renderTeamSelect(root); syncAdminModal(); return; }
  if (!socketState.draftStarted) { renderWaitingRoom(root); syncAdminModal(); return; }
  renderMain(root);
  syncAdminModal();
}

// The admin modal is appended to document.body (so it overlays the whole
// screen), independent of #fa-root's innerHTML swaps — so every render pass
// must explicitly reconcile it, or a stale instance from a previous screen
// is left behind, invisible in intent but still eating clicks.
function syncAdminModal() {
  var existing = document.getElementById('fa-admin-backdrop');
  if (existing) existing.remove();
  if (showAdmin) renderAdminModal();
}

function header() {
  return '<div class="fa-eyebrow" style="color:#D4A73C;margin-bottom:6px;">BULLDOGS & BEYOND</div>';
}

// --- Screen: import -----------------------------------------------------

function renderImport(root) {
  var html = '<div style="padding:2.2rem 1.5rem;text-align:center;">';
  html += header();
  html += '<div class="fa-scoreboard" style="font-size:24px;line-height:1.15;margin-bottom:14px;">SET UP THE LEAGUE</div>';

  html += '<div style="display:flex;border-bottom:1px solid #2A2F37;margin-bottom:16px;">';
  [['csv', 'Upload CSV'], ['sleeper', 'Import from Sleeper']].forEach(function (t) {
    html += '<div class="fa-tab' + (importMode === t[0] ? ' active' : '') + '" onclick="window.__faImportMode(\'' + t[0] + '\')">' + t[1] + '</div>';
  });
  html += '</div>';

  html += '<div style="text-align:left;">';
  html += '<label style="font-size:12px;color:#9A9A94;display:block;margin-bottom:4px;">Commissioner PIN (4+ chars — protects settings & the draft controls)</label>';
  html += '<input class="fa-input" id="fa-setup-pin" type="password" placeholder="Choose a PIN" style="width:100%;background:#1D2127;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:16px;">';

  if (importMode === 'csv') {
    html += '<div style="font-size:12px;color:#9A9A94;margin-bottom:4px;">CSV columns, in order:</div>';
    html += '<div style="font-size:11px;color:#6B6B66;font-family:monospace;margin-bottom:10px;">Team, Player, Position, NFL Team, Bye, Contract value, Years remaining, IR</div>';
    html += '<div style="font-size:12px;color:#9A9A94;margin-bottom:16px;">Rows with Team = "Free Agent" populate the auction pool. Everyone else\'s rows build that team\'s roster.</div>';
    html += '<input class="fa-input" id="fa-setup-csv" type="file" accept=".csv" style="width:100%;color:#F2F1ED;font-size:13px;margin-bottom:16px;">';
    html += '<button class="fa-btn" onclick="window.__faImportCsv()" style="width:100%;background:#3C8C5C;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;">Load league</button>';
  } else {
    html += '<div style="font-size:12px;color:#9A9A94;margin-bottom:16px;">Pulls current rosters/players live from Sleeper. Sleeper has no concept of contracts, so every player comes in at a $0 / 0yr placeholder — upload a contracts CSV afterward (Player, Contract value, Years remaining, IR) to fill those in before starting the draft.</div>';
    html += '<label style="font-size:12px;color:#9A9A94;display:block;margin-bottom:4px;">Sleeper league ID</label>';
    html += '<input class="fa-input" id="fa-setup-sleeper-id" type="text" placeholder="e.g. 987654321012345678" style="width:100%;background:#1D2127;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:16px;">';
    html += '<button class="fa-btn" onclick="window.__faImportSleeper()" style="width:100%;background:#3C8C5C;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;">Load league</button>';
  }
  html += '</div>';

  if (errorMsg) html += '<div style="background:#3A1E1E;color:#F09595;padding:8px 16px;border-radius:8px;font-size:12px;margin-top:14px;">' + esc(errorMsg) + '</div>';
  html += '</div>';
  root.innerHTML = html;
}

// --- Screen: waiting room (post-claim, pre-draft) ------------------------

function joinedCount() {
  return socketState.teamOrder.filter(function (n) { return !!socketState.teams[n].claimedBy; }).length;
}

function renderWaitingRoom(root) {
  var teamCount = socketState.teamOrder.length;
  var joined = joinedCount();
  var s = socketState.settings;
  var html = '<div style="padding:2.2rem 1.5rem;text-align:center;">';
  html += header();
  html += '<div class="fa-scoreboard" style="font-size:24px;line-height:1.15;margin-bottom:4px;">' + esc(myTeam) + '</div>';
  html += '<div style="font-size:13px;color:#9A9A94;margin-bottom:18px;">You\'re in. Waiting for the commissioner to start the draft&hellip;</div>';

  html += '<div style="background:#1D2127;border:1px solid #2A2F37;border-radius:10px;padding:14px;margin-bottom:16px;text-align:left;">';
  html += row('Teams joined', joined + ' / ' + teamCount);
  html += row('Cap per team', '$' + s.capAmount);
  html += row('Base roster spots', s.rosterBaseLimit);
  html += row('Nominate / bid timers', s.nominateSeconds + 's / ' + s.bidSeconds + 's');
  html += '</div>';

  html += '<div style="display:flex;flex-direction:column;gap:6px;max-width:340px;margin:0 auto 20px;text-align:left;">';
  socketState.teamOrder.forEach(function (name) {
    var isJoined = !!socketState.teams[name].claimedBy;
    var isMe = name === myTeam;
    html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:8px 12px;background:#1D2127;border:1px solid ' + (isMe ? '#3C8C5C' : '#2A2F37') + ';border-radius:8px;">';
    html += '<span style="' + (isMe ? 'font-weight:700;' : '') + '">' + esc(name) + (isMe ? ' (you)' : '') + '</span>';
    html += '<span style="font-size:10px;font-weight:600;color:' + (isJoined ? '#3C8C5C' : '#6B6B66') + ';">' + (isJoined ? 'JOINED' : 'WAITING') + '</span>';
    html += '</div>';
  });
  html += '</div>';

  html += '<button class="fa-btn" onclick="window.__faOpenAdmin()" style="background:none;border:1px solid #2A2F37;color:#9A9A94;font-size:13px;padding:10px 18px;border-radius:8px;margin-bottom:10px;">Commissioner tools</button><br>';
  html += '<button class="fa-btn" onclick="window.__faStartDraft()" style="background:#D4A73C;color:#14171C;font-size:15px;font-weight:700;padding:13px 28px;border-radius:10px;">Start draft (PIN required)</button>';
  html += '<div style="margin-top:16px;"><button class="fa-btn" onclick="window.__faSwitchTeam()" style="background:none;border:none;color:#6B6B66;font-size:12px;text-decoration:underline;">not your team? switch</button></div>';

  if (errorMsg) html += '<div style="background:#3A1E1E;color:#F09595;padding:8px 16px;border-radius:8px;font-size:12px;margin-top:14px;">' + esc(errorMsg) + '</div>';
  html += '</div>';
  root.innerHTML = html;
}

function row(label, value) {
  return '<div style="font-size:13px;color:#9A9A94;display:flex;justify-content:space-between;padding:4px 0;"><span>' + esc(label) + '</span><span style="color:#F2F1ED;font-weight:600;">' + esc(value) + '</span></div>';
}

// --- Screen: team select --------------------------------------------------

function renderTeamSelect(root) {
  var html = '<div style="padding:2.2rem 1.5rem;text-align:center;">';
  html += header();
  html += '<div class="fa-scoreboard" style="font-size:26px;line-height:1.1;margin-bottom:6px;">SELECT YOUR TEAM</div>';
  html += '<div style="font-size:13px;color:#9A9A94;margin-bottom:22px;">Tap your team to enter the auction room</div>';
  html += '<div style="display:flex;flex-direction:column;gap:8px;max-width:380px;margin:0 auto;">';
  socketState.teamOrder.forEach(function (name) {
    var t = socketState.teams[name];
    var claimed = !!t.claimedBy;
    html += '<button class="fa-btn" onclick="window.__faSelectTeam(\'' + esc(name).replace(/'/g, "\\'") + '\')" style="background:#1D2127;border:1px solid ' + (claimed ? '#3C3A2E' : '#2A2F37') + ';border-radius:10px;padding:14px 16px;text-align:left;color:#F2F1ED;display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="font-size:15px;font-weight:600;">' + esc(name) + (claimed ? ' <span style="font-size:10px;color:#D4A73C;font-weight:600;background:#3C3A2E;padding:2px 6px;border-radius:4px;margin-left:6px;">IN USE</span>' : '') + '</span>';
    html += '<span style="text-align:right;"><span style="font-size:14px;color:#3C8C5C;font-weight:600;">$' + t.budget + '</span><span style="font-size:11px;color:#6B6B66;display:block;">' + t.roster.length + '/' + teamLimit(t) + ' roster</span></span>';
    html += '</button>';
  });
  html += '</div>';
  if (errorMsg) html += '<div style="background:#3A1E1E;color:#F09595;padding:8px 16px;border-radius:8px;font-size:12px;margin-top:14px;">' + esc(errorMsg) + '</div>';
  html += '</div>';
  root.innerHTML = html;
}

// --- Screen: main app ------------------------------------------------------

function renderMain(root) {
  var team = socketState.teams[myTeam];
  var html = '';

  html += '<div style="padding:14px 16px;border-bottom:1px solid #2A2F37;display:flex;justify-content:space-between;align-items:center;">';
  html += '<div><div class="fa-scoreboard" style="font-size:10px;letter-spacing:0.1em;color:#D4A73C;">BULLDOGS & BEYOND</div><div style="font-size:14px;font-weight:600;">' + esc(myTeam) + '</div></div>';
  html += '<div style="display:flex;align-items:center;gap:10px;">';
  html += '<div style="text-align:right;"><div style="font-size:10px;color:#9A9A94;">CAP / ROSTER</div><div class="fa-scoreboard" style="font-size:18px;color:#3C8C5C;">$' + team.budget + ' &middot; ' + team.roster.length + '/' + teamLimit(team) + '</div></div>';
  html += '<button class="fa-btn" onclick="window.__faOpenAdmin()" title="Commissioner tools" style="background:#1D2127;border:1px solid #2A2F37;color:#9A9A94;width:30px;height:30px;border-radius:8px;font-size:14px;">⚙</button>';
  html += '</div></div>';

  if (socketState.draftEnded) {
    html += '<div style="background:#1F2E22;border-bottom:1px solid #2A2F37;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">';
    html += '<span style="font-size:12px;color:#9A9A94;">Draft complete &mdash; rosters are final.</span>';
    html += '<a href="/api/league/export-csv" style="font-size:12px;color:#3C8C5C;font-weight:600;text-decoration:underline;">Download rosters CSV</a>';
    html += '</div>';
  }

  html += '<div style="display:flex;border-bottom:1px solid #2A2F37;">';
  [['auction', 'Auction'], ['roster', 'My Roster'], ['teams', 'All Teams'], ['history', 'Transactions']].forEach(function (t) {
    html += '<div class="fa-tab' + (activeTab === t[0] ? ' active' : '') + '" onclick="window.__faTab(\'' + t[0] + '\')">' + t[1] + '</div>';
  });
  html += '</div>';

  if (errorMsg) html += '<div style="background:#3A1E1E;color:#F09595;padding:8px 16px;font-size:12px;">' + esc(errorMsg) + '</div>';

  html += '<div style="padding:16px;min-height:200px;">';
  if (activeTab === 'auction') html += renderAuctionTab();
  else if (activeTab === 'roster') html += renderRosterTab();
  else if (activeTab === 'teams') html += renderTeamsTab();
  else if (activeTab === 'history') html += renderHistoryTab();
  html += '</div>';

  html += '<div style="padding:10px 16px;text-align:center;border-top:1px solid #2A2F37;"><button class="fa-btn" onclick="window.__faSwitchTeam()" style="background:none;border:none;color:#6B6B66;font-size:12px;text-decoration:underline;">switch team</button></div>';

  root.innerHTML = html;
  renderTimerOnly();
}

function renderAuctionTab() {
  if (socketState.currentAuction) return renderAuctionBlock();
  var turnTeam = socketState.teamOrder[socketState.turnIndex];
  var isMyTurn = turnTeam === myTeam;
  var html = '';
  if (socketState.turnDeadline === null) {
    var doneMsg = socketState.draftEnded ? 'The commissioner has ended the draft.' : 'All rosters are full. The FA auction is complete.';
    html += '<div style="text-align:center;padding:20px 0;color:#9A9A94;font-size:13px;">' + doneMsg + '</div>';
    return html;
  }
  html += '<div style="background:#1D2127;border:1px solid #2A2F37;border-radius:10px;padding:14px;text-align:center;margin-bottom:14px;">';
  html += '<div style="font-size:11px;color:#9A9A94;">' + (isMyTurn ? 'YOUR TURN TO NOMINATE' : 'WAITING ON') + '</div>';
  html += '<div class="fa-scoreboard" style="font-size:20px;color:' + (isMyTurn ? '#3C8C5C' : '#F2F1ED') + ';">' + esc(turnTeam) + (isMyTurn ? ' (you)' : '') + '</div>';
  html += '<div style="font-size:12px;color:#6B6B66;margin-top:2px;"><span id="fa-nom-timer-text">' + fmtSecs(socketState.turnDeadline - serverNow()) + '</span>s to nominate</div>';
  html += '</div>';
  if (!isMyTurn) {
    html += '<div style="text-align:center;color:#6B6B66;font-size:12px;padding:8px 0 16px;">Only ' + esc(turnTeam) + ' can nominate right now. Browse available players below.</div>';
  }
  html += renderPlayerBrowser(isMyTurn);
  return html;
}

function renderAuctionBlock() {
  var a = socketState.currentAuction;
  var remaining = a.timerEnd - serverNow();
  var secs = fmtSecs(remaining);
  var team = socketState.teams[myTeam];
  var mySlotsOpen = openSlots(myTeam) > 0;
  var quickBids = [a.currentBid + 1, a.currentBid + 3, a.currentBid + 5].filter(function (b) { return b <= team.budget; });

  var html = '<div style="background:#1D2127;border:1px solid #2A2F37;border-radius:12px;padding:18px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;">';
  html += '<div>';
  html += '<div style="display:inline-block;background:' + posColor(a.player.pos) + '22;color:' + posColor(a.player.pos) + ';font-size:11px;font-weight:600;padding:3px 8px;border-radius:5px;margin-bottom:8px;">' + esc(a.player.pos) + ' &middot; ' + esc(a.player.team) + (a.player.bye ? ' &middot; bye ' + esc(a.player.bye) : '') + '</div>';
  html += '<div class="fa-scoreboard" style="font-size:23px;line-height:1.15;">' + esc(a.player.name) + '</div>';
  html += '</div>';
  html += '<div id="fa-playclock" class="fa-playclock' + (secs <= 5 ? ' fa-playclock--hot' : '') + '">';
  html += '<div id="fa-timer-ring-text" class="fa-playclock__digits">' + secs + '</div>';
  html += '<div class="fa-playclock__label">SECONDS</div>';
  html += '</div></div>';

  html += '<div class="fa-timerbar-track"><div id="fa-timer-bar" class="fa-timerbar' + (secs <= 5 ? ' fa-timerbar--hot' : '') + '" style="width:100%;"></div></div>';

  html += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px;">';
  html += '<div><div style="font-size:11px;color:#9A9A94;">CURRENT BID</div><div class="fa-scoreboard" style="font-size:32px;color:#D4A73C;">$' + a.currentBid + '</div></div>';
  html += '<div style="text-align:right;"><div style="font-size:11px;color:#9A9A94;">HIGH BIDDER</div><div style="font-size:15px;font-weight:600;color:' + (a.currentBidder === myTeam ? '#3C8C5C' : '#F2F1ED') + ';">' + esc(a.currentBidder) + (a.currentBidder === myTeam ? ' (you)' : '') + '</div></div></div>';

  if (!mySlotsOpen) {
    html += '<div style="color:#E2A0A0;font-size:12px;">Your roster is full. Cut a player from My Roster to bid.</div>';
  } else if (a.currentBidder !== myTeam) {
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    quickBids.forEach(function (b) {
      html += '<button class="fa-btn" onclick="window.__faBid(' + b + ')" style="background:#2A2F37;color:#F2F1ED;padding:9px 14px;border-radius:8px;font-size:14px;font-weight:600;">$' + b + '</button>';
    });
    html += '<div style="display:flex;gap:6px;align-items:center;flex:1;min-width:150px;">';
    html += '<input class="fa-input" id="fa-custom-bid" type="number" min="' + (a.currentBid + 1) + '" max="' + team.budget + '" placeholder="Custom" style="width:100%;background:#14171C;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:9px 10px;font-size:14px;">';
    html += '<button class="fa-btn" onclick="window.__faCustomBid()" style="background:#3C8C5C;color:#fff;padding:9px 14px;border-radius:8px;font-size:13px;font-weight:600;flex-shrink:0;">Bid</button></div></div>';
  } else {
    html += '<div style="color:#3C8C5C;font-size:13px;">You\'re the high bidder &mdash; sit tight.</div>';
  }
  html += '</div>';
  html += '<div style="margin-top:14px;font-size:12px;color:#6B6B66;">Need to cut someone to free cap or a roster spot? <span style="color:#9A9A94;text-decoration:underline;cursor:pointer;" onclick="window.__faTab(\'roster\')">Go to My Roster</span></div>';
  return html;
}

function comparePlayers(a, b) {
  var aCut = a.cutAt != null, bCut = b.cutAt != null;
  if (aCut && !bCut) return -1;
  if (!aCut && bCut) return 1;
  if (aCut && bCut) return b.cutAt - a.cutAt;
  return (b.sortValue || 0) - (a.sortValue || 0);
}

function renderPlayerBrowser(showNominate) {
  var pool = socketState.availablePlayers.filter(function (p) {
    return !nomFilter || p.name.toLowerCase().indexOf(nomFilter.toLowerCase()) !== -1 || p.pos.toLowerCase() === nomFilter.toLowerCase();
  }).slice().sort(comparePlayers).slice(0, 60);

  var html = '<input class="fa-input" id="fa-nom-search" type="text" placeholder="Search available players..." value="' + esc(nomFilter) + '" oninput="window.__faFilter(this.value)" style="width:100%;background:#1D2127;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:10px;">';

  if (showNominate) {
    var team = socketState.teams[myTeam];
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">';
    html += '<input class="fa-input" id="fa-start-bid" type="number" min="0" max="' + team.budget + '" placeholder="Starting bid $0-$' + team.budget + '" style="flex:1;background:#1D2127;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:9px 10px;font-size:13px;">';
    html += '</div>';
  }

  html += '<div style="max-height:320px;overflow-y:auto;">';
  pool.forEach(function (p) {
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 2px;border-bottom:1px solid #21252B;">';
    html += '<div><span style="font-size:14px;">' + esc(p.name) + '</span> <span style="font-size:11px;color:' + posColor(p.pos) + ';margin-left:6px;">' + esc(p.pos) + '</span> <span style="font-size:11px;color:#6B6B66;">' + esc(p.team) + (p.bye ? ' &middot; bye ' + esc(p.bye) : '') + '</span>' + (p.cutAt ? ' <span style="font-size:10px;color:#E2A0A0;">cut</span>' : '') + '</div>';
    if (showNominate) {
      html += '<button class="fa-btn" onclick="window.__faNominate(\'' + esc(p.name).replace(/'/g, "\\'") + '\')" style="background:#2A2F37;color:#F2F1ED;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;flex-shrink:0;">Nominate</button>';
    }
    html += '</div>';
  });
  if (!pool.length) html += '<div style="color:#6B6B66;font-size:13px;padding:12px 0;">No players match.</div>';
  html += '</div>';
  return html;
}

// Starting lineup shape: two QBs, two RBs, two WRs, one TE, two RB/WR/TE
// FLEX spots, one K, one DEF. Slots fill highest-contract-value-first so the
// lineup always reflects what you'd actually start, then whatever's left
// over falls to the bench, grouped by position and value the same way.
var STARTER_SLOTS = [
  { slot: 'QB', eligible: ['QB'] },
  { slot: 'QB', eligible: ['QB'] },
  { slot: 'RB', eligible: ['RB'] },
  { slot: 'RB', eligible: ['RB'] },
  { slot: 'WR', eligible: ['WR'] },
  { slot: 'WR', eligible: ['WR'] },
  { slot: 'TE', eligible: ['TE'] },
  { slot: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  { slot: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  { slot: 'K', eligible: ['K'] },
  { slot: 'DEF', eligible: ['DEF'] },
];
var BENCH_POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

function buildLineup(roster) {
  var pool = roster.slice().sort(function (a, b) { return b.contractValue - a.contractValue; });
  var used = {};
  var starters = STARTER_SLOTS.map(function (def) {
    var pick = pool.find(function (p) { return !used[p.id] && def.eligible.indexOf(p.pos) !== -1; });
    if (pick) used[pick.id] = true;
    return { slot: def.slot, player: pick || null };
  });
  var bench = pool.filter(function (p) { return !used[p.id]; }).sort(function (a, b) {
    var ai = BENCH_POS_ORDER.indexOf(a.pos); if (ai === -1) ai = BENCH_POS_ORDER.length;
    var bi = BENCH_POS_ORDER.indexOf(b.pos); if (bi === -1) bi = BENCH_POS_ORDER.length;
    return ai !== bi ? ai - bi : b.contractValue - a.contractValue;
  });
  return { starters: starters, bench: bench };
}

function rosterRow(slotLabel, p) {
  var slotTag = '<div style="width:38px;flex-shrink:0;font-size:10px;font-weight:700;letter-spacing:0.04em;color:#6B6B66;text-align:center;">' + (slotLabel ? esc(slotLabel) : '') + '</div>';

  if (!p) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid #21252B;">' + slotTag +
      '<div style="flex:1;border:1px dashed #2A2F37;border-radius:6px;padding:8px 10px;font-size:12px;color:#4A4E55;">Empty ' + esc(slotLabel) + ' slot</div></div>';
  }

  var html = '<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid #21252B;">' + slotTag;
  html += '<div style="flex:1;min-width:0;"><span style="font-size:14px;">' + esc(p.name) + '</span> <span style="font-size:11px;color:' + posColor(p.pos) + ';margin-left:6px;">' + esc(p.pos) + '</span>' + (p.ir ? ' <span style="font-size:10px;color:#C1443A;background:#3A1E1E;padding:2px 5px;border-radius:4px;margin-left:4px;">IR</span>' : '');
  html += '<div style="font-size:11px;color:#6B6B66;margin-top:2px;">$' + p.contractValue + ' cap hit &middot; ' + p.yearsRemaining + 'yr remaining</div></div>';
  if (p.wonThisSession) {
    html += '<span style="font-size:11px;color:#6B6B66;flex-shrink:0;" title="Won at auction this draft — can\'t be cut">Locked</span>';
  } else {
    html += '<button class="fa-btn" data-id="' + esc(p.id) + '" onclick="window.__faCut(this.getAttribute(\'data-id\'))" style="background:#3A1E1E;color:#F09595;padding:7px 12px;border-radius:6px;font-size:12px;font-weight:600;flex-shrink:0;">Cut</button>';
  }
  html += '</div>';
  return html;
}

function renderRosterTab() {
  var team = socketState.teams[myTeam];
  var html = '<div style="display:flex;justify-content:space-between;font-size:12px;color:#9A9A94;margin-bottom:10px;">';
  html += '<span>' + team.roster.length + ' / ' + teamLimit(team) + ' roster spots used</span></div>';
  html += '<div style="font-size:12px;color:#9A9A94;margin-bottom:10px;">$' + team.budget + ' cap room</div>';

  if (!team.roster.length) {
    html += '<div style="color:#6B6B66;font-size:13px;padding:12px 0;">No players rostered.</div>';
    return html;
  }

  var lineup = buildLineup(team.roster);
  html += '<div>';
  lineup.starters.forEach(function (row) { html += rosterRow(row.slot, row.player); });

  html += '<div style="display:flex;align-items:center;gap:10px;margin:16px 0 8px;">';
  html += '<div class="fa-yardline"></div>';
  html += '<div class="fa-eyebrow" style="color:#6B6B66;">BENCH</div>';
  html += '<div class="fa-yardline"></div>';
  html += '</div>';

  if (lineup.bench.length) {
    lineup.bench.forEach(function (p) { html += rosterRow(null, p); });
  } else {
    html += '<div style="color:#4A4E55;font-size:12px;padding:6px 2px 2px;">Nobody on the bench.</div>';
  }
  html += '</div>';
  return html;
}

function renderTeamsTab() {
  var html = '<div>';
  var names = socketState.teamOrder.slice().sort(function (a, b) { return socketState.teams[b].budget - socketState.teams[a].budget; });
  names.forEach(function (name) {
    var t = socketState.teams[name];
    var isMe = name === myTeam;
    html += '<div style="background:' + (isMe ? '#1F2E22' : '#1D2127') + ';border:1px solid ' + (isMe ? '#3C8C5C' : '#2A2F37') + ';border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="font-size:14px;font-weight:' + (isMe ? '700' : '500') + ';">' + esc(name) + '</span>';
    html += '<span style="text-align:right;"><span style="font-size:15px;font-weight:600;color:' + (t.budget < 10 ? '#E2A0A0' : '#3C8C5C') + ';">$' + t.budget + '</span><span style="font-size:11px;color:#6B6B66;display:block;">' + t.roster.length + '/' + teamLimit(t) + '</span></span>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function renderHistoryTab() {
  var html = '<div style="max-height:420px;overflow-y:auto;">';
  if (!socketState.transactions.length) html += '<div style="color:#6B6B66;font-size:13px;">No transactions yet.</div>';
  socketState.transactions.forEach(function (tx) {
    var line = '', color = '#F2F1ED';
    if (tx.type === 'win') { line = esc(tx.team) + ' won ' + esc(tx.player) + ' (' + esc(tx.pos) + ') for $' + tx.bid + ' · ' + tx.years + 'yr'; color = '#D4A73C'; }
    else if (tx.type === 'nominate') { line = esc(tx.team) + ' nominated ' + esc(tx.player) + ' at $' + tx.startBid; color = '#4A8FD6'; }
    else if (tx.type === 'bid') { line = esc(tx.team) + ' bid $' + tx.amount + ' on ' + esc(tx.player); }
    else if (tx.type === 'cut') { line = esc(tx.team) + ' cut ' + esc(tx.player) + ' — $' + tx.capFreed + ' freed'; color = '#E24B4A'; }
    else if (tx.type === 'skip') { line = esc(tx.team) + ' skipped (no nomination in time)'; color = '#6B6B66'; }
    else if (tx.type === 'unsold') { line = esc(tx.player) + ' went unsold'; color = '#6B6B66'; }
    else if (tx.type === 'system') { line = esc(tx.detail); color = '#6B6B66'; }
    var d = new Date(tx.ts);
    var timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += '<div style="padding:8px 2px;border-bottom:1px solid #21252B;font-size:13px;color:' + color + ';">' + line + '<div style="font-size:10px;color:#6B6B66;">' + timeStr + '</div></div>';
  });
  html += '</div>';
  return html;
}

function renderTimerOnly() {
  if (!socketState) return;
  var ring = document.getElementById('fa-timer-ring-text');
  var clock = document.getElementById('fa-playclock');
  var bar = document.getElementById('fa-timer-bar');
  if (socketState.currentAuction && ring) {
    var remaining = socketState.currentAuction.timerEnd - serverNow();
    var secs = fmtSecs(remaining);
    var hot = secs <= 5;
    ring.textContent = secs;
    if (clock) clock.classList.toggle('fa-playclock--hot', hot);
    if (bar) {
      var pct = Math.max(0, Math.min(100, (remaining / (socketState.settings.bidSeconds * 1000)) * 100));
      bar.style.width = pct + '%';
      bar.classList.toggle('fa-timerbar--hot', hot);
    }
  } else {
    var nomRing = document.getElementById('fa-nom-timer-text');
    if (nomRing && socketState.turnDeadline) nomRing.textContent = fmtSecs(socketState.turnDeadline - serverNow());
  }
}

// --- Admin modal ------------------------------------------------------

function renderAdminModal() {
  var backdrop = document.createElement('div');
  backdrop.id = 'fa-admin-backdrop';
  backdrop.className = 'fa-modal-backdrop';
  backdrop.onclick = function (e) { if (e.target === backdrop) window.__faCloseAdmin(); };

  var html = '<div class="fa-modal">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">';
  html += '<div class="fa-scoreboard" style="font-size:16px;color:#D4A73C;">COMMISSIONER TOOLS</div>';
  html += '<button class="fa-btn" onclick="window.__faCloseAdmin()" style="background:none;color:#9A9A94;font-size:16px;">✕</button>';
  html += '</div>';

  if (!adminUnlocked) {
    html += '<label style="font-size:12px;color:#9A9A94;display:block;margin-bottom:4px;">Commissioner PIN</label>';
    html += '<input class="fa-input" id="fa-admin-pin" type="password" style="width:100%;background:#14171C;border:1px solid #2A2F37;color:#F2F1ED;border-radius:8px;padding:9px 10px;font-size:14px;margin-bottom:10px;">';
    html += '<button class="fa-btn" onclick="window.__faUnlockAdmin()" style="width:100%;background:#3C8C5C;color:#fff;padding:10px;border-radius:8px;font-size:13px;font-weight:600;">Unlock</button>';
  } else {
    var s = socketState.settings;
    html += '<div style="font-size:12px;color:#6B6B66;margin-bottom:12px;">Unlocked for this session.</div>';

    if (!socketState.draftStarted) {
      html += '<div style="font-size:12px;color:#9A9A94;font-weight:600;margin-bottom:6px;">LEAGUE SETTINGS</div>';
      html += settingRow('cap-amount', 'Cap per team ($)', s.capAmount);
      html += settingRow('roster-base', 'Base roster spots', s.rosterBaseLimit);
      html += settingRow('nominate-secs', 'Nominate timer (s)', s.nominateSeconds);
      html += settingRow('bid-secs', 'Bid timer (s)', s.bidSeconds);
      html += '<button class="fa-btn" onclick="window.__faSaveSettings()" style="width:100%;background:#2A2F37;color:#F2F1ED;padding:9px;border-radius:8px;font-size:13px;font-weight:600;margin:6px 0 16px;">Save settings</button>';

      html += '<div style="font-size:12px;color:#9A9A94;font-weight:600;margin-bottom:6px;">CONTRACTS CSV (for Sleeper imports)</div>';
      html += '<div style="font-size:11px;color:#6B6B66;margin-bottom:8px;">Header row: Player, Contract value, Years remaining, IR</div>';
      html += '<input class="fa-input" id="fa-admin-contracts-csv" type="file" accept=".csv" style="width:100%;color:#F2F1ED;font-size:12px;margin-bottom:8px;">';
      html += '<button class="fa-btn" onclick="window.__faApplyContracts()" style="width:100%;background:#2A2F37;color:#F2F1ED;padding:9px;border-radius:8px;font-size:13px;font-weight:600;margin-bottom:16px;">Apply contracts</button>';
    }

    html += '<div style="font-size:12px;color:#9A9A94;font-weight:600;margin-bottom:6px;">EXTRA ROSTER SLOTS (e.g. for IR)</div>';
    socketState.teamOrder.forEach(function (name) {
      var t = socketState.teams[name];
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;">';
      html += '<span style="font-size:13px;flex:1;">' + esc(name) + '</span>';
      html += '<input class="fa-input" data-team="' + esc(name) + '" type="number" min="0" value="' + (t.extraSlots || 0) + '" style="width:60px;background:#14171C;border:1px solid #2A2F37;color:#F2F1ED;border-radius:6px;padding:6px;font-size:12px;">';
      html += '<button class="fa-btn" data-team="' + esc(name) + '" onclick="window.__faSetExtraSlots(this)" style="background:#2A2F37;color:#F2F1ED;padding:6px 10px;border-radius:6px;font-size:11px;font-weight:600;">Set</button>';
      html += '</div>';
    });

    html += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #2A2F37;">';
    if (!socketState.draftStarted) {
      html += '<div style="font-size:11px;color:#6B6B66;margin-bottom:8px;">' + joinedCount() + ' of ' + socketState.teamOrder.length + ' teams have joined</div>';
      html += '<button class="fa-btn" onclick="window.__faStartDraft()" style="width:100%;background:#D4A73C;color:#14171C;padding:10px;border-radius:8px;font-size:13px;font-weight:700;margin-bottom:10px;">Start draft</button>';
    } else if (!socketState.draftEnded) {
      html += '<button class="fa-btn" onclick="window.__faEndDraft()" style="width:100%;background:#2A2F37;color:#F2F1ED;padding:10px;border-radius:8px;font-size:13px;font-weight:700;margin-bottom:10px;">End draft</button>';
    } else {
      html += '<a href="/api/league/export-csv" style="display:block;box-sizing:border-box;text-align:center;text-decoration:none;width:100%;background:#3C8C5C;color:#fff;padding:10px;border-radius:8px;font-size:13px;font-weight:700;margin-bottom:10px;">Download final rosters (CSV)</a>';
    }
    html += '<button class="fa-btn" onclick="window.__faResetLeague()" style="width:100%;background:#3A1E1E;color:#F09595;padding:10px;border-radius:8px;font-size:13px;font-weight:600;">Reset league (wipes everything)</button>';
    html += '</div>';
  }

  if (errorMsg) html += '<div style="background:#3A1E1E;color:#F09595;padding:8px 10px;border-radius:8px;font-size:12px;margin-top:12px;">' + esc(errorMsg) + '</div>';
  html += '</div>';
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);
}

function settingRow(id, label, value) {
  var html = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;">';
  html += '<span style="font-size:12px;color:#9A9A94;flex:1;">' + esc(label) + '</span>';
  html += '<input class="fa-input" id="fa-setting-' + id + '" type="number" value="' + value + '" style="width:80px;background:#14171C;border:1px solid #2A2F37;color:#F2F1ED;border-radius:6px;padding:6px;font-size:12px;">';
  html += '</div>';
  return html;
}

// --- Window-bound handlers -------------------------------------------

window.__faImportMode = function (m) { importMode = m; render(); };

window.__faImportCsv = function () {
  var pin = (document.getElementById('fa-setup-pin') || {}).value || '';
  var fileInput = document.getElementById('fa-setup-csv');
  var file = fileInput && fileInput.files[0];
  if (!file) { flashError('Choose a CSV file first.'); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    runAction(async function () {
      await api('/api/league/import-csv', { csvText: e.target.result, pin: pin });
    });
  };
  reader.readAsText(file);
};

window.__faImportSleeper = function () {
  var pin = (document.getElementById('fa-setup-pin') || {}).value || '';
  var leagueId = (document.getElementById('fa-setup-sleeper-id') || {}).value || '';
  runAction(async function () {
    await api('/api/league/import-sleeper', { leagueId: leagueId, pin: pin });
  });
};

window.__faOpenAdmin = function () { showAdmin = true; render(); };
window.__faCloseAdmin = function () { showAdmin = false; adminUnlocked = false; errorMsg = ''; var b = document.getElementById('fa-admin-backdrop'); if (b) b.remove(); };

window.__faUnlockAdmin = function () {
  var pin = (document.getElementById('fa-admin-pin') || {}).value || '';
  runAction(async function () {
    var res = await api('/api/league/verify-pin', { pin: pin });
    if (!res.ok) throw new Error('Incorrect PIN.');
    adminUnlocked = true;
    sessionStorage.setItem('fa_admin_pin', pin);
    render();
  });
};

function adminPin() { return sessionStorage.getItem('fa_admin_pin') || ''; }

window.__faSaveSettings = function () {
  var updates = {
    capAmount: (document.getElementById('fa-setting-cap-amount') || {}).value,
    rosterBaseLimit: (document.getElementById('fa-setting-roster-base') || {}).value,
    nominateSeconds: (document.getElementById('fa-setting-nominate-secs') || {}).value,
    bidSeconds: (document.getElementById('fa-setting-bid-secs') || {}).value,
  };
  runAction(async function () {
    await api('/api/league/settings', { updates: updates, pin: adminPin() });
  });
};

window.__faApplyContracts = function () {
  var fileInput = document.getElementById('fa-admin-contracts-csv');
  var file = fileInput && fileInput.files[0];
  if (!file) { flashError('Choose a contracts CSV first.'); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    runAction(async function () {
      var res = await api('/api/league/contracts', { csvText: e.target.result, pin: adminPin() });
      flashError('Matched ' + res.matched + ' of ' + res.total + ' players.');
    });
  };
  reader.readAsText(file);
};

window.__faSetExtraSlots = function (btn) {
  var teamName = btn.getAttribute('data-team');
  var input = document.querySelector('input[data-team="' + CSS.escape(teamName) + '"]');
  runAction(async function () {
    await api('/api/league/extra-slots', { teamName: teamName, value: input.value, pin: adminPin() });
  });
};

window.__faStartDraft = function () {
  var joined = joinedCount();
  var total = socketState.teamOrder.length;
  if (joined < total && !confirm('Only ' + joined + ' of ' + total + ' teams have joined. Start the draft anyway?')) return;
  runAction(async function () {
    var pin = adminUnlocked ? adminPin() : ((document.getElementById('fa-admin-pin') || {}).value || prompt('Commissioner PIN:') || '');
    await api('/api/league/start-draft', { pin: pin });
    showAdmin = false;
    render();
  });
};

window.__faEndDraft = function () {
  if (!confirm('End the draft? No further nominations or bids will be allowed.')) return;
  runAction(async function () {
    await api('/api/league/end-draft', { pin: adminPin() });
    render();
  });
};

window.__faResetLeague = function () {
  if (!confirm('This wipes the entire league — teams, rosters, and history. Continue?')) return;
  runAction(async function () {
    await api('/api/league/reset', { pin: adminPin() });
    localStorage.removeItem('fa_myTeam');
    myTeam = null;
    showAdmin = false;
    adminUnlocked = false;
    render();
  });
};

window.__faSelectTeam = function (name) {
  runAction(async function () {
    var res = await api('/api/team/claim', { teamName: name, token: myToken(name) });
    saveToken(name, res.token);
    myTeam = name;
    localStorage.setItem('fa_myTeam', name);
    startPolling();
    render(); // api()'s own re-render ran with myTeam still unset — render once more now that it's assigned, so the screen advances on the first click.
  });
};

window.__faSwitchTeam = function () { myTeam = null; localStorage.removeItem('fa_myTeam'); render(); };
window.__faTab = function (t) { activeTab = t; render(); };
window.__faFilter = function (v) {
  nomFilter = v; render();
  var el = document.getElementById('fa-nom-search');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
};

window.__faNominate = function (name) {
  var bidEl = document.getElementById('fa-start-bid');
  var bid = bidEl && bidEl.value !== '' ? parseInt(bidEl.value, 10) : 0;
  if (isNaN(bid)) bid = 0;
  runAction(async function () { await api('/api/auction/nominate', { teamName: myTeam, playerName: name, startBid: bid }); });
};

window.__faBid = function (amount) {
  runAction(async function () { await api('/api/auction/bid', { teamName: myTeam, amount: amount }); });
};

window.__faCustomBid = function () {
  var el = document.getElementById('fa-custom-bid');
  var v = parseInt(el.value, 10);
  if (isNaN(v)) { flashError('Enter a bid amount first'); return; }
  window.__faBid(v);
};

window.__faCut = function (playerId) {
  if (!playerId) return;
  runAction(async function () { await api('/api/roster/cut', { teamName: myTeam, playerId: playerId }); });
};

// --- Init ---------------------------------------------------------------

(function init() {
  if (sessionStorage.getItem('fa_admin_pin')) adminUnlocked = true;
  fetchStateOnce().then(function () {
    if (myTeam && socketState && socketState.teams && socketState.teams[myTeam]) {
      window.__faSelectTeam(myTeam);
    }
  });
  connectWs();
  startPolling();
})();

})();
