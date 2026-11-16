"""One-time: exchange the code from the Microsoft sign-in redirect for a refresh token.

Usage:  python -m halo.bootstrap "<full redirect URL or just the code>"
Writes the refresh token to $REFRESH_TOKEN_OUT (the workflow stores it as a secret).
With no argument, prints the sign-in URL to open.
"""

import asyncio
import sys
import urllib.parse

from aiohttp import ClientSession
from spnkr.auth import oauth

from halo.auth import app_from_env, save_refresh_token


def extract_code(value: str) -> str:
    value = value.strip()
    if "code=" in value:
        query = urllib.parse.urlparse(value).query or value.split("?", 1)[-1]
        return urllib.parse.parse_qs(query)["code"][0]
    return value


async def main() -> None:
    app = app_from_env()
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print("Open this URL, sign in, then copy the URL you land on:")
        print(oauth.generate_authorization_url(app))
        return
    code = extract_code(sys.argv[1])
    async with ClientSession() as http:
        token = await oauth.request_oauth_token(http, code, app)
    save_refresh_token(token.refresh_token)
    print("Got a refresh token.")


if __name__ == "__main__":
    asyncio.run(main())
