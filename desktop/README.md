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

## Test
```bash
npm test                    # protocol (sanitizer, signatures, DM proof, deletes, nearby), taste (topics, compass, dial), campfires
npm run test:nearby         # SAME AREA end to end over a private local DHT (three peers)
npx electron test/ui/run.js # UI suite: clicks through the real interface (71 cases)
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
