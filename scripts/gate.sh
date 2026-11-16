#!/usr/bin/env bash
# Gate for the Ingest & report workflow: should this run pull games, and for whom?
# Writes run=, scope= (me|all) and topup= to $GITHUB_OUTPUT.
# It lives outside ingest.yml so tuning it never edits the workflow file: GitHub re-registers a
# workflow's schedule when the file changes, and a fresh registration can take hours to start firing.
#
# Env: EVENT, SCHEDULE (the cron that fired), PHASE and GAMERTAGS (dispatch inputs),
#      GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT, GH_TOKEN.
# PHASE=check is the open site's automatic check: your games, plus everyone and the 6-hourly
# backfill when that's due. Sync now (no phase) is everyone.
set -u
out() { printf 'run=%s\nscope=%s\ntopup=%s\n' "$1" "$2" "${3:-false}" | tee -a "$GITHUB_OUTPUT"; }
repo="repos/$GITHUB_REPOSITORY"

# Scouts and full-history loads from the app (or gamertags typed into a manual run): always, for
# everyone they name.
if [ "$EVENT" = "workflow_dispatch" ]; then
  if [ -n "${GAMERTAGS:-}" ] || { [ -n "${PHASE:-}" ] && [ "$PHASE" != "check" ]; }; then out true all; exit 0; fi
fi

# gh prints an HTTP error's body to stdout and exits 1: never read that as a list of runs.
if ! runs=$(gh api "$repo/actions/workflows/ingest.yml/runs?per_page=20" 2>/dev/null) \
   || ! jq -e '.workflow_runs | type == "array"' >/dev/null 2>&1 <<<"$runs"; then
  # A poll that can't see what's queued could cancel a scout waiting in the concurrency group.
  if [ "$EVENT" != "workflow_dispatch" ]; then echo "Couldn't list this workflow's runs; skipping this poll."; out false me; exit 0; fi
  runs='{"workflow_runs":[]}'
fi

# GitHub keeps only one pending run per concurrency group and cancels the older one, so a poll must
# never queue behind other work (it could cancel a scout you asked for). The app holds its own
# requests until GitHub is idle, so dispatches skip this. Two late ticks GitHub creates together
# would each see the other as busy and both stand down, so a tick ignores scheduled runs created
# after it: those see this one and wait.
if [ "$EVENT" != "workflow_dispatch" ]; then
  busy=$(jq --argjson me "$GITHUB_RUN_ID" '[.workflow_runs[] | select(.status != "completed" and .id != $me and (.event != "schedule" or .id < $me))] | length' <<<"$runs")
  if [ "${busy:-0}" -gt 0 ]; then echo "Another ingest run is active or queued; skipping this poll."; out false me; exit 0; fi
fi

marks=$(gh api "$repo/contents/data/last.json" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)
last_game=$(jq -r '.last_game_end // 0' <<<"${marks:-{\}}" 2>/dev/null || echo 0)
last_full=$(jq -r '.last_full // 0' <<<"${marks:-{\}}" 2>/dev/null || echo 0)
now=$(date +%s)
age=$(( now - ${last_game:-0} ))

scope=me; topup=false
# Everyone (scouted players too) is refreshed, and older history topped up, every 6 hours.
if [ $(( now - ${last_full:-0} )) -ge 21600 ]; then scope=all; topup=true; fi
if [ "$EVENT" = "workflow_dispatch" ]; then
  echo "Your last game ended $(( age / 60 )) min ago; last full refresh $(( (now - ${last_full:-0}) / 60 )) min ago"
  if [ "${PHASE:-}" = "check" ]; then out true "$scope" "$topup"; exit 0; fi
  out true all "$topup"; exit 0
fi

# Quiet time counts from the newest run that pulled your games: not one whose gate stood down,
# and not a scout (it only pulls the players it names).
prev=""
while IFS='|' read -r id created; do
  [ -n "$id" ] || continue
  ingest=$(gh api "$repo/actions/runs/$id/jobs" --jq '.jobs[] | select(.name == "ingest") | .conclusion' 2>/dev/null) || ingest=""
  case "$ingest" in ""|skipped|"{"*) continue ;; esac
  prev=$created; break
done < <(jq -r --argjson me "$GITHUB_RUN_ID" '.workflow_runs[] | select(.id != $me and .status == "completed" and ((.display_title // "") | startswith("Scout ") | not)) | "\(.id)|\(.created_at)"' <<<"$runs" | head -n 6)
quiet=$(( now - $(date -d "${prev:-1970-01-01T00:00:00Z}" +%s 2>/dev/null || echo 0) ))
if [ -n "$prev" ]; then pulled="last pull $(( quiet / 60 )) min ago"; else pulled="no recent pull"; fi
echo "Your last game ended $(( age / 60 )) min ago; last full refresh $(( (now - ${last_full:-0}) / 60 )) min ago; $pulled"

# The 5-minute tick only matters while you're playing. But GitHub sometimes delivers ticks hours
# apart: if nothing has pulled for 15 minutes, any tick that does arrive is worth using.
if [ "${SCHEDULE:-}" = "*/5 * * * *" ] && [ "$age" -ge 10800 ] && [ "$quiet" -lt 900 ]; then out false "$scope"; exit 0; fi
out true "$scope" "$topup"
