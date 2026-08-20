# Bulldogs & Beyond — Free Agency Auction

A live, multi-device dynasty free agency auction for an 8-team fantasy
football league. One commissioner loads the league (via CSV or a live
Sleeper import), everyone else opens the same URL on their own phone or
laptop, claims their team, and the app runs the nomination/bidding clock
for the whole room in real time.

## How it works

- **Import.** The commissioner sets a PIN, then either uploads a CSV
  (`Team, Player, Position, NFL Team, Bye, Contract value, Years remaining, IR`
  — rows with `Team = Free Agent` seed the auction pool, everything else
  builds that team's starting roster) or enters a Sleeper league ID to pull
  current rosters live. Sleeper has no concept of contracts, so
  Sleeper-imported players come in at a $0 / 0yr placeholder — upload a
  contracts-only CSV (`Player, Contract value, Years remaining, IR`)
  afterward from the commissioner panel to fill those in before starting.
- **Claim a team.** Once the draft starts, each of the 8 people opens the
  app and picks their team from a list — no accounts or passwords. A team
  can't be claimed twice from different devices; the device that claimed it
  can always rejoin (a token is kept in that browser's local storage).
- **Draft.** Teams with open roster spots take turns nominating a free
  agent with a starting bid. Everyone else can bid up to their remaining
  cap space; the winner's cap and roster update instantly for the whole
  room. The server owns the clock, so nomination/bid timers resolve the
  same way no matter whose screen is open when they expire.
- **Cut.** A team can cut a player who was already on its roster at import
  time to free up cap space and a roster slot. **A player won at auction
  during the draft can never be cut** — once you win them, they're on your
  roster for good.
- **Commissioner tools** (gear icon, PIN-protected): edit the cap amount,
  base roster size, and nominate/bid timers before the draft starts; give a
  specific team extra roster slots at any time (e.g. for an IR stash);
  upload a contracts CSV after a Sleeper import; start the draft; or wipe
  the league and start over.

## Run it locally

```
npm install
npm start
```

Then open `http://localhost:3000` in a browser (or several, to simulate
multiple devices).

State is persisted to `data/state.json` on disk, so a server restart
doesn't lose an in-progress draft.

## Deploying for draft night

This is a plain Node/Express app with no database server and no build
step, so it runs on any host that gives you a persistent Node process and
a writable disk — Railway, Render, Fly.io, a small VPS, or a machine on
your own network:

1. Push this repo (or deploy from git) to your host of choice.
2. Set the `PORT` environment variable if your host requires it (defaults
   to `3000`).
3. Make sure the host's filesystem is persistent between requests/restarts
   — `data/state.json` is where the draft lives. Most PaaS free tiers wipe
   ephemeral disks on redeploy, so pick a plan/host with a persistent
   volume, or attach one.
4. If you'll use the Sleeper import, the host needs outbound HTTPS access
   to `api.sleeper.app` (this is the default on virtually every host; it's
   only restrictive network sandboxes that block it).
5. Share the URL with your 7 friends for draft night.

## Tests

```
npm test
```

Runs the business-logic tests (`server/state.test.js`, covering the
cut-lock rule, roster-limit/extra-slots math, team-claim race protection,
and bid validation) and a mocked Sleeper-import test
(`server/sleeper.test.js`).
