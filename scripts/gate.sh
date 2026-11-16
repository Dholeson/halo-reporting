#!/usr/bin/env bash
# Gate for the Ingest & report workflow: should this run pull games, and for whom?
# Writes run=, scope= (me|all) and topup= to $GITHUB_OUTPUT.
# It lives outside ingest.yml so tuning it never edits the workflow file: GitHub re-registers a
# workflow's schedule when the file changes, and a fresh registration can take hours to start firing.
#
# Env: EVENT, SCHEDULE (the cron that fired), PHASE and GAMERTAGS (dispatch inputs),
#      GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT, GH_TOKEN.
set -u
out() { printf 'run=%s\nscope=%s\ntopup=%s\n' "$1" "$2" "${3:-false}" | tee -a "$GITHUB_OUTPUT"; }

# Scouts and full-history loads from the app: always, for everyone they name.
if [ "$EVENT" = "workflow_dispatch" ] && [ -n "${PHASE:-}${GAMERTAGS:-}" ]; then out true all; exit 0; fi

runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ingest.yml/runs?per_page=20" 2>/dev/null || echo '{}')
# GitHub keeps only one pending run per concurrency group and cancels the older one, so a poll must
# never queue behind other work (it could cancel a scout you asked for). The app holds its own
# requests until GitHub is idle, so dispatches skip this.
if [ "$EVENT" != "workflow_dispatch" ]; then
  busy=$(jq "[.workflow_runs[]? | select(.status != \"completed\" and .id != $GITHUB_RUN_ID)] | length" <<<"$runs" 2>/dev/null || echo 0)
  if [ "${busy:-0}" -gt 0 ]; then echo "Another ingest run is active or queued; skipping this poll."; out false me; exit 0; fi
fi

marks=$(gh api "repos/$GITHUB_REPOSITORY/contents/data/last.json" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)
last_game=$(jq -r '.last_game_end // 0' <<<"${marks:-{\}}" 2>/dev/null || echo 0)
last_full=$(jq -r '.last_full // 0' <<<"${marks:-{\}}" 2>/dev/null || echo 0)
prev=$(jq -r "[.workflow_runs[]? | select(.id != $GITHUB_RUN_ID) | .created_at][0] // empty" <<<"$runs" 2>/dev/null || true)
now=$(date +%s)
age=$(( now - ${last_game:-0} ))
quiet=$(( now - $(date -d "${prev:-1970-01-01T00:00:00Z}" +%s 2>/dev/null || echo 0) ))
echo "Your last game ended $(( age / 60 )) min ago; last full refresh $(( (now - ${last_full:-0}) / 60 )) min ago; previous run $(( quiet / 60 )) min ago"

scope=me; topup=false
# Everyone (scouted players too) is refreshed, and older history topped up, every 6 hours.
if [ $(( now - ${last_full:-0} )) -ge 21600 ]; then scope=all; topup=true; fi
# Sync now / the app's own checks: everyone, plus the 6-hourly backfill when it's due.
if [ "$EVENT" = "workflow_dispatch" ]; then out true all "$topup"; exit 0; fi
# The 5-minute tick only matters while you're playing. But GitHub sometimes delivers ticks hours
# apart: if nothing has run for 15 minutes, any tick that does arrive is worth using.
if [ "${SCHEDULE:-}" = "*/5 * * * *" ] && [ "$age" -ge 10800 ] && [ "$quiet" -lt 900 ]; then out false "$scope"; exit 0; fi
out true "$scope" "$topup"
