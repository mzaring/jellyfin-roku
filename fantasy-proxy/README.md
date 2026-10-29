# Fantasy matchup overlay for Jellyfin Roku

Select the scoreboard button in Jellyfin's playback controls and a box score appears over the video with your ESPN fantasy football matchup: both teams side by side, each with its logo, projected and actual totals, and every starter's projected and actual points. Select the button again to hide it.

```
┌───────────────────────────────────────────────────────────────┐
│                            Week 8                             │
│ (logo) Sample Squad            │ (logo) Gridiron Ghosts       │
│        Proj 113.7     85.98    │        Proj 113.0     79.80  │  ← leader's score is green
│ ────────────────────────────── │ ──────────────────────────── │
│        PLAYER      PROJ   PTS  │        PLAYER      PROJ  PTS │
│ QB     Casey Archer 18.2 13.76 │ QB     Kit Landry  20.1 14.2 │
│ RB     Dana Brooks  15.4 11.65 │ RB     Lou Mercer  14.2 10.03│
│ ...                            │ ...                          │
└───────────────────────────────────────────────────────────────┘
```

Only starters are listed (no bench or injured reserve). The card sits below the row of buttons in the playback controls, so it never covers them.

There are two pieces:

1. **`fantasy-proxy/`** (this folder): a tiny Node service on your home network. It talks to ESPN (with your login cookies) and serves a small JSON document. The Roku never sees your cookies.
2. **The Roku app changes**: a `FantasyOverlay` component added to the Jellyfin video player. It polls the proxy every 30 seconds, but only while the overlay is showing.

## 1. Run the proxy

Needs [Node.js](https://nodejs.org) 22.9 or newer, on any always-on machine on your network (the Jellyfin server is a natural fit).

**Try it with fake data first** (no ESPN account needed):

```bash
cd fantasy-proxy
cp .env.example .env      # then edit .env: uncomment SAMPLE=1 and leave the rest alone
npm start
```

Open `http://localhost:8765/matchup` and you should see a sample matchup. Skip ahead to step 2 to get the overlay on your TV, then come back and use real data.

**Real data:** edit `.env`:

| Setting | Where to find it |
| --- | --- |
| `LEAGUE_ID` | In your league URL: `fantasy.espn.com/football/league?leagueId=`**`123456`** |
| `ESPN_S2` and `SWID` | Private leagues only. Log in at fantasy.espn.com in Chrome, press F12, open **Application → Cookies → fantasy.espn.com**, and copy the values of `espn_s2` and `SWID`. SWID includes the curly braces. |
| `TEAM_ID` | Optional. The proxy finds your team by matching your SWID to the team owner. Set it only if the overlay says it can't tell which team is yours. |

Then `npm start` again. The ESPN cookies expire eventually; if the overlay later says *ESPN login rejected*, copy fresh ones.

Keep `.env` private (it holds your login cookies) and don't forward the proxy's port through your router.

Run `npm test` to run the parsing tests.

## 2. Put the overlay on your Roku

1. Put your Roku in developer mode (one time): [Roku's setup guide](https://blog.roku.com/developer/2016/02/04/developer-setup-guide). Note the Roku's IP address and the password you set.
2. In `manifest` (repo root), set `fantasy_endpoint` to the proxy machine's **LAN IP**, not `localhost`:
   ```
   fantasy_endpoint=http://192.168.1.50:8765/matchup
   ```
3. Build and sideload using the project's normal flow in [docs/DEVGUIDE.md](../docs/DEVGUIDE.md): run `npm install`, open the folder in VS Code with the BrightScript Language extension, and press **F5**.

Your store copy of Jellyfin is a separate app and is not affected. The fork shows up as its own sideloaded channel. Roku allows one sideloaded channel at a time.

## Using it

- Press **Up** or **Down** during playback to open the controls, move to the row of small buttons at the top, select the **scoreboard (grid) button** at the far right, and press **OK**. Do it again to hide the overlay. (The remote's **\*** button is claimed by Roku's own menu on some devices, so it can't be relied on.)
- The overlay only polls while visible. Turn it off and it makes no requests.
- ESPN data is delayed by up to a minute or two during games. That's ESPN, not the overlay.
- If the proxy or ESPN is unreachable, the overlay keeps showing the last scores, marked *out of date*.

## Troubleshooting

| What you see | Cause |
| --- | --- |
| *Timed out reaching the fantasy service* | Wrong IP in `manifest`, proxy not running, or a firewall on the proxy machine blocking port 8765. Test from another device: `http://<ip>:8765/health`. |
| *Set fantasy_endpoint in the manifest* | The manifest line is missing or empty. |
| *ESPN login rejected* | Stale or wrong `ESPN_S2` / `SWID`. |
| *Could not tell which team is yours* | Set `TEAM_ID` in `.env` (your team's number is in the URL when you open your team: `teamId=`). |
| *Week N - no matchup* | A bye week, or ESPN has no matchup scheduled for you yet. |
| Scores look wrong or projections are blank | ESPN's API is unofficial. Set `ENABLE_RAW=1`, restart, open `/raw`, and compare with `espn.js`. |
| Totals show but the player lists are empty | ESPN didn't include lineups in its response. Open `/raw` (needs `ENABLE_RAW=1`) and look for `rosterForCurrentScoringPeriod` under `schedule`. |
| Team names show but no logos | The logo address from ESPN is missing or in a format the Roku can't draw (for example SVG). Open `/raw` and look at `teams[].logo`. Without a logo the name simply moves left. |

## Not yet verified

The ESPN request format and the proxy's parsing logic are covered by tests, but the tests use data shaped the way I expect ESPN to respond, not a captured response from a real league. That applies most to the per-player lineups and the team logos. The Roku code has been checked for structure but not compiled or run on a device. If either misbehaves on first run, `/raw` output and the Roku debug console (`telnet <roku-ip> 8085`) will show what's happening.
