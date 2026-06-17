# Spotify Playlist AI Label Check POC

Small standalone proof-of-concept for checking whether Deezer exposes AI-generated labels in public metadata for songs on a Spotify playlist.

## Run

```bash
cp .env.example .env
# fill in Spotify credentials
node server.js
```

Open `http://localhost:5057`.

## Replit Setup

Add these Secrets:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI`

Set `SPOTIFY_REDIRECT_URI` to your deployed Replit callback URL:

```text
https://your-replit-domain/auth/spotify/callback
```

Add the same callback URL in the Spotify developer dashboard for your app.

## What It Does

1. Paste a Spotify playlist URI, playlist URL, or playlist ID.
2. Sign in with Spotify if playlist access requires it.
3. Fetch playlist tracks and each track's ISRC metadata.
4. Match each Spotify track to Deezer by ISRC first, then title/artist search.
5. Inspect Deezer track, album, and artist metadata for AI-related fields or values.
6. Show a track-by-track table with `AI`, `No AI label found`, or `Unknown`.

## Important Caveat

`No AI label found` means Deezer matched the track but did not expose a public AI-label field in the metadata this app can read. It does not prove the song is human-made.

This intentionally avoids Spotify audio and does not send Spotify previews into any AI service.
