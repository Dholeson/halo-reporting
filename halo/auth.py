"""Token chain: Microsoft refresh token -> Xbox -> XSTS -> Halo Spartan token.

spnkr's refresh_player_tokens() throws away the rotated refresh token, so we
drive the chain ourselves and hand the new refresh token back to the caller.
"""

import os
from dataclasses import dataclass

from aiohttp import ClientSession
from spnkr.auth import AzureApp
from spnkr.auth import halo, oauth, xbox
from spnkr.auth.core import XSTS_V3_HALO_AUDIENCE, XSTS_V3_XBOX_AUDIENCE


@dataclass(frozen=True)
class Session:
    xuid: str
    gamertag: str
    spartan_token: str
    clearance_token: str
    new_refresh_token: str
    xbl_auth: str = ""  # "XBL3.0 x=<uhs>;<token>" for Xbox Live services (presence); never print it


def app_from_env() -> AzureApp:
    missing = [k for k in ("AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET") if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"Missing repo secret(s): {', '.join(missing)}. Add them under Settings -> Secrets -> Actions.")
    return AzureApp(
        client_id=os.environ["AZURE_CLIENT_ID"],
        client_secret=os.environ["AZURE_CLIENT_SECRET"],
        redirect_uri=os.environ.get("AZURE_REDIRECT_URI", "https://localhost"),
    )


async def sign_in(http: ClientSession, app: AzureApp, refresh_token: str) -> Session:
    token = await oauth.refresh_oauth_token(http, refresh_token, app)
    user = await xbox.request_user_token(http, token.access_token)
    xsts = await xbox.request_xsts_token(http, user.token, XSTS_V3_XBOX_AUDIENCE)
    halo_xsts = await xbox.request_xsts_token(http, user.token, XSTS_V3_HALO_AUDIENCE)
    spartan = await halo.request_spartan_token(http, halo_xsts.token)
    clearance = await halo.request_clearance_token(http, spartan.token)
    return Session(
        xuid=xsts.xuid,
        gamertag=xsts.gamertag,
        spartan_token=spartan.token,
        clearance_token=clearance.token,
        new_refresh_token=token.refresh_token,
        xbl_auth=xsts.authorization_header_value,
    )


def save_refresh_token(token: str) -> None:
    """Write the rotated token where the workflow can pick it up. Never print it."""
    path = os.environ.get("REFRESH_TOKEN_OUT")
    if not path:
        return
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::add-mask::{token}")
    with open(path, "w") as f:
        f.write(token)
