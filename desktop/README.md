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
npm test     # protocol hardening suite: sanitizer, signatures, DM proof, deletes
```

## Build
```bash
npm run build         # on Windows → dist/Ember-Setup-<v>.exe (installer) + dist/Ember-<v>-portable.exe
npm run build-linux   # on Linux   → dist/Ember-<v>.AppImage
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
| `src/discovery.js` | LSH embedding + bucket topics (shared with mobile) |
| `src/dm.js` | E2E DM crypto (shared with mobile) |
| `src/preload.js` | the only API the page can call |
| `src/index.html` | the whole UI |

After editing `protocol.js`, `discovery.js` or `dm.js`, run
`node ../tools/sync-shared.js` so mobile gets the identical code.

## Storage model
Followers re-seed a sliding tail window (default 150 blocks) of each feed;
older blocks are cleared locally but stay fetchable from anyone still holding
them. Posts gossip a small thumbnail; full media loads on demand. Watching a
video caches it (LRU, 200 MB) and you seed it for others.
