# Changelog

## v2.9.0 — Ember in a browser, and self-hosted
- **Use Ember in a browser.** SETUP › WEB ACCESS serves the same interface to
  web browsers. Every browser pairs once with an 8-digit code (OPEN IN BROWSER
  pairs this computer's browser in one click). Paired browsers are listed in
  SETUP and can be signed out one by one. It's the same node and the same
  identity: the browser is a window onto it, not another account.
- **Phones on your Wi-Fi.** OTHER DEVICES ON MY NETWORK lets phones and laptops
  on the same network open it. The interface now fits a phone: one column,
  navigation at the bottom, an INBOX button.
- **Self-hosted.** `npm run serve` runs Ember with no window at all, under plain
  Node (no Electron needed: `npm ci --omit=dev`), on a home server, a Raspberry
  Pi or a VPS that stays online. It prints its key and a pairing code; you use it
  from any browser. Options: `--port`, `--host`, `--allow-host` (for a domain
  behind a reverse proxy), `--data`, `--export-identity` and `--restore <key>`.
  Because it's always on, a self-hosted node also keeps your posts and your
  friends' posts warm while your other devices sleep.
- **Built to be exposed carefully.** Localhost only by default. Pairing codes
  are single-use, 5 wrong codes lock pairing for 5 minutes, and sessions are
  HttpOnly + SameSite=Strict cookies stored hashed. Every request must name a
  host this node answers to (DNS-rebinding guard) and come from the page itself
  (Origin, JSON only), so other websites can't act through your browser. A
  browser can never export or restore the identity, or switch web access off.
  Videos picked in a browser are uploaded, transcoded on the node, then deleted.
  Live updates (new posts, replies, DMs, campfires) stream to the browser.
- Tests: 43 web checks (pairing, lockout, guards, CSRF, uploads, events, and that
  the browser API matches the window's), 82 UI cases (5 new), and an end-to-end
  run where a real browser uses a headless node that talks to a desktop node
  (posting, following, replies, encrypted DMs, a video upload, a phone pairing
  and being signed out, a hostile page trying to post through the browser).

## v2.8.1 — Discover fixes
- **No more phantom "NEW POSTS".** Turning the FAMILIAR ↔ STRANGE dial (or
  changing topics, or a blocklist refreshing) bumped the reload pill every
  time, with no post arriving. Profile edits, follows and video chunks from
  people you follow did the same on the Feed. The pill now counts only posts
  that really arrived, each once, and not ones already on screen.
- **Discover stays newest-first.** The dial now chooses *which* posts you see
  (the closest 40 % of what reached you, the closest 70 %, the furthest 70 %,
  the furthest 40 %), and inside that band the newest post is at the top. The
  Feed was already, and still is, the people you follow in the order they
  posted.
- **Discover is fast again.** It re-measured every cached post on each render:
  with a full cache (5,000 posts) that froze Ember for about 5 seconds,
  network included. Each post is now measured once, when it arrives: about
  20 ms per render.
- **Decoys cover campfires too.** Campfire presence was announced with your
  real topics only, which gave them away and defeated the decoy rooms. You now
  also sit silently at your decoy fires (relaying, never shown or speaking).
- Searching no longer piles up swarm topics: only the last few searches' buckets
  are kept. A bucket shared by two features can't be dropped by one of them.
- When another install of your identity writes (the old PC still running after
  a restore), this one now keeps a copy, so your own profile shows those posts.
- Tests: 174 taste checks (the dial bands, newest-first), 17 campfire checks
  (decoy fires), 77 UI cases (6 new for the reload pill).

## v2.8.0 — Topics, compass, campfires, four languages
- **Ember speaks French, Chinese and Arabic.** A language picker opens the
  first launch (and lives in SETUP): it sets the interface language *and* the
  languages you read. Arabic flips the whole interface right-to-left. Posts,
  names and messages are never translated or touched: they stay in the
  language they were written in, with their own text direction. Arabic and
  Chinese text gets a font that can shape it, everywhere in the app.
- **Topics.** New installs (and everyone upgrading from 2.7, once) pick what
  they're into from 24 topics, each named in all four languages, or say it in
  their own words. Each topic is a **room** on the network: you sit in it, and
  posts about it reach you. Posts are recognised as being about a topic in
  English, French, Chinese or Arabic, and travel into that room even if the
  author never picked it. Rooms can be empty at first; that's fine, they fill
  as people arrive. Change them any time in SETUP.
- **Decoy rooms.** Which rooms you sit in is visible to the network. Ember
  also sits in two extra rooms, picked by a secret that never leaves your
  machine, so nobody watching can tell which interests are really yours. They
  stay as steady as your real picks, so they can't be told apart over time.
- **Smaller commons faucet.** With topics picked, the global commons bucket
  becomes a trickle: joined only while you have fewer than 3 gossip peers.
  The SETUP switch now takes effect immediately in both directions.
- **Compass.** Discover learns what you like from what you post, reply to,
  repost and save (and what you mute or mark NOT INTERESTED). It fades over a
  few weeks, never leaves your machine, and SETUP shows it as words you can
  remove one by one, or reset. Your Feed is unchanged: the people you follow,
  in the order they posted.
- **FAMILIAR ↔ STRANGE.** A four-step dial on Discover: from posts closest to
  your compass to the far side of it. Further steps also sit you in more
  buckets around it.
- **Why am I seeing this?** Every Discover card says, in one line: a topic you
  picked, someone you follow, words it shares with your compass, close to
  your compass, from further out, or that it matched your search.
- **NOT INTERESTED** in a Discover card's ··· menu hides it and teaches the
  compass "less of this". ONLY POSTS I CAN READ hides scripts you don't read.
- **Circle moderation.** Blocking stays personal, and nothing is ever deleted
  or enforced on anyone else. Optionally:
  - **Share my blocklist:** your blocks are published as a signed list in your
    own log, for people who trust your judgement. Turning it off publishes an
    empty list.
  - **Subscribe** to someone's list (paste their key): everyone on it is hidden
    for you, including at campfires.
  - **Listen to my circle:** someone on the lists of two people you follow is
    hidden from your Discover; on one list, they're ranked down and marked.
    People you follow are never hidden.
  - **Fading:** what you muted, or what your lists hide, no longer travels
    *through* you. Ember has no central moderation; this is how a crowd's
    judgement slows something down instead.
- **Campfires** (new tab, ▲). When you and two others sit in the same topic
  room at the same moment, a live room lights up. Messages are signed, live
  only in memory, and disappear when the fire goes out. A toast tells you when
  one lights.
- **Restore fixed.** Restoring an identity on a fresh install used to start
  writing before the old history had downloaded, which forked the log: your
  followers then rejected everything new. Ember now downloads your history
  first. Until it arrives, posting is paused and a banner explains why (with
  IT NEVER POSTED · START NOW for identities that really never posted), and
  the pause survives a restart.
- **Nearby: no more ghosts.** When two people dialled each other at the same
  moment, one side could be left holding a dead connection: their "bye" (and
  later cards) never arrived, so they stayed listed after leaving. A
  connection that stays silent is now dropped (on Nearby, gossip and DMs),
  and Nearby looks the area up again at once to replace it.
- Tests: 167 taste checks (topics in four languages, compass, dial, why,
  modlist), 11 campfire checks, 78 protocol checks, 71 UI cases (19 new), and
  two end-to-end runs on a private DHT: three instances (rooms, campfires,
  cross-room posts, blocklist subscriptions, Arabic after reload) and an
  identity restore with the log's only holder offline, then back.

## v2.7.0 — Nearby
- **NEARBY** (new tab, ◌). Discover finds people near you in *meaning*; Nearby
  finds people near you in *space*. Both parts are opt-in and off by default.
  - **Same network:** see who runs Ember on the same Wi-Fi or LAN, within
    seconds. Ember sends a signed "I'm here" card on the local network only
    (multicast + broadcast, TTL 1). Works with no internet at all, so it's
    good for a classroom, a meetup or a café.
  - **Same area:** LOCATE ME asks the PC where it is (Windows Location; GeoClue
    on Linux when installed), snaps it to the nearest town in a bundled
    offline list (49k towns, GeoNames) and shares **only that town**. The
    exact position never leaves the computer, so distances can't be used to
    triangulate anyone. No location on this PC? Type your town instead. Pick a
    radius: 10, 25, 50 or 150 km. People who opted in nearby find each other
    through a grid of DHT topics, and the radius is enforced on town centres.
  - **Hide me from Nearby:** one switch, in the tab and in the tray menu,
    stops both channels at once and keeps your choices for later. A signed
    "bye" removes you from everyone's list immediately, instead of when your
    last card expires.
  - Every card is signed. A card signed with a key that isn't the person's
    published one is dropped as an impersonation; one from someone whose
    profile hasn't arrived yet is shown as UNCONFIRMED.
  - Follow, DM or open the profile of anyone nearby. A toast and a dot on the
    tab tell you when someone new appears.
  - Desktop only for now; the protocol is shared, so Android can join later.
- **Profile pages show names.** A stranger's own profile page listed their
  posts under a hex key (`bc2477fe`) instead of their name: cards only looked
  up names among the people you follow. Names now come from every profile the
  app has loaded.
- **Your story menu is no longer cut off.** Hovering your story tile opened
  SEE STORY / ADD STORY inside the scrolling story rail, which clipped it; the
  rest showed up at the bottom of the rail. It now opens fully beside the tile.
- New title-bar line: SERVERLESS · YOUR PEOPLE, NOT AN AUDIENCE.
- Tests: 78 protocol checks (23 new: card signatures and tampering, bye cards,
  the area grid finding every pair within the radius across 8,000 random
  pairs, the antimeridian), a three-peer SAME AREA run over a local DHT that
  also checks bye (`npm run test:nearby`), and 52 UI cases (13 new).

## v2.6.2 — Debian/Ubuntu package
- New `ember_<version>_amd64.deb` for Ubuntu/Debian: `sudo apt install ./ember_<version>_amd64.deb`.
  Installs to /opt/Ember with an `ember` command, app-menu entry and an
  AppArmor profile so Electron's sandbox works on Ubuntu 24.04+. No `libfuse2` needed.
  Thanks to @hasmeni for the first community contribution (#1).

## v2.6.1 — interaction fixes
- **Message requests: ACCEPT / IGNORE / ACCEPT + FOLLOW work again** (inbox
  rail and full DM view). The list was built by attaching click handlers to
  request rows and then appending the "CONVERSATIONS" header with
  `innerHTML +=`, which re-parses the whole list and silently drops every
  handler already attached. All 8 `innerHTML +=` sites now use
  `insertAdjacentHTML`, which leaves existing elements alone.
- **Image viewer.** Clicking a post image used to load the full image into the
  card, which crops it, so you never saw it whole. Images (posts and DMs) now
  open in a centered viewer: preview first, full image when a holder answers,
  click to zoom, Esc or click outside to close. Full images are cached.
- **Focus.** A reply notification takes you to that exact post, highlighted,
  with its thread open. Opening a conversation puts the cursor in the message
  box.
- Starting a DM accepts a key pasted with extra text around it.
- DM request previews show the message instead of the raw `{"k":"t",…}`
  envelope; the DM header no longer claims "online-only delivery".
- Mobile: posts and DM images open a full-screen viewer; opening a thread
  focuses the message box; stories and inbox show names and avatars.
- New: `npx electron test/ui/run.js`, 39 UI interaction tests that click
  through the real interface against a demo engine.

## v2.6 — security hardening, open-source release prep
**Upgrade every install (desktop and mobile) together: protocol v2.** v2.6
clients stop delivering queued DMs to older clients, and older clients
reject v2.6 announcements that carry media.

- **Fixed a wormable XSS in the renderer.** Profile avatars, post thumbnails
  and DM images from other peers were interpolated into `innerHTML` unescaped.
  A hostile avatar could run script with the full preload API: read every DM,
  post and DM as you, and set *your* avatar to the same payload so it spread
  to everyone who saw you. (It could not read your identity key: export goes
  through a native save dialog.) Fixed in three layers: every block read from
  any feed is reduced to a whitelisted shape (`protocol.js#sanitizeBlock`),
  every media `src` in the renderer passes a strict data-URL check, and a
  Content-Security-Policy blocks remote loads. Proven before/after in a DOM.
- **Removed 376 lines of JavaScript that were sitting inside the `<style>`
  block** (a patch had matched a comment that exists in both CSS and JS). It
  never ran, but CSS error recovery swallowed the real `.composeouter` rule,
  which is why compose retract/sizing misbehaved.
- **Announcement signatures v2** bind kind, quote/reply target, thumbnail and
  media pointers, not only the text. A relay can no longer attach a different
  image to your signed post. v1 signatures are still sent for old clients.
- **Signed deletes.** Tombstones gossiped to peers must be signed by the
  author's known key; before, anyone could purge anyone's posts from every
  cache they reached.
- **DM handshake proof.** `dmhello` carries a challenge the peer must sign
  with its identity key before it receives your queued outbox. Before, anyone
  sitting in a friend's inbox topic could claim to be them and silently
  swallow your queued messages (unreadable to them, but never delivered).
- Saved posts are re-broadcast with the author's original signatures, so
  copies kept warm stay verified.
- Window hardening: navigation and webviews blocked (a file dropped on the
  window used to replace the app), permissions limited to mic and
  notifications, explicit `contextIsolation`/`sandbox`.
- Gossip caches are bounded (5,000 posts, 5,000 reply threads × 500).
- `package.json` now declares Electron, electron-builder and sodium-universal
  (a fresh clone could not `npm start` before). `npm test` runs the protocol
  test suite.

## v2.5
- **FOLLOW no longer rejects valid keys.** Keys pasted from a phone (share
  sheet text, alert dialogs, chat apps) carried prefixes, newlines, uppercase
  or zero-width characters; the handler demanded a pristine 64-hex string and
  threw "invalid key". It now extracts the first 64-hex run from whatever it
  is handed (NFKC-normalised, zero-width stripped). Verified against clean,
  newline-suffixed, share-sheet-wrapped, uppercase, quoted, @-prefixed and
  zero-width-injected inputs; genuine garbage is still rejected.
- Follow errors now show the actual reason in the toast instead of a blanket
  INVALID KEY.
- **Network readout** now distinguishes connections from seeders:
  "N FEED PEERS · M SEEDING YOU", where seeders counts peers replicating YOUR
  core — the number that actually answers "is anyone holding my posts".

## v2.4 — feed restructure
Card layout rebuilt toward the Claude Design direction while keeping the
Ember soul: sectioned cards (header / body / full-bleed media / action row
divided by real borders) floating on the canvas with hard shadows and a
hover lift; circular avatars (feed + stories); status as swatch+label; an
··· overflow menu holding DM / profile / copy key / mute / block / delete
(the action row is now three chips + the save square isolated right, ◇/◆);
— TODAY — / — YESTERDAY — day separators; compose bar as a chip row
(IMAGE · VIDEO · STORY · md toolbar · count) with POST solid on the right.

## v2.3
**Themes reworked** (per contrast rules: saturated color as ink causes
halation — dark themes now use near-neutral low-chroma-tinted ink, the hue
lives in accent + dimmed lines). Seven palettes, every text tier verified:
PAPER · SEPIA · MIST (light) / CARBON · SLATE · PHOSPHOR · EMBER (dark);
ink 13–21:1, muted 6.5–7.8:1, soft 5–6.3:1. Search bar collapses on views
without a feed.

**Distribution upgrades**
- **Signed announcements**: every gossip announcement now carries an ed25519
  signature over (author, seq, ts, sha256(text)). Invalid or key-mismatched
  signatures are dropped at ingress; unknown authors are TOFU-pinned; trust
  level travels with the cache. Gossip spoofing is dead. Verified: valid
  passes, tampered text and wrong-key both rejected.
- **Multi-probe LSH**: queries now probe the 1-bit-flip hamming neighbors of
  their codes (up to 24 topics) — near-miss content one bucket away becomes
  findable without extra tables. Straight from the SDHT playbook.
- **Stopword-weighted embeddings** (EN+FR): function words downweighted 85%;
  'la recette de la cuisine algerienne' ≈ 'recette cuisine algerienne' at
  0.76 cosine (was polluted before).
- **Blended discover ranking**: 0.78·cosine + 0.22·recency(3-day decay) —
  relevance first, but fresh content isn't buried by stale near-matches.
- **Auto-commons**: with ≥10 gossip peers the client leaves the global
  rendezvous automatically (pure proximity space); rejoins below 4. The
  network weans itself off the training wheels as it grows.

## v2.2
- **Story-vanish fixed**: the stories scanner had the last remaining
  break-on-error — one cleared block killed the scan and your story
  disappeared. Now hole-tolerant (has() + continue); verified across
  repeated scans over a holed log. Grep confirms no break-on-error
  patterns remain anywhere.
- **Story rail**: your tile is always first — with active stories it shows
  your avatar and a hover menu (▶ SEE STORY / + ADD STORY); without, the +
  tile. Others' stories flow in below as they arrive.
- **Native menu bar removed** (File/Edit/View is gone).
- **Ember titlebar**: frameless window with a custom bar — diamond+EMBER
  (click = feed), centered motto, and ─ ▢ ✕ on the right in the design
  system (✕ hides to tray, accent on hover). Full drag region.

## v2.1.1 (hotfix)
- **Boot hang fixed**: the follows-rebuild scan read every block of your own
  core with NO timeout; a cleared (deleted) block made it wait forever —
  Hyperswarm had already started (hence the firewall prompt) but the window
  was created only after the engine, so: nothing. The scan now skips holes
  via core.has() with a short timeout (verified over a holed core: <50ms).
- **Boot order inverted**: the window now appears FIRST with a "joining the
  swarm" status; the engine boots behind it and announces readiness. Engine
  failures show an error dialog instead of dying silently. All early IPC
  calls return safe defaults until the engine is up.

## v2.1 — critical fixes
- **Delete cascade bug FIXED**: deleting posts cleared blocks that readers
  then stalled on (4s timeouts → feed flicker), and `latestProfile` gave up
  at the first cleared block → name/PFP "vanished"; a restart then wrote a
  dmKey-only profile block that buried them. Fixes: tombstone-aware backward
  scan skips deleted seqs without touching them; `core.has()` guards mean
  cleared blocks are never waited on; the profile reader now MERGES backward
  so fields buried under partial profile blocks are recovered automatically
  — your name and avatar come back on their own. Regression test in repo
  history: exact scenario passes in 2ms.
- delete-post now refuses to tombstone anything but post/quote/repost.
- **App icon**: the diamond mark as a proper .ico/.png (window + installer +
  exe), matching the tray.
- **Rate limiting**: per-socket token buckets (burst 60, 20 msg/s) on gossip
  and DM ingress; persistent flooders are disconnected.
- **Onboarding**: first-launch flow — what Ember is, name/PFP/status, the
  no-recovery key warning with backup export, then enter the swarm.

## v2.0
- **ffmpeg baked in** (ffmpeg-static, asar-unpacked in builds): any input
  video, any size, transcoded in the main process to 720p H.264 CRF-28 mp4
  with faststart, live progress in the compose bar. All size restrictions
  lifted (posts, images, video).
- **Ember video player**: popup centered player with custom minimal controls
  — play square, thin seek bar with knob (pointer-scrub), time, mute, Esc /
  space / click-outside. No native chrome.
- **Video thumbnail fixed**: was generated at 480px (~25KB) but capped at
  8KB and silently dropped; now 300px with quality step-down under a 20KB
  gossip cap.
- Clickable https links in posts (open in the system browser, window-open
  denied in-app); START WITH SYSTEM autostart toggle (seed from login);
  feed pagination (LOAD OLDER).

## v1.9
- **Video, with watch-to-seed distribution**: videos (<=8MB mp4/webm) are
  chunked into the author's core; a post carries videoMeta + a first-frame
  thumbnail through gossip. Watching fetches chunks from ANY holder — and by
  Hypercore replication the watcher immediately seeds them onward. Verified
  headless with three peers: author posts, B watches, author goes offline,
  C streams the full video from B.
- **Warm cache (watched != saved)**: watched ranges are protected from tail
  eviction and re-seeded across restarts (watched cores reopen at boot), but
  live under a 200MB LRU byte budget — oldest watched media evaporates first.
  If everyone who watched evicts or leaves, the video is gone until the
  author returns. Stats in SETUP.
- **Minimalist voice player**: play square + 32-bar waveform (decoded peaks)
  + duration; click the bars to seek. No native media chrome.
- **Expand fix**: opening the full inbox view hides the right rail entirely.

## v1.8
- **Phone-style DM rail (350px)**: navigate contacts and full conversations
  entirely inside the right rail — back button to contacts, ⤢ expand jumps to
  the full-panel view (contacts left, thread right). Clicking a conversation
  no longer hijacks the main panel.
- **DM media & voice**: images (client-compressed) and voice notes
  (webm/opus, 60s cap) travel inside the same E2E crypto_box as text via a
  tiny JSON envelope — verified with a 150KB payload roundtrip. Previews show
  "◲ image" / "● voice message" in lists.
- **Delete posts**: a tombstone block hides the post on every replica, the
  author (and replicas) clear() the data locally, and a gossiped del message
  purges cached announcements. Saved copies are the only survivors — by design.
  Verified headless: tombstoned block filtered and unavailable.
- **Basic rich text**: **bold** *italic* ~~strike~~ `code` — markdown subset,
  plain text on the wire (old clients degrade gracefully), markers stripped
  before discovery embedding. Toolbar wraps the selection.
- **Compose fix**: + NEW POST no longer re-renders the feed — the rectangle
  just slides down.

## v1.7
- **Inbox rail**: the right side is a permanent, scrollable INBOX — requests
  and conversations always visible, collapsible to a 44px strip (✉ + unread
  pulse). Clicking a conversation opens the full thread view.
- **Ledger nav**: the left rail rests at 52px icons and slides open on hover
  to reveal tab names.
- **Compose rebuilt**: a contained rectangle spanning the feed column edge to
  edge, hard-shadowed; retracts gracefully on scroll and drops back down via
  + NEW POST (or scrolling back to top).
- **Story text editor**: Instagram-style — add text, drag to place, resize,
  recolor; text is baked into the image on canvas before posting, so it
  travels as a plain image through the existing media path.
- Rich text / font options for posts: parked deliberately — it changes the
  announcement wire format, so it gets its own release.

## v1.6
- **Quote posts**: third sharing primitive alongside repost/reply — your text
  above an embedded, live-resolved original (works through gossip too).
- **Stories**: 24h ephemeral image blocks in your own core; left rail with
  accent-ringed avatars, tap-through viewer (6s auto-advance, arrows, Esc).
  Storage-true: stories load on demand from holders like all media.
- **Identity backup/restore**: export the corestore primary key to a guarded
  file; restore onto a fresh install reproduces your exact identity (verified).
- **Block & mute**: block drops a key from gossip, DMs, timeline, and discover
  and purges their cached announcements; mute hides them from your views only.
  Managed from profiles, reviewable in SETUP.
- **Tray**: closing the window hides to tray — the node keeps replicating,
  gossiping, and delivering while "closed". Quit from the tray to go offline.
- **System notifications** for DMs/replies/posts when the window is unfocused
  or hidden; clicking one raises the window.
- **Offline DMs (Phantom-style)**: messages to offline contacts queue in a
  persistent outbox; DM connections exchange identity hellos and flush queued
  mail with dedup IDs the moment both ends are online. Bubbles show QUEUED
  until delivery.
- **Layout**: icon-only nav rail (52px), stories rail, right panel removed —
  the feed gets the space. Follow-by-key lives in a topbar popover; profile
  editing lives on your profile page; your PFP now fills the top-right square.

## UI v2
- **Theme system rebuilt** on semantic tokens (--ink/--muted/--soft/--paper…):
  four palettes (PAPER, CARBON, PHOSPHOR, AMBER), each designed as desaturated
  tonal variants — never inverted — and contrast-verified (body text >= 4.5:1).
- **Motion system**: 180ms ease-out entrances with 35ms stagger, press-scale
  feedback, animated switches/pill/toast; prefers-reduced-motion respected.
- **Notification center** (NOTIFS): replies to your posts, DMs, and new posts
  from follows. Pulsing accent dots on FEED / INBOX / NOTIFS for unread.
- **DM message requests**: strangers land in a request pool (accept / accept+
  follow / ignore); mutuals and accepted contacts chat directly. Stranger key
  fetch now waits for the feed swarm, fixing DMs between non-followers.
- Full-quality image preview (with remove) before posting; PFP updates the
  moment a picture is chosen; replies now work on profile pages (threads are
  scoped per card, no duplicate-id collisions).

## Sync & the calm feed
- **Delta resync on reconnect**: gossip hellos carry a `since` watermark; a
  reconnecting peer receives only the announcements it missed (bounded at
  200), plus each peer's own recent posts regardless of watermark. Followed
  feeds already resync via Hypercore replication the moment a holder appears.
- **Periodic re-announce**: every 4 minutes your recent posts are re-offered
  to current bucket peers, so late joiners catch up without any action.
- **Reload pill**: incoming posts buffer silently behind a "N NEW — RELOAD"
  pill (feed and discover both). Nothing moves until you ask. Your own posts
  and the initial sync still render immediately.

## DMs
E2E encrypted direct messages: Ed25519 feed keys → Curve25519, sealed with
crypto_box (authenticated — successful decryption is sender proof; spoofed
sender claims fail to open). Reachability via per-identity inbox topics.
Delivery is **online-only and ephemeral by design**: no store-and-forward,
no relay servers, history kept locally only (disable in SETUP for
close-the-app-and-it's-gone). Routing metadata (from/to) is visible only to
the two endpoints — the transport itself is Noise-encrypted by Hyperswarm.

## Saved posts
Saving makes a permanent local copy — exempt from tail-window eviction —
with the author's tag attached, and **you become a broadcaster for it**:
saved posts are shared on every gossip handshake, so the content stays warm
through you even when the author is gone. Save = keeping the ember lit.

## Settings (SETUP tab)
dark mode · commons bucket toggle · DM history toggle · re-seed tail window
dial · storage usage / cache clear · key backup reminder.

## Discovery v2
- word + prefix-stem + bigram + char-n-gram feature hashing (works across
  French/English morphology: traditionnelle ≈ traditionnels)
- a **commons bucket** every client joins: at small network scale everyone
  meets there, so feeds populate without searching; LSH buckets add the
  proximity layer on top. Large-scale clients can drop the commons (V2).
