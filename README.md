# halo-reporting · Debrief

Personal Halo Infinite analytics. GitHub Actions pulls your matches from Halo
Waypoint every 6 hours, stores them in this repo (`data/`), and publishes
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

## How it works

| Piece | Where |
|---|---|
| Ingest (`halo/ingest.py`) | `Ingest & report` workflow, every 6 h. Also backfills CSR/MMR/expected stats (`data/skill/`) and names of people you play with often (`data/gamertags.json`) |
| Data | `data/matches/YYYY-MM.jsonl`: raw match JSON, one per line, so new Halo fields never break anything |
| Report (`halo/report.py`) | Copies `web/` (static app, no build step) and exports `site/data/` for it |
| Artwork | Official map/mode art and the medal sprite sheet from Halo's content API, resized into `data/art/` by the ingest (maps you've played 2+ times) |
| Credentials | Repo Actions secrets; the client ID is a repo variable |

Auth chain: Microsoft refresh token → Xbox user token → XSTS → Halo Spartan token.
Microsoft rotates refresh tokens, so each run writes the new one back to the
`HALO_REFRESH_TOKEN` secret (that's what `SECRETS_PAT` is for).

## Tracking players

`players.txt`, one gamertag per line. Add ` [me]` after your own accounts:
they're merged into **Me** in the report. Everyone else is a scouted player you
can switch to from the account picker.

Fastest way to add someone: **Actions → Ingest & report → Run workflow** and
type gamertags (comma-separated) in the first box. Their full history is pulled.

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
