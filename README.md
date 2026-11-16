# halo-reporting · Debrief

Personal Halo Infinite analytics. GitHub Actions pulls your matches from Halo
Waypoint, stores them in this repo (`data/`), and publishes
**Debrief** to GitHub Pages: pre-game briefings, post-game debriefs and coaching
built from your own history. Nothing runs or is stored on your own machine.

## The report

| Tab | What it's for |
|---|---|
| **Overview** | Your story: form headline, KPIs vs the previous period, form trend, best days/times, activity calendar, highlight reel, signature medals |
| **Briefing** | Loading into a match? Pick map + mode → verdict, your numbers there vs your baseline, how you win there, a game plan (aware of your current session and time of day) |
| **Coach** | Ranked findings with evidence and confidence: win condition, survival, finishing, tilt, session fatigue, warm-up, time of day, map pool, objective play, squad, expected vs actual |
| **Maps & Modes** | Map × mode matrix (win rate / K/D / damage ratio / games) and sortable tables |
| **Ranked** | CSR journey per account with tier bands, where you farm/bleed CSR, net CSR per session, kills/deaths vs Halo's expectation, lobby difficulty |
| **Matches** | Every game grouped into sessions; tap for the full lobby scoreboard |
| **Squad** | Your accounts side by side, regular teammates (win rate with/without), rivals, frenemies |

Filters (account, time range, queue, mode, map), presets and saved views live in
the URL, so any view can be bookmarked or shared.

## Updates, scouting and the GitHub token

New games arrive two ways:

- **The open site checks.** With a token connected, Debrief checks Halo when you open
  it and keeps checking while it's open, in a background tab too (every 10 minutes if
  you played in the last 3 hours, every 30 otherwise), whenever nothing else has pulled
  your games in that time. A check covers your own accounts, waits behind anything you
  asked for, and leaves the page alone when it finds nothing. Turn it off in the
  Updates panel.
- **GitHub's schedule.** The workflow is set to poll every 5 minutes while one of your
  games ended in the last 3 hours and every 15 otherwise, but GitHub delivers scheduled
  runs late and drops many (new schedules can take hours, sometimes a day, to start),
  so treat it as a backstop. A late tick still runs if nothing has pulled your games
  for 15 minutes.

Every 6 hours an update also refreshes everyone you've scouted and fills in older
history. Scheduled polls that find nothing don't rebuild or deploy; the site's own
checks always republish, but the build is identical (same data digest), so open pages
ignore it. The gate that decides what a run does lives in `scripts/gate.sh`, so tuning
it doesn't edit the workflow file (an edit re-registers the schedule, which restarts
GitHub's wait).

From the site you can also **Sync now**, **scout anyone** (search a gamertag, or tap a
name in a scoreboard / teammate / rival list) and **load a full history**. A scout pulls
the player's newest 300 games first (about 3 minutes), then the rest arrives in the
background; the app shows live progress and how much of the history is loaded.

Starting those from the browser needs a fine-grained GitHub token, entered once in
the Updates panel and stored only in that browser:
github.com/settings/personal-access-tokens/new → *Only select repositories* → this
repo → *Permissions: Actions → Read and write*. Nothing else. Without a token the
site works read-only for everyone.

## How it works

| Piece | Where |
|---|---|
| Ingest (`halo/ingest.py`) | `Ingest & report` workflow (scheduled, Sync now, or the site's own checks). Also backfills CSR/MMR/expected stats (`data/skill/`) and names of people you play with often (`data/gamertags.json`) |
| Data | `data/matches/YYYY-MM.jsonl`: raw match JSON, one per line, so new Halo fields never break anything |
| Report (`halo/report.py`) | Copies `web/` (static app, no build step) and exports `site/data/` for it |
| Artwork | Official map/mode art and the medal sprite sheet from Halo's content API, resized into `data/art/` by the ingest (maps you've played 2+ times) |
| Credentials | Repo Actions secrets; the client ID is a repo variable |

Auth chain: Microsoft refresh token → Xbox user token → XSTS → Halo Spartan token.
Microsoft rotates refresh tokens, so each run writes the new one back to the
`HALO_REFRESH_TOKEN` secret (that's what `SECRETS_PAT` is for).

## Tracking players

`players.txt`, one gamertag (or XUID) per line. Add ` [me]` after your own accounts:
they're merged into **Me** in the report. Everyone else is a scouted player you
can switch to from the player search.

Ways to add someone: scout them from the site, or **Actions → Ingest & report →
Run workflow** with gamertags (comma-separated) in the first box.

## One-time setup

1. **Azure app** (portal.azure.com or entra.microsoft.com → App registrations → New registration)
   - Supported account types: *Personal Microsoft accounts only*
   - Redirect URI: platform **Web**, `https://localhost`
   - Certificates & secrets → New client secret. Copy the **Value**.
2. **Fine-grained GitHub token** (github.com/settings/personal-access-tokens/new)
   - Repository access: only this repo; permissions: **Secrets → Read and write**
3. **Repo settings → Secrets and variables → Actions**
   - Variables: `AZURE_CLIENT_ID`
   - Secrets: `AZURE_CLIENT_SECRET`, `SECRETS_PAT`
   - (Keep the client ID out of secrets, or GitHub masks it as `***` in the sign-in link.)
4. **Pages**: Settings → Pages → Source: **GitHub Actions**
5. **Sign in once**: Actions → *Bootstrap Xbox sign-in* → Run with the box empty →
   open the link in the log → sign in → copy the `https://localhost/?code=…` URL →
   run again within ~5 min with that URL.
6. **Backfill**: Actions → *Ingest & report* → Run with your gamertags, and set
   *skill_max* to `2500` to pull your whole CSR history in one go.

## Local / Claude Code

```bash
uv sync
uv run python -m halo.report            # rebuild site/ from data/
cd site && python3 -m http.server 8000  # open http://localhost:8000
```

Unofficial API; requests are rate-limited (2/s per service) and retried politely
on throttling.

Halo © Microsoft Corporation. Debrief was created under Microsoft's
["Game Content Usage Rules"](https://www.xbox.com/en-US/developers/rules) using
assets from Halo Infinite, and it is not endorsed by or affiliated with Microsoft.
Personal, non-commercial use only.
