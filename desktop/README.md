# Ember — desktop

Electron client for Ember. See the [root README](../README.md) for what Ember
is and [PROTOCOL.md](../PROTOCOL.md) for how it works on the wire.

## Run
```bash
npm install
npm start
```
Windows will ask for network access on first launch: allow **private and
public** networks, or the DHT can't hole-punch and you'll see 0 peers.

## Self-hosting
Ember can run with no window, under plain Node 20+ (no Electron), and be used
from any browser:
```bash
npm ci --omit=dev          # no Electron, no build tools
npm run serve              # = node src/main.js
```
It prints the node's key and an 8-digit **pairing code**. Open the address it
prints, enter the code, and that browser is paired (to pair another browser,
use SETUP › WEB ACCESS › NEW CODE in one that's already paired; the server also
prints each new code).

| option | default | |
|---|---|---|
| `--data DIR` | `~/.ember` | where the identity and data live (`EMBER_DATA`) |
| `--port N` | `7777` | (`EMBER_PORT`) |
| `--host H` | `127.0.0.1` | `0.0.0.0` to listen on every interface (`EMBER_HOST`) |
| `--allow-host NAME` | | extra host names to answer to, e.g. your domain behind a proxy (`EMBER_ALLOW_HOSTS`, comma-separated) |
| `--export-identity` | | print the primary key (back it up!) and exit |
| `--restore KEY` | | start an empty data folder as an existing identity; the log downloads from your followers |

The web interface speaks plain HTTP. On anything but localhost or your own
Wi-Fi, put it behind HTTPS, for example with Caddy:
```
ember.example.org {
  reverse_proxy 127.0.0.1:7777
}
```
and start Ember with `--allow-host ember.example.org`. Or reach it privately
over Tailscale/WireGuard. A systemd unit:
```ini
[Unit]
Description=Ember node
After=network-online.target
[Service]
WorkingDirectory=/opt/ember/desktop
ExecStart=/usr/bin/node src/main.js --data /var/lib/ember --allow-host ember.example.org
Restart=on-failure
User=ember
[Install]
WantedBy=multi-user.target
```
`journalctl -u ember` shows the pairing codes. One identity per data folder:
don't run the desktop app and a server on the same identity at the same time
unless the second is a restore you're migrating to.

On the desktop app, the same interface is in SETUP › WEB ACCESS: off by
default, localhost only unless you allow other devices on your network.

## Test
```bash
npm test                    # protocol (sanitizer, signatures, DM proof, deletes, nearby), taste (topics, compass, dial), campfires, web access
npm run test:nearby         # SAME AREA end to end over a private local DHT (three peers)
npx electron test/ui/run.js # UI suite: clicks through the real interface (82 cases)
```

## Build
```bash
npm run build         # on Windows → dist/Ember-Setup-<v>.exe (installer) + dist/Ember-<v>-portable.exe
npm run build-linux   # on Linux   → dist/Ember-<v>.AppImage + dist/ember_<v>_amd64.deb
```
The first build downloads Electron and packaging tools, so it takes a few
minutes. Output is roughly 100–230 MB, mostly Chromium and FFmpeg. Builds
bundle an `ffmpeg` binary (GPL-3.0) for video transcoding; its license and
`NOTICE.md` are copied next to the executable. See
[NOTICE.md](../NOTICE.md) before distributing binaries.

## Release
Bump `version` in `package.json`, commit, then tag it:
```bash
git tag v2.6.0
git push origin v2.6.0
```
GitHub Actions (`.github/workflows/release.yml`) runs the tests, builds the
Windows and Linux binaries, and attaches them with SHA-256 checksums to a
GitHub Release for that tag. The tag must match the `package.json` version.
To build without releasing, use **Actions → release → Run workflow** and
download the files from the run's artifacts.

## Layout
| file | role |
|---|---|
| `src/main.js` | the node: identity, feeds, swarms, gossip, DMs, IPC |
| `src/protocol.js` | **trust boundary**: sanitizer, signature formats, key cleaning, DM proof. Canonical copy shared with mobile |
| `src/discovery.js` | LSH embedding + bucket topics, nearby area grid (shared with mobile) |
| `src/nearby.js` | NEARBY: same-network beacons, same-area swarm, PC location → nearest town, town search |
| `src/taste.js` | topics (recognised in EN/FR/ZH/AR), the local compass, the FAMILIAR ↔ STRANGE dial, "why am I seeing this" |
| `src/topics.json` | the topic catalog: ids, labels and seed words in four languages |
| `src/fires.js` | CAMPFIRES: live rooms over gossip connections, signed, memory-only |
| `src/i18n/*.json` | interface translations (English is the source text) |
| `src/web.js` | WEB ACCESS: serves the interface to paired browsers (pairing, sessions, guards, events, uploads) |
| `src/web-shim.js` | `window.ember` for a browser: the preload API over HTTP + server-sent events |
| `src/headless.js` | stands in for Electron when Ember runs under plain Node (`npm run serve`) |
| `src/places.tsv` | offline town list for SAME AREA (GeoNames, CC BY 4.0; `tools/build-places.js`) |
| `src/dm.js` | E2E DM crypto (shared with mobile) |
| `src/preload.js` | the only API the page can call |
| `src/index.html` | the whole UI |

After editing `protocol.js`, `discovery.js` or `dm.js`, run
`node ../tools/sync-shared.js` so mobile gets the identical code.

## Translating
The interface is written in English; every other language is a dictionary in
`src/i18n/<lang>.json` keyed by the exact English string, plus a few regex
patterns for strings with numbers in them. Missing strings fall back to
English. To list what a dictionary is missing, run
`npx electron test/ui/i18n-collect.js fr` (or `zh`, `ar`): it walks through
every view with demo data and writes the untranslated strings to a file.
Adding a language also means adding it to `UI_LANGS` in `index.html`, to
`LANGS` in `taste.js`, and labels/seed words for it in `topics.json`.

## Storage model
Followers re-seed a sliding tail window (default 150 blocks) of each feed;
older blocks are cleared locally but stay fetchable from anyone still holding
them. Posts gossip a small thumbnail; full media loads on demand. Watching a
video caches it (LRU, 200 MB) and you seed it for others.
