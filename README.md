# halo-reporting

Halo Infinite stats, pulled from Halo Waypoint every 6 hours by GitHub Actions,
stored in this repo as raw JSON (`data/`), and published as a report on GitHub Pages.
Nothing runs or is stored on your own machine.

## How it works

| Piece | Where |
|---|---|
| Ingest (`halo/ingest.py`) | `Ingest & report` workflow, cron every 6h |
| Data | `data/matches/YYYY-MM.jsonl`: one raw match-stats JSON per line |
| Report (`halo/report.py`) | Built after each ingest → GitHub Pages; also `player_matches.parquet` |
| Credentials | Repo Actions secrets only |

Auth chain: Microsoft refresh token → Xbox user token → XSTS → Halo Spartan token.
Microsoft rotates refresh tokens, so each run writes the new one back to the
`HALO_REFRESH_TOKEN` secret (that's what `SECRETS_PAT` is for).

## One-time setup

1. **Azure app** (portal.azure.com → App registrations → New registration)
   - Supported account types: *Personal Microsoft accounts only*
   - Redirect URI: platform **Web**, `https://localhost`
   - Then Certificates & secrets → New client secret. Copy the **Value**.
2. **Fine-grained GitHub token** (github.com/settings/personal-access-tokens/new)
   - Repository access: only this repo
   - Permissions: **Secrets → Read and write**. Nothing else.
3. **Repo secrets** (Settings → Secrets and variables → Actions):
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SECRETS_PAT`
4. **Sign in once**: Actions → *Bootstrap Xbox sign-in* → Run with the box empty →
   open the link in the log → sign in → copy the `https://localhost/?code=…` URL
   (the page won't load; that's expected) → run the workflow again within ~5 min with that URL.
5. **Backfill**: Actions → *Ingest & report* → Run, tick *backfill*, max `1000`.

## Tracking friends

Add gamertags to `players.txt`. Only tracked players' rows show up in the report.

## Local / Claude Code

```bash
uv sync
uv run python -m halo.report   # rebuild site/ from data/
```

Unofficial API: be polite with request rates (client is capped at 3 req/s per service).
