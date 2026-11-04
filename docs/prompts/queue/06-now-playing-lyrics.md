# Queue 06 — Now playing and lyrics (mini music player)

Recommended: Opus, effort high. Run npm/tauri from Windows PowerShell, not WSL.

DECISIONS (from Bas): a read-only mini player: what is playing and the lyrics.
No pause/play controls. It should feel like a small music player.

APPROACH (verify, do not assume): read what is playing from Windows itself, not
from the Spotify API. Windows exposes system media sessions
(`GlobalSystemMediaTransportControlsSessionManager`, a.k.a. SMTC) with title,
artist, album, thumbnail, playback status and timeline position, for Spotify
desktop and for browsers alike, with no login. Lyrics come from LRCLIB
(lrclib.net), a free community lyrics database that returns time-synced lyrics
by track, artist and duration. Check the current LRCLIB API documentation and
terms and cite them in the report; if either approach is not viable, say so
and propose the closest alternative instead of forcing it.

## Rules
1. Read docs/ARCHITECTURE.md, the HTTP layer, the Home page, the pet window,
   settings and Telegram handler first.
2. New numbered migration(s) only; check the latest number first.
3. i18n en + id, plain copy, no game wording. Do not git commit or push.
4. tsc, build, test, cargo check green. You cannot play music or reach LRCLIB
   from here: unit-test the logic with fixtures and mocked HTTP, and say what was
   not tested live.
5. Only the title, artist and duration of the current track are sent to LRCLIB,
   nothing else, and only when lyrics are enabled.

## Tasks
1. **Now-playing source (Rust).** Use the `windows` crate to read the current
   media session: title, artist, album, thumbnail (resize/encode small), status
   (playing/paused/stopped), duration and position. Subscribe to the session
   events (media properties, playback info, timeline) and emit a Tauri event
   `nowplaying:state` to the frontend. Extrapolate the position between updates
   with a timer so progress and lyrics stay smooth, and correct on every real
   update. Handle: no session, session switches, seeking, a source with no
   timeline. If one app is not the main player, prefer the session Windows
   marks as current.
2. **Lyrics.** Rust command `lyrics_get(title, artist, album?, durationSec)`
   that queries LRCLIB with a polite User-Agent (`Nox/<version>`), timeout 10 s,
   falls back to a plain search when the exact match fails, and returns
   synced lyrics when present, otherwise plain lyrics, otherwise "none".
   Cache results in a new table `lyrics_cache` (key from artist+title+duration,
   lyrics text, kind synced/plain/none, fetched_at); negative results are cached
   for 7 days; never refetch per play. Parse LRC (multiple timestamps per line,
   offsets, blank lines) in a pure TS module with tests.
3. **Mini player UI.**
   - Home card "Now playing": album art, title, artist, a progress bar with
     times, and lyrics as three lines (previous, CURRENT highlighted, next)
     that follow the position; plain lyrics scroll without highlight; a quiet
     "No lyrics found" state. Nothing playing: the card collapses to a one-line
     hint or hides.
   - A compact strip in the pet window (title, artist, current lyric line),
     OFF by default, switchable in Settings, never blocking the pet's dialog.
   - Keep the Night Lair look exactly (tokens.css). No playback controls.
4. **Settings.** `nowplaying_enabled` (default on), `lyrics_enabled` (default
   on), `lyrics_offset_ms` (default 0, adjustable +/- in steps with a live
   preview, because lyrics are often off by a fraction of a second),
   `nowplaying_in_pet` (default off).
5. **Focus friendliness.** During a pomodoro focus session the pet strip is
   hidden and nothing pops up; the Home card still updates.
6. **Telegram and commands.** `/lagu` replies with the current track (title,
   artist, status). No lyrics over Telegram.
7. Update docs/ARCHITECTURE.md and note the privacy behaviour (what is sent to
   LRCLIB).

## Out of scope
Playback control, Spotify Web API, accounts/login, saving a listening history,
downloading audio or album art from the web, translating lyrics.

## Manual checklist for Bas (put it in the report)
1. Play a song in Spotify desktop: the Home card shows art, title, artist and a
   moving progress bar.
2. A song with synced lyrics highlights the right line; adjust the offset until
   it feels in time.
3. A song without lyrics shows the quiet empty state; a podcast or video in the
   browser does not crash anything.
4. Pause, skip, seek: the card follows within a second.
5. Turn lyrics off: no request to LRCLIB is made.
6. Enable the strip in the pet window; start a focus session and confirm it hides.
7. `/lagu` from Telegram shows the current track.
