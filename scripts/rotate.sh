#!/usr/bin/env bash
# Microsoft rotates the Halo refresh token on every sign-in. Store the new one as the HALO_REFRESH_TOKEN
# secret (needs SECRETS_PAT: a fine-grained token with Secrets read/write on this repo), and record in
# data/health.json whether that worked, so the site can say so.
#
# Never fails the job: a broken SECRETS_PAT must not stop new games from being saved. The sign-in that
# just worked keeps working for a while; it only stops renewing.
#
# Env: GH_TOKEN (SECRETS_PAT), GITHUB_REPOSITORY, RUNNER_TEMP.
set -u
f="$RUNNER_TEMP/refresh_token"
[ -s "$f" ] || exit 0

health() { # state(ok|fail) detail pat-expiry
  python3 - "$@" <<'PY'
import json, sys, time
state, detail, expires = (sys.argv[1:] + ["", ""])[:3]
path = "data/health.json"
try:
    cur = json.load(open(path))
except (OSError, ValueError):
    cur = {}
old = cur.get("signin") or {}
new = {"ok": state == "ok", "detail": "" if state == "ok" else detail[:240]}
# "since" marks when this state began; it only moves when the state changes, so a steady state
# never produces a commit of its own.
new["since"] = old.get("since") if (old.get("ok"), old.get("detail")) == (new["ok"], new["detail"]) and old.get("since") else int(time.time())
out = {**cur, "signin": new}
if expires:
    out["patExpires"] = expires
if out != cur:
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print("health.json updated:", json.dumps({k: v for k, v in out.items()}))
PY
}

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning title=Halo sign-in not saved::SECRETS_PAT isn't set, so the renewed Halo sign-in can't be stored. It will expire eventually."
  health fail "SECRETS_PAT isn't set."
  rm -f "$f"
  exit 0
fi

if err=$(gh secret set HALO_REFRESH_TOKEN --repo "$GITHUB_REPOSITORY" < "$f" 2>&1); then
  # GitHub reports a token's expiry on every API response; warn well before SECRETS_PAT runs out.
  exp=$(curl -fsS -o /dev/null -D - -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/rate_limit 2>/dev/null \
        | tr -d '\r' | awk -F': ' 'tolower($1) == "github-authentication-token-expiration" { print $2 }')
  echo "Stored the renewed Halo sign-in.${exp:+ SECRETS_PAT expires $exp.}"
  health ok "" "${exp:-}"
else
  why=$(printf '%s' "$err" | head -n 1 | sed -E 's# ?\(https?://[^)]*\)##g' | cut -c1-200)
  echo "::error title=Halo sign-in not saved::GitHub rejected SECRETS_PAT ($why). New games are still saved, but the Halo sign-in stops renewing and will eventually expire. Fix: create a fine-grained token (only this repository, Repository permissions > Secrets: Read and write) and save it as the SECRETS_PAT repository secret."
  health fail "GitHub rejected SECRETS_PAT ($why)."
fi
rm -f "$f"
exit 0
