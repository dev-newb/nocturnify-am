<img src="docs/brand/banner.png" alt="Nocturnify AM" width="320">

# Nocturnify AM

Lightweight Apple Music for Android TV — the Apple Music sibling of [Nocturnify](https://github.com/dev-newb/nocturnify),
with a visualiser that reacts to the music itself.

A thin Kotlin shell around one WebView. The UI is plain HTML/JS driven by the D-pad; playback is
Apple's [MusicKit JS v3](https://js-cdn.music.apple.com/musickit/v3/docs/index.html) (full tracks for
Apple Music subscribers), browsing is the Apple Music API.

## What's in it

- **For You** (recently played, Apple's recommendations, heavy rotation), **Playlists**, **Albums**,
  **Songs** — the library, newest first
- **Radio** — live stations (Apple Music 1, Hits, Country, Club, Chill, Música Uno), your personal
  station, recently played stations, and a station built from whatever is playing
- **Charts**, **Search** (catalog + your library), **Up Next** (jump anywhere in the queue; love,
  add to library, start a station)
- Shuffle that works on any queue; **Autoplay** keeps similar music going when the queue ends
- **Gapless** (off by default) for albums that run one track into the next — see Notes
- Album and playlist blurbs from Apple's editorial notes
- Remote: colour buttons, where the remote has them — red ♥ love, green add to library,
  yellow station from this song, blue next visualiser mode; number keys 1 / 3 turn the
  visualiser's intensity down / up
- Background audio with a MediaSession, so the TV's media keys and notification work

## The visualiser

15 modes plus **Auto**, which cross-fades through all of them (the default). ▲ ▼ change mode,
◀ ▶ change track, OK plays/pauses, 1 / 3 set the intensity (1–5, default 3: how hard the music
pushes the picture). It opens on its own after a minute of idle playback.

It's audio-reactive from the real signal. Web Audio can't hear MusicKit — Widevine-protected media
reaches page script as silence — so the native shell reads the TV's output mix with Android's
`Visualizer` (`AudioTap.kt`) and streams 24 spectrum bands + a waveform to the page at 60 Hz.
`viz.js` turns that into bass / mid / treble, loudness, and beat onsets, and every mode uses them
its own way. Halo (a spectrum ring) and Scope (a waveform ring) exist only with a signal. With no
signal — paused, or the permission declined — every mode eases back to its ambient self.

Android gates output capture behind the **record audio** permission, asked the first time the
visualiser opens. The microphone is never opened.

Measured on a Bravia (Android 12): 60 fps, p50 8 ms, 0–0.1% janky frames with the tap running.

## Setup

1. An Apple Developer Program membership and an Apple Music subscription.
2. developer.apple.com → Identifiers → **Media IDs** (MusicKit enabled), then Keys → a key with
   **Media Services** configured for that Media ID. Download the `.p8` (once only) and keep it out
   of the repo, e.g. `~/.config/nocturnify-am/`.
3. Mint the developer token (ES256 JWT, max 6 months) into the gitignored `assets/config.js`:

   ```bash
   node tools/make-token.mjs --key ~/.config/nocturnify-am/AuthKey_KEYID.p8 --team TEAMID
   ```

4. Build and install:

   ```bash
   ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

5. On the TV: Sign in to Apple Music → Apple's own sign-in page opens inside the app.

The token expires after six months; the app says so on screen. Re-run step 3 and reinstall.

## Notes

- `applicationId` is `dev.rich.applemusictv`, separate from Nocturnify's, so both install side by side.
- Sign-in: MusicKit's `authorize()` opens a window and waits for a `postMessage` from it.
  WebView drops `window.open` unless the host provides the window, so `MainActivity` stacks a child
  WebView for it (`onCreateWindow`) and closes it on `window.close()`.
- The UA is desktop Chrome: MusicKit treats Android specially (native controls, no video) and the
  desktop path is the one that works here.
- Gapless is MusicKit's *seamless audio transitions*: the next song, and its DRM key, are fed
  to the decoder that's already playing. On the Bravia that switch sometimes leaves Android's AAC
  decoder reading garbage (`AAC decoder returned error 0x4004, substituting silence` in logcat,
  ~12 a second) until something restarts it — dropouts and crackle through whole tracks. So it's
  off by default and every song gets a fresh decoder, with a short gap between tracks. The sidebar
  toggle applies immediately and is remembered.
- Debug builds enable WebView remote debugging (reachable only over adb).
