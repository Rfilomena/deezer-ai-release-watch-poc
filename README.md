# Deezer AI Release Watch POC

Small standalone proof-of-concept for checking whether Deezer exposes AI-generated labels in public metadata for competitor albums.

## Run

```bash
cp .env.example .env
# fill in Spotify credentials for Spotify album/artist modes
node server.js
```

Open `http://localhost:5057`.

## Modes

- **Manual Deezer Probe**: paste rows like `Artist | Album | UPC`. Spotify credentials are not needed.
- **Spotify Albums**: paste Spotify album links or IDs. Requires `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
- **Spotify Artists**: paste Spotify artist links or IDs. The POC fetches recent albums/singles, then checks Deezer. Requires Spotify credentials.

## What It Proves

The app searches Deezer by UPC first, then track ISRCs, then album/title matching. It inspects Deezer album, track, and artist metadata for AI-related fields or values.

Useful outcomes:

- `AI indicator found`: Deezer metadata exposes an AI-related signal.
- `No AI indicator exposed`: Deezer matched the release, but public metadata did not expose an AI signal.
- `No Deezer match`: the release could not be matched in Deezer.

This intentionally avoids Spotify audio and does not send Spotify previews into any AI service.
