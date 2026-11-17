#!/usr/bin/env bash
# Commit what this run pulled and tell the publish job whether the site needs a rebuild
# (writes changed=true|false to $GITHUB_OUTPUT). Marker files alone aren't worth a rebuild.
set -euo pipefail
git config user.name "halo-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add data players.txt
if git diff --cached --quiet; then echo "changed=false" >> "$GITHUB_OUTPUT"; echo "Nothing new."; exit 0; fi
if git diff --cached --quiet -- . ':!data/last.json' ':!data/checked.json'; then visible=false; else visible=true; fi
git commit -m "data: ingest $(date -u +%Y-%m-%dT%H:%MZ)"
git pull --rebase -q origin main   # safety net for a code push that landed mid-run
git push
echo "changed=$visible" >> "$GITHUB_OUTPUT"
