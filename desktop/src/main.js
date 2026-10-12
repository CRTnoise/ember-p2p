// EMBER — main process (also runs headless under plain Node: `npm run serve`)
// Two network layers:
//   1. FEED layer   — Corestore + Hyperswarm: signed append-only logs, replication, re-seeding.
//   2. GOSSIP layer — a second Hyperswarm whose topics come from LSH codes (discovery)
//                     and per-post rendezvous hashes (replies). Connections exchange
//                     newline-delimited JSON announcements.
// Electron when there is one; otherwise headless.js stands in (no window, no
// tray, no dialogs) and people use Ember through the web interface (web.js)
const HEADLESS = !process.versions.electron
const host = HEADLESS ? require('./headless') : require('electron')
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog } = host
Menu.setApplicationMenu(null)
const { Web } = require('./web')
// every IPC handler is registered here once, for the window (ipcMain) and for
// browsers (web.js calls the same functions)
const HANDLERS = new Map()
function handle (ch, fn) { HANDLERS.set(ch, fn); ipcMain.handle(ch, fn) }
let web = null
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const disc = require('./discovery')
const { spawn } = require('child_process')
const os = require('os')
// packaged apps: ffmpeg binary lives outside the asar archive
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
const dm = require('./dm')
const P = require('./protocol')
const { Nearby, searchPlaces, locateTown } = require('./nearby')
const taste = require('./taste')
const { Fires } = require('./fires')
const sodium = require('sodium-universal')

function signMsg (str) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, b4a.from(str), myCore.keyPair.secretKey)
  return b4a.toString(sig, 'base64')
}
function verifyMsg (str, sigB64, edpkHex) {
  try { return sodium.crypto_sign_verify_detached(b4a.from(sigB64, 'base64'), b4a.from(str), b4a.from(edpkHex, 'hex')) } catch { return false }
}
function signAnn (a) { return signMsg(P.annMsgV1(a)) }
function verifyAnn (a) {
  if (!a.sig || !a.edpk || !/^[0-9a-f]{64}$/.test(a.edpk)) return 'unsigned'
  try {
    if (typeof a.sig !== 'string' || !verifyMsg(P.annMsgV1(a), a.sig, a.edpk)) return 'forged'
    const known = peerEdPk.get(a.author)
    if (known) return known === a.edpk ? 'verified' : 'forged' // signed with a key that isn't the author's published one
    return 'tofu' // consistent keypair, author's published key not yet known
  } catch { return 'forged' }
}
const crypto = require('crypto')

// TEST ONLY: EMBER_TEST_BOOTSTRAP=host:port[,host:port] points every swarm at a
// private DHT (e.g. hyperdht/testnet) so instances can be tested together
// offline. Unset in normal use: the public HyperDHT bootstrap nodes are used.
function swarmOpts () {
  const bs = process.env.EMBER_TEST_BOOTSTRAP
  if (!bs) return {}
  const DHT = require('hyperdht')
  const bootstrap = bs.split(',').map(x => { const [host, port] = x.split(':'); return { host, port: +port } })
  return { dht: new DHT({ bootstrap, host: process.env.EMBER_TEST_DHT_HOST || undefined }) }
}

let win, store, feedSwarm, gossipSwarm, myCore, dataDir
const feeds = new Map()       // hexKey -> hypercore
const follows = new Set()
const gossipTopics = new Map() // hexTopic -> { kind: 'disc'|'reply', refCount }
const gossipPeers = new Set()  // sockets on gossip swarm
const discovered = new Map()   // id(author:seq) -> announcement {author,seq,ts,text,kind,ref}
const replies = new Map()      // id(author:seq) -> Map(replyId -> announcement)
let myInterests = []
let myCurve = null            // curve25519 keys derived from feed signer keypair
let myEdPk = null             // hex of the ed25519 signer pk (published in profile; used for DMs)
const peerEdPk = new Map()    // author core key -> their published DM (signer) pk
const dmSockets = new Set()   // sockets on dm swarm
const dmConvos = new Map()    // peerHexKey -> [{from,to,text,ts}]
const saved = new Map()       // id(author:seq) -> saved announcement (permanent, re-broadcast)
let dmSwarm = null
let SETTINGS = {
  theme: 'paper', tailWindow: 150, commons: true, keepDmHistory: true, nearLan: false, nearArea: null, nearHidden: false,
  // v2.8: taste, languages, circle moderation, campfires
  onboarded: false, uiLang: null, readLangs: null, topics: [], topicText: '', dial: 1, onlyMyLangs: false,
  publishBlocklist: false, modSubs: [], circleSignals: true, campfires: true, decoySeed: null,
  // v2.9: the interface in a browser (desktop; the headless server is always on)
  web: { on: false, lan: false, port: 7777 }
}
let nearby = null              // proximity in space (nearby.js); both channels opt-in
let tasteStore = null          // taste.js: the compass, kept on this machine only
let fires = null               // fires.js: campfires (live rooms, memory only)
const notInterested = new Set() // post ids marked "not interested"
let listHidden = new Set()     // authors on a blocklist I subscribed to: hidden
let circleHidden = new Set()   // authors on 2+ lists of people I follow: hidden
let circleSoft = new Set()     // authors on 1 list of someone I follow: ranked down
let commonsJoined = false
const roomsJoined = new Map()  // hexTopic -> topic buf: topic rooms, decoys, compass buckets
const postRooms = new Set()    // topic rooms joined because I posted about that topic
const discJoined = new Set()   // LSH buckets joined from what I and the people I follow write
let myName = ''
const notifs = []             // {id,type:'reply'|'dm'|'post',from,ts,text,ref,read}
const dmAccepted = new Set()  // keys whose message requests were accepted
const blocked = new Set()     // dropped everywhere: gossip, dms, timeline, discover
const muted = new Set()       // hidden from timeline/discover UI only
const dmOutbox = []           // queued {to, payload, localTs} awaiting the recipient to appear
const dmSeen = new Map()      // sender -> Set(message ids) for outbox-redelivery dedupe
const watched = new Map()     // authorKey -> [{start,end,bytes,ts}] warm-cached (seeded, not saved) media ranges
const WATCH_BUDGET = 200 * 1048576  // 200MB warm cache; oldest watched ranges evaporate first
let tray = null
let quitting = false
let engineUp = false           // recent embeddings of what I write/read (drives which buckets I sit in)

const hex = (buf) => b4a.toString(buf, 'hex')
const postId = (a, s) => `${a}:${s}`

// ---------- persistence for discovered content ----------

function settingsPath () { return path.join(dataDir, 'settings.json') }
function loadSettings () {
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    if (j.dark === true && !j.theme) j.theme = 'carbon'
    if (j.theme === 'amber') j.theme = 'ember'
    delete j.dark
    Object.assign(SETTINGS, j)
  } catch {}
  const ids = new Set(taste.CATALOG.map(t => t.id))
  if (!Array.isArray(SETTINGS.topics)) SETTINGS.topics = []
  SETTINGS.topics = SETTINGS.topics.filter(id => ids.has(id)).slice(0, 12)
  if (!Array.isArray(SETTINGS.modSubs)) SETTINGS.modSubs = []
  SETTINGS.modSubs = SETTINGS.modSubs.filter(x => x && P.HEX64.test(x.key || '')).slice(0, 20)
  if (!Number.isInteger(SETTINGS.dial) || SETTINGS.dial < 0 || SETTINGS.dial > 3) SETTINGS.dial = 1
  if (!taste.LANGS.includes(SETTINGS.uiLang)) SETTINGS.uiLang = null
  if (SETTINGS.readLangs !== null && !Array.isArray(SETTINGS.readLangs)) SETTINGS.readLangs = null
  if (typeof SETTINGS.topicText !== 'string') SETTINGS.topicText = ''
  const w = SETTINGS.web && typeof SETTINGS.web === 'object' ? SETTINGS.web : {}
  SETTINGS.web = { on: w.on === true, lan: w.lan === true, port: Number.isInteger(w.port) && w.port >= 1024 && w.port <= 65535 ? w.port : 7777 }
}
function saveSettings () { try { fs.writeFileSync(settingsPath(), JSON.stringify(SETTINGS)) } catch {} }
function dmPath () { return path.join(dataDir, 'dm-history.json') }
function loadDms () { try { const j = JSON.parse(fs.readFileSync(dmPath(), 'utf8')); for (const [k, v] of j) dmConvos.set(k, v) } catch {} }
function saveDms () { if (!SETTINGS.keepDmHistory) return; try { fs.writeFileSync(dmPath(), JSON.stringify([...dmConvos.entries()])) } catch {} }
function savedPath () { return path.join(dataDir, 'saved.json') }
function loadSaved () { try { for (const a of JSON.parse(fs.readFileSync(savedPath(), 'utf8'))) saved.set(postId(a.author, a.seq), a) } catch {} }
function saveSaved () { try { fs.writeFileSync(savedPath(), JSON.stringify([...saved.values()])) } catch {} }

function notifsPath () { return path.join(dataDir, 'notifs.json') }
function loadNotifs () { try { notifs.push(...JSON.parse(fs.readFileSync(notifsPath(), 'utf8'))) } catch {} }
function saveNotifs () { try { fs.writeFileSync(notifsPath(), JSON.stringify(notifs.slice(-200))) } catch {} }
function watchedPath () { return path.join(dataDir, 'watched.json') }
function loadWatched () { try { for (const [k, v] of JSON.parse(fs.readFileSync(watchedPath(), 'utf8'))) watched.set(k, v) } catch {} }
function saveWatched () { try { fs.writeFileSync(watchedPath(), JSON.stringify([...watched.entries()])) } catch {} }

function watchedBytes () {
  let total = 0
  for (const ranges of watched.values()) for (const r of ranges) total += r.bytes
  return total
}

// Evict oldest watched ranges beyond budget: clear the blocks, stop seeding.
async function evictWatched () {
  while (watchedBytes() > WATCH_BUDGET) {
    let oldest = null, oldestKey = null
    for (const [k, ranges] of watched) for (const r of ranges) {
      if (!oldest || r.ts < oldest.ts) { oldest = r; oldestKey = k }
    }
    if (!oldest) break
    const ranges = watched.get(oldestKey)
    ranges.splice(ranges.indexOf(oldest), 1)
    if (!ranges.length) watched.delete(oldestKey)
    const core = feeds.get(oldestKey)
    if (core) await core.clear(oldest.start, oldest.end).catch(() => {})
  }
  saveWatched()
}

function protectedRanges (hexKey) { return (watched.get(hexKey) || []).map(r => [r.start, r.end]) }

function modPath () { return path.join(dataDir, 'moderation.json') }
function loadMod () { try { const j = JSON.parse(fs.readFileSync(modPath(), 'utf8')); for (const k of j.blocked||[]) blocked.add(k); for (const k of j.muted||[]) muted.add(k) } catch {} }
function saveMod () { try { fs.writeFileSync(modPath(), JSON.stringify({ blocked: [...blocked], muted: [...muted] })) } catch {} }
function niPath () { return path.join(dataDir, 'not-interested.json') }
function loadNotInterested () { try { for (const id of JSON.parse(fs.readFileSync(niPath(), 'utf8'))) notInterested.add(id) } catch {} }
function saveNotInterested () { try { fs.writeFileSync(niPath(), JSON.stringify([...notInterested].slice(-2000))) } catch {} }
function outboxPath () { return path.join(dataDir, 'dm-outbox.json') }
function loadOutbox () { try { dmOutbox.push(...JSON.parse(fs.readFileSync(outboxPath(), 'utf8'))) } catch {} }
function saveOutbox () { try { fs.writeFileSync(outboxPath(), JSON.stringify(dmOutbox.slice(-200))) } catch {} }

function acceptedPath () { return path.join(dataDir, 'dm-accepted.json') }
function loadAccepted () { try { for (const k of JSON.parse(fs.readFileSync(acceptedPath(), 'utf8'))) dmAccepted.add(k) } catch {} }
function saveAccepted () { try { fs.writeFileSync(acceptedPath(), JSON.stringify([...dmAccepted])) } catch {} }

function pushNotif (n) {
  n.id = Date.now() + ':' + Math.random().toString(36).slice(2, 7)
  n.read = false
  notifs.push(n)
  if (notifs.length > 200) notifs.splice(0, notifs.length - 200)
  saveNotifs()
  broadcast('notif', { type: n.type })
  // system-level notification when the window isn't focused (or is hidden in tray)
  if (Notification.isSupported() && (!win || win.isDestroyed() || !win.isFocused())) {
    const titles = { reply: 'Ember — new reply', dm: 'Ember — encrypted message', post: 'Ember — new post' }
    const note = new Notification({ title: titles[n.type] || 'Ember', body: (n.text || '').slice(0, 120), silent: false })
    note.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus() } })
    note.show()
  }
}

function cachePath () { return path.join(dataDir, 'gossip-cache.json') }
function saveCache () {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify({
      discovered: [...discovered.values()].slice(-500),
      replies: [...replies.entries()].map(([k, m]) => [k, [...m.values()]])
    }))
  } catch {}
}
function loadCache () {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    for (const a of j.discovered || []) discovered.set(postId(a.author, a.seq), a)
    for (const [k, arr] of j.replies || []) replies.set(k, new Map(arr.map(r => [postId(r.author, r.seq), r])))
  } catch {}
}

// ---------- gossip protocol ----------

function sendMsg (socket, msg) { try { socket.write(JSON.stringify(msg) + '\n') } catch {} }

// token bucket per socket: burst 60, refill 20/s — hostile peers get silently dropped
function allowMsg (socket) {
  const now = Date.now()
  if (!socket._rl) socket._rl = { tokens: 60, ts: now, dropped: 0 }
  const rl = socket._rl
  rl.tokens = Math.min(60, rl.tokens + (now - rl.ts) * 0.02)
  rl.ts = now
  if (rl.tokens < 1) { rl.dropped++; if (rl.dropped > 2000) socket.destroy(); return false }
  rl.tokens--
  return true
}

// FADING: what you muted, or what lists you trust hide, still reaches you if you
// go looking, but it no longer travels THROUGH you. Ember has no central
// moderation; this is how a crowd's judgement slows things down instead.
function isHidden (k) {
  if (blocked.has(k) || muted.has(k) || listHidden.has(k)) return true
  return circleHidden.has(k) && !follows.has(k)
}
function shouldCarry (a) {
  if (!a || !a.author) return false
  if (myCore && a.author === hex(myCore.key)) return true
  return !isHidden(a.author)
}

function handleAnnouncement (a) {
  if (!a || typeof a.author !== 'string' || !/^[0-9a-f]{64}$/.test(a.author)) return
  if (typeof a.seq !== 'number' || typeof a.ts !== 'number') return
  if (typeof a.text !== 'string' || a.text.length > 600) return
  if (blocked.has(a.author)) return
  if (!Number.isInteger(a.seq) || a.seq < 0) return
  const trust = verifyAnn(a)
  if (trust === 'forged') return // signature invalid or key mismatch: drop silently
  // v2 signature binds kind/ref/thumb/media. If present it MUST verify.
  let bound = false
  if (typeof a.sig2 === 'string' && trust !== 'unsigned') {
    if (!verifyMsg(P.annMsgV2(a), a.sig2, a.edpk)) return
    bound = true
  }
  const kind = P.normKind(a.kind)
  const clean = { author: a.author, seq: a.seq, ts: a.ts, text: a.text, kind, ref: null, trust }
  if (a.sig && trust !== 'unsigned') { clean.sig = a.sig; clean.edpk = a.edpk } // relay signatures intact
  // Media fields ride along only when a v2 signature binds them (or the post
  // is openly unsigned). A v1-signed post with a thumbnail could have had that
  // thumbnail swapped by any relay, so it is dropped rather than shown as verified.
  if (bound || trust === 'unsigned') {
    const media = P.cleanAnnMedia(a)
    if (media) { Object.assign(clean, media); if (bound) clean.sig2 = a.sig2 }
    // media that can't be relayed unchanged is dropped together with sig2
  }
  if (clean.kind === 'quote') {
    if (a.ref && /^[0-9a-f]{64}$/.test(a.ref.author) && typeof a.ref.seq === 'number') clean.ref = { author: a.ref.author, seq: a.ref.seq }
  }
  if (clean.kind === 'reply') {
    if (!a.ref || !/^[0-9a-f]{64}$/.test(a.ref.author) || typeof a.ref.seq !== 'number') return
    clean.ref = { author: a.ref.author, seq: a.ref.seq }
    const rid = postId(clean.ref.author, clean.ref.seq)
    if (!replies.has(rid)) {
      replies.set(rid, new Map())
      if (replies.size > 5000) replies.delete(replies.keys().next().value)
    }
    const m = replies.get(rid)
    if (m.has(postId(clean.author, clean.seq)) || m.size >= 500) return
    m.set(postId(clean.author, clean.seq), clean)
    broadcast('replies-updated', rid)
    if (clean.ref.author === hex(myCore.key) && clean.author !== hex(myCore.key)) {
      pushNotif({ type: 'reply', from: clean.author, ts: clean.ts, text: clean.text, ref: clean.ref })
    }
  } else {
    const id = postId(clean.author, clean.seq)
    if (discovered.has(id)) return
    discovered.set(id, clean)
    if (discovered.size > 5000) discovered.delete(discovered.keys().next().value) // oldest first
    // only a post someone could actually see counts as "new" for the reload pill
    taste.embedOf(clean.text) // computed now, while it's one post, not later for 5000 at once
    if (myCore && clean.author !== hex(myCore.key) && !isHidden(clean.author)) broadcast('discover-updated', { fresh: true, id, ts: clean.ts })
  }
  saveCache()
  // relay once to other gossip peers (epidemic spread within bucket)
  if (shouldCarry(clean)) for (const s of gossipPeers) sendMsg(s, { t: 'ann', a: clean })
}

// Both sides speak first on every connection (hello / dmhello). A connection
// that stays silent is one the other side already dropped (two peers dialling
// each other at once can leave such a line behind): close it rather than count
// it as a peer and send into the void.
function dropIfSilent (socket, ms = 6000) {
  const t = setTimeout(() => { if (!socket._heard) socket.destroy() }, ms)
  socket.once('data', () => { socket._heard = true; clearTimeout(t) })
  socket.once('close', () => clearTimeout(t))
}

function setupGossip () {
  gossipSwarm = new Hyperswarm(swarmOpts())
  gossipSwarm.on('connection', (socket) => {
    gossipPeers.add(socket)
    dropIfSilent(socket)
    socket.on('close', () => { gossipPeers.delete(socket); if (fires) fires.detach(socket); broadcast('gossip-peers', gossipPeers.size) })
    socket.on('error', () => {})
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.length > 1e6) { buf = ''; return }
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        try {
          if (!allowMsg(socket)) { continue }
          const msg = JSON.parse(line)
          if (msg.t === 'ann') handleAnnouncement(msg.a)
          else if (msg.t === 'del') handleDelete(msg.a)
          else if (msg.t === 'fire-here') { if (fires) fires.onHere(socket, msg) }
          else if (msg.t === 'fire-msg') { if (fires) fires.onMsg(socket, msg.m) }
          else if (msg.t === 'hello') {
            // delta sync: send only announcements newer than the peer's watermark
            const since = typeof msg.since === 'number' ? msg.since : 0
            const missing = [...discovered.values()].filter(a => a.ts > since && shouldCarry(a)).slice(-200)
            for (const a of missing) sendMsg(socket, { t: 'ann', a })
            for (const a of saved.values()) if (a.ts > since) sendMsg(socket, { t: 'ann', a }) // saved stay warm through you
            for (const m of replies.values()) for (const a of [...m.values()].slice(-20)) if (a.ts > since && shouldCarry(a)) sendMsg(socket, { t: 'ann', a })
            // always re-offer our own recent posts regardless of watermark:
            // they're canon we author, and the peer may have evicted them
            const mine = [...discovered.values()].filter(a => a.author === hex(myCore.key)).slice(-10)
            for (const a of mine) sendMsg(socket, { t: 'ann', a })
          }
        } catch {}
      }
    })
    // delta sync: tell the peer the newest announcement ts we hold;
    // they answer with only what we're missing (Phantom-style resync on reconnect)
    let since = 0
    for (const a of discovered.values()) if (a.ts > since) since = a.ts
    sendMsg(socket, { t: 'hello', since })
    if (fires) fires.attach(socket)
    broadcast('gossip-peers', gossipPeers.size)
  })
}

async function verifyDmPeer (socket) {
  if (socket.peerKey || !socket.claimedKey || !socket._proof) return
  const k = socket.claimedKey
  let pk = peerEdPk.get(k)
  if (!pk && feeds.has(k)) { try { await latestProfile(feeds.get(k)) } catch {} ; pk = peerEdPk.get(k) }
  if (!pk) return // unknown identity: we have nothing queued for them anyway
  if (!verifyMsg(P.dmProofMsg(socket._chal, k), socket._proof, pk)) { socket.destroy(); return }
  socket.peerKey = k
  flushOutboxTo(socket, k)
}

function flushOutboxTo (socket, peerKey) {
  let flushed = false
  for (const item of dmOutbox) {
    if (item.to !== peerKey) continue
    try { socket.write(JSON.stringify(item.payload) + '\n'); item.sent = true; flushed = true } catch {}
  }
  if (flushed) {
    for (let i = dmOutbox.length - 1; i >= 0; i--) if (dmOutbox[i].sent) dmOutbox.splice(i, 1)
    saveOutbox()
    // mark the queued copies delivered in local history
    const convo = dmConvos.get(peerKey)
    if (convo) { for (const msg of convo) if (msg.delivered === false) msg.delivered = true; saveDms() }
    broadcast('dm-received', peerKey) // refresh open threads
  }
}

function setupDm () {
  dmSwarm = new Hyperswarm(swarmOpts())
  dmSwarm.on('connection', (socket) => {
    dmSockets.add(socket)
    dropIfSilent(socket)
    // identify ourselves + challenge the peer. The outbox is only handed to a
    // socket that proves (by signature) it holds the identity it claims.
    socket._chal = crypto.randomBytes(32).toString('hex')
    try { socket.write(JSON.stringify({ t: 'dmhello', v: P.PROTOCOL_VERSION, key: hex(myCore.key), chal: socket._chal }) + '\n') } catch {}
    socket.on('close', () => { dmSockets.delete(socket); broadcast('dm-peers', dmSockets.size) })
    socket.on('error', () => {})
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.length > 1e6) { buf = ''; return }
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        try {
          if (!allowMsg(socket)) { continue }
          const msg = JSON.parse(line)
          if (msg.t === 'dmhello' && P.HEX64.test(msg.key || '')) {
            socket.claimedKey = msg.key
            if (typeof msg.chal === 'string' && P.HEX64.test(msg.chal)) {
              try { socket.write(JSON.stringify({ t: 'dmproof', sig: signMsg(P.dmProofMsg(msg.chal, hex(myCore.key))) }) + '\n') } catch {}
            }
            verifyDmPeer(socket)
          }
          if (msg.t === 'dmproof' && typeof msg.sig === 'string') { socket._proof = msg.sig; verifyDmPeer(socket) }
          if (msg.t === 'dm' && msg.to === hex(myCore.key) && /^[0-9a-f]{64}$/.test(msg.from || '') && /^[0-9a-f]{64}$/.test(msg.edpk || '')) {
            if (blocked.has(msg.from)) continue
            const known = peerEdPk.get(msg.from)
            if (known && known !== msg.edpk) continue // claimed sender's published key doesn't match: reject
            const mid = msg.mid || (msg.p && msg.p.n)
            if (mid) {
              if (!dmSeen.has(msg.from)) dmSeen.set(msg.from, new Set())
              const seen = dmSeen.get(msg.from)
              if (seen.has(mid)) continue
              seen.add(mid); if (seen.size > 1000) dmSeen.set(msg.from, new Set([...seen].slice(-500)))
            }
            const text = dm.open(msg.p, msg.edpk, myCurve.sk)
            if (text === null) continue // failed auth-decrypt under the claimed key
            if (!dmConvos.has(msg.from)) dmConvos.set(msg.from, [])
            const convo = dmConvos.get(msg.from)
            if (!known) peerEdPk.set(msg.from, msg.edpk) // trust-on-first-use
            convo.push({ from: msg.from, to: hex(myCore.key), text, ts: msg.ts || Date.now(), verified: !!known })
            if (convo.length > 500) convo.splice(0, convo.length - 500)
            saveDms()
            broadcast('dm-received', msg.from)
            pushNotif({ type: 'dm', from: msg.from, ts: msg.ts || Date.now(), text: P.dmPreview(text) })
          }
        } catch {}
      }
    })
    broadcast('dm-peers', dmSockets.size)
  })
  // always reachable in my own inbox
  dmSwarm.join(dm.inboxTopic(hex(myCore.key)), { server: true, client: true })
}

function joinGossip (topicBuf, kind) {
  const k = hex(topicBuf)
  if (gossipTopics.has(k)) { gossipTopics.get(k).refCount++; return }
  gossipTopics.set(k, { kind, refCount: 1 })
  gossipSwarm.join(topicBuf, { server: true, client: true })
}

function leaveGossip (topicBuf) {
  const k = hex(topicBuf); const t = gossipTopics.get(k)
  if (!t) return
  if (--t.refCount > 0) return
  gossipTopics.delete(k)
  gossipSwarm.leave(topicBuf).catch(() => {})
}
// The commons is the whole network's meeting point. With topics picked it
// becomes a trickle: joined only while we have fewer than 3 gossip peers.
function setCommons (on) {
  if (on === commonsJoined || !gossipSwarm) return
  commonsJoined = on
  if (on) gossipSwarm.join(disc.commonsTopic(), { server: true, client: true })
  else gossipSwarm.leave(disc.commonsTopic()).catch(() => {})
  broadcast('commons-state', on)
}
function readLangs () {
  const l = Array.isArray(SETTINGS.readLangs) && SETTINGS.readLangs.length ? SETTINGS.readLangs : [SETTINGS.uiLang || 'en']
  const ok = l.filter(x => taste.LANGS.includes(x))
  return ok.length ? ok : ['en']
}
function compassVec () { return tasteStore ? tasteStore.vector(SETTINGS.topics, readLangs(), SETTINGS.topicText) : null }
// DECOYS: two extra topic rooms, picked by a secret that never leaves this
// machine. They are as stable as real interests (a decoy that changed every day
// would stand out from picks that don't), and only move if you pick one of them.
function decoyTopics () {
  if (!SETTINGS.topics.length) return []
  if (!SETTINGS.decoySeed) { SETTINGS.decoySeed = crypto.randomBytes(16).toString('hex'); saveSettings() }
  const order = (id) => crypto.createHash('sha256').update(`${SETTINGS.decoySeed}:${id}`).digest('hex')
  return taste.CATALOG.map(t => t.id).sort((a, b) => order(a) < order(b) ? -1 : 1).filter(id => !SETTINGS.topics.includes(id)).slice(0, 2)
}
// sit in: my topic rooms, today's decoys, the buckets around my compass (wider
// as the dial turns STRANGE) and the buckets of the words I described myself with
function syncRooms () {
  if (!gossipSwarm) return
  const want = new Map()
  const add = (t) => want.set(hex(t), t)
  for (const id of [...SETTINGS.topics, ...decoyTopics()]) add(taste.topicTopic(id))
  for (const t of taste.compassTopics(compassVec(), SETTINGS.dial)) add(t)
  if (SETTINGS.topicText && SETTINGS.topicText.trim()) for (const t of disc.topicsForText(SETTINGS.topicText)) add(t)
  for (const [k, t] of roomsJoined) if (!want.has(k)) { leaveGossip(t); roomsJoined.delete(k) }
  for (const [k, t] of want) if (!roomsJoined.has(k)) { joinGossip(t, 'room'); roomsJoined.set(k, t) }
  if (fires) fires.setMine(SETTINGS.campfires ? SETTINGS.topics : [], SETTINGS.campfires ? decoyTopics() : [])
}
const searchRooms = new Map() // hexTopic -> topic, oldest first
function joinSearchRoom (t) {
  const k = hex(t)
  if (searchRooms.has(k)) { searchRooms.delete(k); searchRooms.set(k, t); return }
  searchRooms.set(k, t); joinGossip(t, 'disc')
  while (searchRooms.size > 72) { const [ok, ot] = searchRooms.entries().next().value; searchRooms.delete(ok); leaveGossip(ot) }
}
// a post about music goes into the music room, whether or not I picked music
function joinTopicRoomsFor (text) {
  for (const id of taste.classify(text || '')) {
    const t = taste.topicTopic(id); const k = hex(t)
    if (roomsJoined.has(k) || postRooms.has(k)) continue
    postRooms.add(k); joinGossip(t, 'room')
  }
}
function learn (text, w) { if (tasteStore && text) tasteStore.learn(text, w) }
async function learnFrom (author, seq, w) {
  try {
    const a = discovered.get(postId(author, seq)) || saved.get(postId(author, seq))
    const text = a ? a.text : ((await resolveBlock(author, seq)) || {}).text
    learn(text, w)
  } catch {}
}

// Re-derive which discovery buckets we should live in from our recent posts + follows' posts.
async function refreshInterests () {
  const texts = []
  for (const [k, core] of feeds) {
    if (k !== hex(myCore.key) && !follows.has(k)) continue
    const start = Math.max(0, core.length - 20)
    for (let i = start; i < core.length; i++) {
      try {
        if (!(await core.has(i))) continue // deleted or not synced yet: never wait on it
        const b = await core.get(i, { timeout: 1500 })
        if (b.type === 'post') { texts.push(b.text); if (k === hex(myCore.key)) joinTopicRoomsFor(b.text) }
      } catch {}
    }
  }
  const topicSet = new Map()
  for (const t of texts.slice(-40)) {
    for (const topic of disc.topicsForText(t)) topicSet.set(hex(topic), topic)
  }
  // our own reference on each bucket, so another owner leaving it can't drop it
  for (const [k, topic] of topicSet) if (!discJoined.has(k)) { discJoined.add(k); joinGossip(topic, 'disc') }
  syncRooms()
  // small-network rendezvous; with topics picked, only while things are quiet
  if (SETTINGS.commons && (!SETTINGS.topics.length || gossipPeers.size < 3)) setCommons(true)
  broadcast('buckets', gossipTopics.size + (commonsJoined ? 1 : 0))
}

// ---------- feed engine (unchanged core) ----------

async function startEngine () {
  dataDir = path.join(app.getPath('userData'), 'ember-data')
  fs.mkdirSync(dataDir, { recursive: true })
  loadCache()
  const restoreFile = path.join(dataDir, 'RESTORE_KEY')
  let primaryKey = null
  if (fs.existsSync(restoreFlag())) restorePending = true // a restore that hasn't synced yet (survives restarts)
  if (fs.existsSync(restoreFile)) {
    try {
      primaryKey = b4a.from(fs.readFileSync(restoreFile, 'utf8').trim(), 'hex')
      // wipe the old store so the restored identity starts clean
      for (const f of ['db', 'cores', 'CORESTORE', 'primary-key']) {
        try { fs.rmSync(path.join(dataDir, f), { recursive: true, force: true }) } catch {}
      }
      fs.unlinkSync(restoreFile)
      restorePending = true // the flag file is written once the new store exists (a fresh store clears its folder)
    } catch { primaryKey = null }
  }
  store = primaryKey ? new Corestore(dataDir, { primaryKey, unsafe: true }) : new Corestore(dataDir)
  feedSwarm = new Hyperswarm(swarmOpts())
  feedSwarm.on('connection', (socket) => {
    store.replicate(socket)
    broadcast('peers', feedSwarm.connections.size)
    socket.on('close', () => broadcast('peers', feedSwarm.connections.size))
  })
  setupGossip()

  myCore = store.get({ name: 'ember-self', valueEncoding: 'json' })
  await myCore.ready()
  if (restorePending) try { fs.writeFileSync(restoreFlag(), String(Date.now())) } catch {}
  myCurve = dm.curveKeys(myCore.keyPair)
  myEdPk = b4a.toString(myCore.keyPair.publicKey, 'hex')
  loadSettings(); loadDms(); loadSaved(); loadNotifs(); loadAccepted(); loadMod(); loadOutbox(); loadWatched(); loadNotInterested()
  tasteStore = new taste.Taste(dataDir)
  startFires()
  setupDm()
  feeds.set(hex(myCore.key), myCore)
  feedSwarm.join(myCore.discoveryKey, { server: true, client: true })
  // another install of this identity (e.g. the old PC after a restore) may write
  // too: keep a copy of what it wrote, so our own profile and feed show it
  let selfLen = myCore.length
  myCore.on('append', () => {
    const from = selfLen; selfLen = myCore.length
    if (from < selfLen) myCore.download({ start: from, end: selfLen }).done().then(() => broadcast('feed-updated', { key: hex(myCore.key), own: true })).catch(() => {})
  })
  if (restorePending) {
    // don't block boot on the network: sync in the background, then load our state
    syncRestoredLog()
  } else {
    await loadSelfState()
  }
  refreshInterests()
  setInterval(refreshInterests, 60_000)
  afterBoot()
}

// Pull our own log back from whoever holds it (followers re-seed it). Retries
// until someone is online; the user can also confirm the identity never posted.
async function syncRestoredLog () {
  broadcast('restore-state', { pending: true })
  for (let tries = 0; ; tries++) {
    await Promise.race([feedSwarm.flush().catch(() => {}), new Promise(r => setTimeout(r, 15_000))])
    await Promise.race([myCore.update({ wait: true, force: true }).catch(() => false), new Promise(r => setTimeout(r, 15_000))])
    if (myCore.length > 0 || !restorePending) break
    // nobody holding the log is online yet: look again, quickly at first, then every 30 s
    await new Promise(r => setTimeout(r, tries < 6 ? 5_000 : 30_000))
  }
  if (myCore.length > 0) await myCore.download({ start: Math.max(0, myCore.length - 600), end: myCore.length }).done().catch(() => {})
  finishRestore()
}
async function finishRestore () {
  if (!restorePending && !fs.existsSync(restoreFlag())) return
  restorePending = false
  try { fs.unlinkSync(restoreFlag()) } catch {}
  await loadSelfState()
  refreshInterests()
  broadcast('restore-state', { pending: false, length: myCore.length })
  broadcast('feed-updated', { key: hex(myCore.key), own: true })
}

// follows + profile bootstrap, read from our own log
async function loadSelfState () {
  for (let i = 0; i < myCore.length; i++) {
    try {
      if (!(await myCore.has(i))) continue      // cleared by a delete: skip, never wait
      const blk = await myCore.get(i, { timeout: 1500 })
      if (blk.type === 'follow') follows.add(blk.key)
      if (blk.type === 'unfollow') follows.delete(blk.key)
    } catch {}
  }
  for (const k of follows) await openFeed(k)
  for (const k of watched.keys()) if (!feeds.has(k)) await openFeed(k) // re-seed watched media across restarts
  // make sure our DM key is published even if the user never sets a profile.
  // ALWAYS merge the full recovered profile so name/avatar are never buried.
  const prof = await latestProfile(myCore)
  if (!prof || prof.dmKey !== myEdPk) {
    await appendMine({
      type: 'profile',
      name: (prof && prof.name) || '', status: (prof && prof.status) || '', bio: (prof && prof.bio) || '',
      ...(prof && prof.avatar ? { avatar: prof.avatar } : {}),
      dmKey: myEdPk, ts: Date.now()
    })
  }
  myName = (prof && prof.name) || ''
}

function afterBoot () {
  startNearby()
  // auto-commons: once proximity buckets alone sustain enough peers, leave the
  // global rendezvous (less noise, pure meaning-space); rejoin if we go quiet.
  // With topics picked the faucet is smaller: leave at 6 peers, rejoin under 3.
  setInterval(() => {
    if (!SETTINGS.commons) return // user override wins
    const peers = gossipPeers.size
    const hi = SETTINGS.topics.length ? 6 : 10, lo = SETTINGS.topics.length ? 3 : 4
    if (commonsJoined && peers >= hi) setCommons(false)
    else if (!commonsJoined && peers < lo) setCommons(true)
  }, 90_000)
  setTimeout(refreshCircle, 8_000)
  // embeddings for the posts cached from last time, a few at a time, so the
  // first Discover after a start doesn't compute hundreds at once
  const pending = [...discovered.values()]
  const warm = () => { for (const a of pending.splice(0, 25)) taste.embedOf(a.text); if (pending.length) setTimeout(warm, 5) }
  setTimeout(warm, 3000)
  setInterval(refreshCircle, 10 * 60_000)
  setInterval(() => { if (fires) fires.refresh() }, 60_000)
  setInterval(() => {
    const mine = [...discovered.values()].filter(a => a.author === hex(myCore.key)).slice(-10)
    for (const s of gossipPeers) for (const a of mine) sendMsg(s, { t: 'ann', a })
  }, 240_000) // every 4 min: peers who joined our buckets late still receive our recent posts
}

async function openFeed (hexKey) {
  if (feeds.has(hexKey)) return feeds.get(hexKey)
  const core = store.get({ key: b4a.from(hexKey, 'hex'), valueEncoding: 'json' })
  await core.ready()
  feeds.set(hexKey, core)
  feedSwarm.join(core.discoveryKey, { server: true, client: true })
  let seenLen = core.length
  core.on('append', async () => {
    tailSync(core)
    // count only real posts among the new blocks: profile edits, follows, video
    // chunks, blocklists… must not show up as "NEW POSTS"
    const from = Math.max(seenLen, core.length - 20), to = core.length
    seenLen = to
    let posts = 0
    for (let i = from; i < to; i++) {
      try {
        const blk = P.sanitizeBlock(await core.get(i, { timeout: 3000 }))
        if (!blk || !['post', 'quote', 'repost'].includes(blk.type)) continue
        posts++
        if (follows.has(hexKey) && blk.type === 'post') pushNotif({ type: 'post', from: hexKey, ts: blk.ts, text: (blk.text || '').slice(0, 140), ref: { author: hexKey, seq: i } })
      } catch {}
    }
    broadcast('feed-updated', { key: hexKey, posts: follows.has(hexKey) && !isHidden(hexKey) ? posts : 0 })
  })
  tailSync(core)
  return core
}

async function readFeed (core, max = 200) {
  const out = []
  const deleted = new Set()
  const start = Math.max(0, core.length - max)
  // backward scan: tombstones (higher seq) are seen BEFORE their targets,
  // so deleted seqs are skipped without ever touching the cleared block
  for (let i = core.length - 1; i >= start; i--) {
    if (deleted.has(i)) continue
    try {
      const local = await core.has(i)
      // own core: a locally-absent block is gone (we cleared it) — never wait on the network for it
      if (!local && core.writable) continue
      const blk = P.sanitizeBlock(await core.get(i, { timeout: local ? 1500 : 4000 }))
      if (!blk) continue
      if (blk.type === 'delete') { deleted.add(blk.ref.seq); continue }
      out.push({ seq: i, author: hex(core.key), ...blk })
    } catch {}
  }
  return out.filter(b => !deleted.has(b.seq))
}

// Merging profile reader: newest values win, but missing fields (a profile
// block written without name/avatar, e.g. the dmKey bootstrap) are filled
// from older profile blocks. Cleared blocks are skipped, never waited on.
async function latestProfile (core) {
  const merged = {}
  let found = false
  const fields = ['name', 'bio', 'status', 'avatar', 'dmKey', 'ts']
  const floor = Math.max(0, core.length - 600)
  for (let i = core.length - 1; i >= floor; i--) {
    let blk
    try {
      const local = await core.has(i)
      if (!local && core.writable) continue      // cleared by us: skip instantly
      if (!local && found) break                  // remote core: don't chase history once we have a profile
      blk = P.sanitizeBlock(await core.get(i, { timeout: local ? 1500 : 3500 }))
    } catch { continue }
    if (!blk || blk.type !== 'profile') continue
    found = true
    for (const f of fields) if (merged[f] === undefined && blk[f] !== undefined && blk[f] !== null && blk[f] !== '') merged[f] = blk[f]
    if (fields.every(f => merged[f] !== undefined)) break
  }
  if (!found) return null
  if (merged.dmKey && /^[0-9a-f]{64}$/.test(merged.dmKey)) peerEdPk.set(hex(core.key), merged.dmKey)
  return merged
}

// Every write to our own log goes through here. After an identity RESTORE the
// log must first be downloaded from followers: writing before that would start
// a second, conflicting history at position 0 (a fork followers can't accept).
let restorePending = false
function appendMine (block) {
  if (restorePending) { const e = new Error('RESTORE_PENDING'); e.code = 'RESTORE_PENDING'; throw e }
  return myCore.append(block)
}
function restoreFlag () { return path.join(dataDir, 'RESTORE_PENDING') }

function broadcast (ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
  if (web) web.broadcast(ch, data)
}

// Storage philosophy: don't hoard. Re-seed only a sliding tail window of each
// followed feed (text blocks are tiny); everything older, and all media, is
// fetched on demand while a holder is connected, then may be dropped.
function tailSync (core) {
  const start = Math.max(0, core.length - (SETTINGS.tailWindow || 150))
  core.download({ start, end: core.length })
  if (start <= 0) return
  // evaporate the old tail, but protect watched (warm-cached) media ranges
  const prot = protectedRanges(hex(core.key)).sort((a, b) => a[0] - b[0])
  let cursor = 0
  for (const [a, b] of prot) {
    if (a > cursor && cursor < start) core.clear(cursor, Math.min(a, start)).catch(() => {})
    cursor = Math.max(cursor, b)
    if (cursor >= start) break
  }
  if (cursor < start) core.clear(cursor, start).catch(() => {})
}

// Resolve any (author, seq) block: open feed -> gossip cache -> sparse remote fetch.
async function resolveBlock (author, seq) {
  const core = feeds.get(author) || await openFeed(author)
  try {
    const local = await core.has(seq)
    if (!local && core.writable) throw new Error('cleared') // our own deleted block: don't wait
    const blk = P.sanitizeBlock(await core.get(seq, { timeout: local ? 1500 : 6000 }))
    if (!blk) throw new Error('unreadable block')
    return { seq, author, ...blk }
  } catch {
    const a = discovered.get(postId(author, seq))
    return a ? { seq, author, ts: a.ts, type: 'post', text: a.text, unverified: true } : null
  }
}

function announceOwn (block, seq) {
  const a = {
    author: hex(myCore.key), seq, ts: block.ts, text: block.text,
    kind: block.type === 'reply' ? 'reply' : block.type === 'quote' ? 'quote' : 'post',
    ref: block.ref || null
  }
  if (block.thumb) a.thumb = block.thumb
  if (block.mediaSeq != null) a.mediaSeq = block.mediaSeq
  if (block.videoMeta) a.videoMeta = block.videoMeta
  a.edpk = myEdPk
  a.sig = signAnn(a)
  a.sig2 = signMsg(P.annMsgV2(a))
  handleAnnouncement(a) // stores locally + relays to current gossip peers
}

// ---------- IPC ----------

handle('me', async () => {
  if (!engineUp || !myCore) return { key: '', length: 0, profile: null, booting: true }
  return { key: hex(myCore.key), length: myCore.length, profile: await latestProfile(myCore), restorePending }
})
// the restored identity really never posted: nothing to download, start writing
handle('restore-skip', async () => { if (restorePending) await finishRestore(); return true })

handle('post', async (_e, { text, image, thumb, quoteRef }) => {
  let mediaSeq = null
  if (image && typeof image === 'string' && image.length < 30_000_000) {
    await appendMine({ type: 'media', data: image, ts: Date.now() })
    mediaSeq = myCore.length - 1
  }
  const block = { type: quoteRef ? 'quote' : 'post', text, ts: Date.now() }
  if (quoteRef && /^[0-9a-f]{64}$/.test(quoteRef.author) && typeof quoteRef.seq === 'number') block.ref = { author: quoteRef.author, seq: quoteRef.seq }
  if (mediaSeq !== null) { block.mediaSeq = mediaSeq; block.thumb = (thumb || '').slice(0, 8000) }
  await appendMine(block)
  const seq = myCore.length - 1
  for (const topic of disc.topicsForText(text)) joinGossip(topic, 'disc')
  joinTopicRoomsFor(text)
  joinGossip(disc.replyTopic(hex(myCore.key), seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, seq)
  broadcast('feed-updated', { key: hex(myCore.key), own: true })
  learn(text, 0.8)
  if (block.ref) learnFrom(block.ref.author, block.ref.seq, 0.8)
  return seq
})

// full-resolution media, fetched on demand while a holder is online
handle('get-media', async (_e, { author, seq }) => {
  const blk = await resolveBlock(author, seq)
  return blk && blk.type === 'media' ? blk.data : null
})

handle('resolve-block', async (_e, { author, seq }) => resolveBlock(author, seq))

handle('reply', async (_e, { author, seq, text }) => {
  const block = { type: 'reply', text, ref: { author, seq }, ts: Date.now() }
  await appendMine(block)
  const mySeq = myCore.length - 1
  joinGossip(disc.replyTopic(author, seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, mySeq)
  learn(text, 0.5); learnFrom(author, seq, 1.0)
  return mySeq
})

handle('get-replies', async (_e, { author, seq }) => {
  joinGossip(disc.replyTopic(author, seq), 'reply') // subscribe on view
  const m = replies.get(postId(author, seq))
  return m ? [...m.values()].filter(r => !isHidden(r.author)).sort((a, b) => a.ts - b.ts) : []
})

handle('set-profile', async (_e, { name, bio, status, avatar }) => {
  const prev = await latestProfile(myCore) || {}
  const blk = {
    type: 'profile',
    name: (name !== undefined && name !== null && name !== '') ? name : (prev.name || ''),
    bio: bio || prev.bio || '',
    status: (status !== undefined && status !== null) ? status : (prev.status || ''),
    dmKey: myEdPk, ts: Date.now()
  }
  if (avatar && typeof avatar === 'string' && avatar.length <= 60_000) blk.avatar = avatar
  else if (prev.avatar) blk.avatar = prev.avatar
  await appendMine(blk); myName = blk.name || ''; return true
})

handle('follow', async (_e, { key }) => {
  const raw = key
  key = P.cleanKey(key)
  if (!key) throw new Error(`invalid key — expected 64 hex characters, got: ${String(raw).trim().slice(0, 40)}`)
  if (key === hex(myCore.key) || follows.has(key)) return [...follows]
  await appendMine({ type: 'follow', key, ts: Date.now() })
  follows.add(key); await openFeed(key); refreshInterests()
  return [...follows]
})

handle('unfollow', async (_e, { key }) => {
  key = P.cleanKey(key) || key
  if (!follows.has(key)) return [...follows]
  await appendMine({ type: 'unfollow', key, ts: Date.now() })
  follows.delete(key); return [...follows]
})

handle('timeline', async () => {
  if (!engineUp) return { items: [], profiles: {}, follows: [], peers: 0, replyCounts: {}, booting: true }
  const items = []; const profiles = {}
  for (const [k, core] of feeds) {
    if (k !== hex(myCore.key) && !follows.has(k)) continue
    if (blocked.has(k) || muted.has(k)) continue
    items.push(...(await readFeed(core)).filter(b => b.type === 'post' || b.type === 'repost' || b.type === 'quote'))
    const p = await latestProfile(core); if (p) profiles[k] = p
  }
  items.sort((a, b) => b.ts - a.ts)
  // reply counts for visible posts
  const replyCounts = {}
  for (const it of items) { const m = replies.get(postId(it.author, it.seq)); if (m) replyCounts[postId(it.author, it.seq)] = m.size }
  return {
    items: items.slice(0, 300), profiles, follows: [...follows],
    peers: feedSwarm.connections.size,
    seeders: (myCore.peers && myCore.peers.length) || 0,
    replyCounts
  }
})

handle('discover', async (_e, { query } = {}) => {
  if (!engineUp) return { items: [], buckets: 0, gossipPeers: 0, booting: true }
  // If a query is given, rank the gossip cache by cosine proximity; else by the compass.
  const me = hex(myCore.key)
  let list = [...discovered.values()].filter(a => a.author !== me && !isHidden(a.author) && !notInterested.has(postId(a.author, a.seq)))
  if (SETTINGS.onlyMyLangs) { const langs = readLangs(); list = list.filter(a => taste.readable(a.text, langs)) }
  const total = list.length
  if (query && query.trim()) {
    const qv = disc.embed(query)
    // multi-probe: sit in the query's buckets and their 1-bit neighbours (the
    // last few searches only, so typing doesn't pile up swarm topics forever)
    for (const topic of disc.probeTopicsForText(query)) joinSearchRoom(topic)
    const now = Date.now()
    list = list.map(a => {
      const cos = disc.cosine(qv, taste.embedOf(a.text))
      const rec = Math.exp(-(now - a.ts) / (3 * 86_400_000)) // 3-day half-ish decay
      return { ...a, score: cos, rank: 0.78 * cos + 0.22 * rec }
    }).sort((a, b) => b.rank - a.rank)
  } else {
    // the dial picks which posts, newest first; someone on one list of a person
    // you follow counts as further from your compass, and is flagged
    const soft = (a) => circleSoft.has(a.author) && !follows.has(a.author)
    list = taste.rank(list, compassVec(), SETTINGS.dial, (a) => soft(a) ? 0.6 : 1)
      .map(a => soft(a) ? { ...a, flagged: true } : a)
  }
  const ctx = { query: query && query.trim(), follows, topics: SETTINGS.topics, terms: tasteStore ? tasteStore.top(40).map(t => t.term) : [] }
  const items = list.slice(0, 100).map(a => ({ ...a, why: taste.why(a, ctx) }))
  return {
    items, buckets: gossipTopics.size + (commonsJoined ? 1 : 0), gossipPeers: gossipPeers.size,
    quiet: total < 5, topics: SETTINGS.topics.length, dial: SETTINGS.dial, commons: commonsJoined
  }
})

handle('profile-page', async (_e, { key }) => {
  const self = key === hex(myCore.key)
  const core = self ? myCore : (feeds.get(key) || await openFeed(key))
  const all = await readFeed(core, 300)
  const posts = all.filter(b => b.type === 'post' || b.type === 'quote')
  const followBlocks = all.filter(b => b.type === 'follow').length - all.filter(b => b.type === 'unfollow').length
  const profile = await latestProfile(core)
  let joined = null
  try { const first = await core.get(0, { timeout: 2500 }); joined = first.ts } catch {}
  return {
    key, self, profile, joined,
    stats: { posts: posts.length, following: self ? follows.size : Math.max(0, followBlocks), blocks: core.length },
    posts: posts.slice(0, 60),
    isFollowed: follows.has(key)
  }
})

handle('repost', async (_e, { author, seq }) => {
  await appendMine({ type: 'repost', ref: { author, seq }, ts: Date.now() })
  learnFrom(author, seq, 1.0)
  return true
})

// ---- delete (tombstone + local clear + gossip purge) ----

handle('delete-post', async (_e, { seq }) => {
  if (!Number.isInteger(seq) || seq < 0 || seq >= myCore.length) throw new Error('bad seq')
  let media = null
  try {
    if (!(await myCore.has(seq))) return true // already gone
    const blk = await myCore.get(seq, { timeout: 1500 })
    if (!blk || !['post', 'quote', 'repost'].includes(blk.type)) throw new Error('not a post') // never tombstone profiles/media by accident
    if (blk.mediaSeq != null) media = blk.mediaSeq
  } catch (e) { if (e.message === 'not a post') throw e }
  await appendMine({ type: 'delete', ref: { seq }, ts: Date.now() })
  try { await myCore.clear(seq, seq + 1) } catch {}                    // stop serving the content
  if (media != null) { try { await myCore.clear(media, media + 1) } catch {} }
  const id = postId(hex(myCore.key), seq)
  discovered.delete(id); replies.delete(id); saveCache()
  // gossip the tombstone so peers purge caches + clear replicated blocks
  const dts = Date.now()
  const delMsg = { t: 'del', a: { author: hex(myCore.key), seq, ts: dts, edpk: myEdPk, sig: signMsg(P.delMsg(hex(myCore.key), seq, dts)) } }
  for (const s of gossipPeers) sendMsg(s, delMsg)
  broadcast('feed-updated', { key: hex(myCore.key), own: true })
  return true
})

function handleDelete (a) {
  if (!a || !P.HEX64.test(a.author || '') || !Number.isInteger(a.seq) || typeof a.ts !== 'number') return
  if (typeof a.sig !== 'string' || typeof a.edpk !== 'string') return          // unsigned tombstone: ignore
  const id = postId(a.author, a.seq)
  // the signing key must be one we already tie to this author: their published
  // profile key, or the key that signed the announcement we're about to purge
  const known = peerEdPk.get(a.author) || (discovered.get(id) && discovered.get(id).edpk)
  if (!known || known !== a.edpk || !verifyMsg(P.delMsg(a.author, a.seq, a.ts), a.sig, a.edpk)) return
  a = { author: a.author, seq: a.seq, ts: a.ts, edpk: a.edpk, sig: a.sig }
  if (discovered.delete(id)) saveCache()
  replies.delete(id)
  const core = feeds.get(a.author)
  if (core) core.clear(a.seq, a.seq + 1).catch(() => {})   // drop our replicated copy
  for (const s of gossipPeers) if (!s._sawDel) sendMsg(s, { t: 'del', a }) // single-hop relay
  broadcast('discover-updated', { fresh: false }); broadcast('feed-updated', { key: a.author, posts: 0, removed: true })
}

// ---- video: chunked blocks + watch-to-seed warm cache ----

// Transcode any input to a lean 720p/CRF-28 mp4, then chunk into the core.
// ffmpeg is bundled — no input format or size restrictions.
handle('post-video', async (e, { inputPath, text, thumb, upload } = {}) => {
  // a browser can't name a file on this computer: it uploads one (web.js) and
  // may only point at that upload
  if (e && e.web) inputPath = web && web.uploadPath(upload)
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('no input')
  if (e && e.web) setTimeout(() => fs.rm(inputPath, { force: true }, () => {}), 10 * 60_000)
  const outPath = path.join(os.tmpdir(), 'ember-v-' + Date.now() + '.mp4')

  // probe duration for progress percentage
  let durationSec = 0
  await new Promise((resolve) => {
    const probe = spawn(ffmpegPath, ['-i', inputPath])
    let err = ''
    probe.stderr.on('data', d => err += d.toString())
    probe.on('close', () => {
      const mm = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (mm) durationSec = (+mm[1]) * 3600 + (+mm[2]) * 60 + parseFloat(mm[3])
      resolve()
    })
  })

  await new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath,
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
      '-progress', 'pipe:1', outPath]
    const p = spawn(ffmpegPath, args)
    p.stdout.on('data', d => {
      const mm = d.toString().match(/out_time_ms=(\d+)/)
      if (mm && durationSec) {
        broadcast('transcode-progress', { pct: Math.min(99, Math.round((+mm[1] / 1e6) / durationSec * 100)) })
      }
    })
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed ' + code)))
    p.on('error', reject)
  })

  const buf = fs.readFileSync(outPath)
  fs.unlinkSync(outPath)
  const b64 = buf.toString('base64')
  const chunks = []
  for (let i = 0; i < b64.length; i += 65536) chunks.push(b64.slice(i, i + 65536))
  broadcast('transcode-progress', { pct: 100 })

  const start = myCore.length
  for (const c of chunks) await appendMine({ type: 'vchunk', d: c })
  const videoMeta = { start, count: chunks.length, mime: 'video/mp4', size: buf.length }
  const block = { type: 'post', text: text || '', ts: Date.now(), videoMeta, thumb: (thumb || '').slice(0, 20000) }
  await appendMine(block)
  const seq = myCore.length - 1
  for (const topic of disc.topicsForText(text || 'video')) joinGossip(topic, 'disc')
  joinTopicRoomsFor(text); learn(text, 0.8)
  joinGossip(disc.replyTopic(hex(myCore.key), seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, seq)
  broadcast('feed-updated', { key: hex(myCore.key), own: true })
  return { seq, size: buf.length, chunks: chunks.length }
})

// Fetch + assemble a video. Fetched chunks are Hypercore-replicated blocks:
// from this moment this client SEEDS them to other peers (watch-to-seed).
// The range is recorded in the warm cache: protected from tail eviction,
// re-seeded across restarts, evicted only by the LRU byte budget.
handle('get-video', async (_e, { author, meta }) => {
  if (!meta || !Number.isInteger(meta.start) || !Number.isInteger(meta.count) || meta.count > 30000) throw new Error('bad meta')
  const core = feeds.get(author) || await openFeed(author)
  await feedSwarm.flush().catch(() => {})
  const parts = []
  let bytes = 0
  for (let i = 0; i < meta.count; i++) {
    try {
      const blk = await core.get(meta.start + i, { timeout: 12_000 })
      if (!blk || blk.type !== 'vchunk' || typeof blk.d !== 'string') return { ok: false, at: i }
      parts.push(blk.d); bytes += blk.d.length
      broadcast('video-progress', { author, seq: meta.start, done: i + 1, total: meta.count })
    } catch { return { ok: false, at: i } } // no holder online for this chunk
  }
  // record warm-cache range (watched, not saved)
  const ranges = watched.get(author) || []
  const already = ranges.find(r => r.start === meta.start)
  if (already) already.ts = Date.now()
  else ranges.push({ start: meta.start, end: meta.start + meta.count, bytes, ts: Date.now() })
  watched.set(author, ranges)
  await evictWatched()
  return { ok: true, dataUrl: `data:${meta.mime};base64,` + parts.join('') }
})

handle('warm-cache-stats', async () => ({
  bytes: watchedBytes(), budget: WATCH_BUDGET,
  items: [...watched.values()].reduce((n, r) => n + r.length, 0)
}))

// ---- stories (24h ephemeral image blocks in your own core) ----

handle('post-story', async (_e, { image, caption }) => {
  if (!image || typeof image !== 'string' || image.length > 300_000) throw new Error('bad story')
  await appendMine({ type: 'story', data: image, caption: (caption || '').slice(0, 140), ts: Date.now() })
  broadcast('feed-updated', { key: hex(myCore.key), own: true })
  return true
})

handle('stories', async () => {
  if (!engineUp) return []
  const cutoff = Date.now() - 86_400_000
  const out = []
  for (const [k, core] of feeds) {
    if (k !== hex(myCore.key) && !follows.has(k)) continue
    if (blocked.has(k) || muted.has(k)) continue
    const stories = []
    const start = Math.max(0, core.length - 60)
    for (let i = core.length - 1; i >= start; i--) {
      try {
        const local = await core.has(i)
        if (!local && core.writable) continue   // hole from a delete: skip, keep scanning
        if (!local) continue                    // remote block not synced: skip (tail sync will fill)
        const blk = await core.get(i, { timeout: 1500 })
        if (blk.type === 'story' && blk.ts > cutoff) stories.push({ author: k, seq: i, caption: blk.caption, ts: blk.ts })
      } catch { continue }
    }
    if (stories.length) out.push({ author: k, self: k === hex(myCore.key), stories: stories.reverse() })
  }
  out.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || b.stories[b.stories.length-1].ts - a.stories[a.stories.length-1].ts)
  return out
})

handle('get-story', async (_e, { author, seq }) => {
  const blk = await resolveBlock(author, seq)
  return blk && blk.type === 'story' ? { data: blk.data, caption: blk.caption, ts: blk.ts } : null
})

// ---- moderation ----

handle('block', async (_e, { key }) => {
  if (!P.HEX64.test(key || '')) throw new Error('bad key')
  blocked.add(key); muted.delete(key)
  for (const [id, a] of discovered) if (a.author === key) discovered.delete(id)
  dmConvos.delete(key); saveDms(); saveMod(); saveCache()
  publishModlist().catch(() => {})
  return { blocked: [...blocked], muted: [...muted] }
})
handle('mute', async (_e, { key }) => {
  muted.add(key); saveMod()
  // the compass learns a little "less of this" from what they wrote
  for (const a of [...discovered.values()].filter(a => a.author === key).slice(-5)) learn(a.text, -0.4)
  return { blocked: [...blocked], muted: [...muted] }
})
handle('unblock', async (_e, { key }) => { blocked.delete(key); saveMod(); publishModlist().catch(() => {}); return { blocked: [...blocked], muted: [...muted] } })
handle('unmute', async (_e, { key }) => { muted.delete(key); saveMod(); return { blocked: [...blocked], muted: [...muted] } })
handle('moderation', async () => ({ blocked: [...blocked], muted: [...muted] }))

// ---- identity backup ----

handle('export-identity', async (e) => {
  if (e && e.web) throw new Error('only on the computer running Ember')
  const pk = store.primaryKey.toString('hex')
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Ember identity', defaultPath: 'ember-identity.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }]
  })
  if (canceled || !filePath) return false
  fs.writeFileSync(filePath, [
    'EMBER IDENTITY BACKUP — KEEP THIS SECRET, KEEP IT SAFE',
    'Anyone with this key IS you on the network. No recovery exists without it.',
    '',
    'PRIMARY KEY: ' + pk,
    'PUBLIC KEY : ' + hex(myCore.key),
    '',
    'To restore: SETUP > RESTORE IDENTITY on a fresh install, paste the primary key.'
  ].join('\n'))
  return true
})

handle('restore-identity', async (e, { primaryKey } = {}) => {
  if (e && e.web) throw new Error('only on the computer running Ember')
  if (!/^[0-9a-f]{64}$/.test((primaryKey || '').trim())) throw new Error('invalid key')
  // only allowed on a fresh identity (no posts yet) to avoid clobbering
  if (myCore.length > 1) return { ok: false, reason: 'not-fresh' }
  fs.writeFileSync(path.join(dataDir, 'RESTORE_KEY'), primaryKey.trim())
  app.relaunch(); app.quit()
  return { ok: true }
})

handle('dm-send', async (_e, { to, text }) => {
  if (!/^[0-9a-f]{64}$/.test(to) || !text || text.length > 450_000) throw new Error('bad dm')
  // authenticated key fetch: their DM key lives in their self-signed feed.
  // For strangers we must wait for the feed swarm to actually connect first.
  if (!peerEdPk.get(to)) {
    const core = feeds.get(to) || await openFeed(to)
    await feedSwarm.flush().catch(() => {})
    for (let tries = 0; tries < 3 && !peerEdPk.get(to); tries++) {
      await latestProfile(core)
      if (!peerEdPk.get(to)) await new Promise(r => setTimeout(r, 1500))
    }
  }
  const theirPk = peerEdPk.get(to)
  if (!theirPk) return { sent: false, reason: 'no-key' }
  dmSwarm.join(dm.inboxTopic(to), { server: true, client: true })
  await dmSwarm.flush().catch(() => {})
  const payload = { t: 'dm', from: hex(myCore.key), to, edpk: myEdPk, ts: Date.now(), mid: Date.now() + ':' + Math.random().toString(36).slice(2, 8), p: dm.seal(text, theirPk, myCurve.sk) }
  let sent = 0
  for (const s of dmSockets) {
    if (s.peerKey !== to) continue // only sockets that PROVED they are the recipient
    try { s.write(JSON.stringify(payload) + '\n'); sent++ } catch {}
  }
  if (!sent) { dmOutbox.push({ to, payload }); saveOutbox() } // queued: flushes when they appear
  if (!dmConvos.has(to)) dmConvos.set(to, [])
  dmConvos.get(to).push({ from: hex(myCore.key), to, text, ts: payload.ts, delivered: sent > 0 })
  saveDms()
  return { sent: sent > 0, queued: !sent }
})

handle('dm-open', async (_e, { key }) => {
  dmSwarm.join(dm.inboxTopic(key), { server: true, client: true }) // pre-join so replies flow
  return dmConvos.get(key) || []
})

handle('dm-list', async () => {
  if (!engineUp) return []
  return [...dmConvos.entries()].map(([k, msgs]) => ({
    key: k, last: msgs[msgs.length - 1] || null, count: msgs.length,
    request: !follows.has(k) && !dmAccepted.has(k) && msgs.some(x => x.from === k)
  })).sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0))
})

handle('dm-accept', async (_e, { key }) => { dmAccepted.add(key); saveAccepted(); return true })
handle('dm-ignore', async (_e, { key }) => { dmConvos.delete(key); saveDms(); return true })

// ---- saved posts ----

handle('save-post', async (_e, { author, seq }) => {
  const blk = await resolveBlock(author, seq)
  if (!blk || (blk.type !== 'post' && !blk.text)) throw new Error('cannot resolve post')
  // keep the author's signatures when we have them, so the copy we keep warm
  // still verifies on every peer it reaches instead of degrading to UNVERIFIED
  const orig = discovered.get(postId(author, seq))
  let a
  if (orig && orig.sig) a = { ...orig }
  else {
    a = { author, seq, ts: blk.ts, text: blk.text || '', kind: 'post', ref: null }
    if (blk.thumb) a.thumb = blk.thumb
    if (blk.mediaSeq != null) a.mediaSeq = blk.mediaSeq
  }
  saved.set(postId(author, seq), a)
  saveSaved()
  learn(a.text, 1.2)
  for (const s of gossipPeers) sendMsg(s, { t: 'ann', a }) // start keeping it warm immediately
  return [...saved.values()]
})

handle('unsave-post', async (_e, { author, seq }) => {
  saved.delete(postId(author, seq)); saveSaved(); return [...saved.values()]
})

handle('saved-list', async () => engineUp ? [...saved.values()].sort((a, b) => b.ts - a.ts) : [])

// ---- window controls (custom titlebar) ----

handle('win-min', () => win.minimize())
handle('win-max', () => win.isMaximized() ? win.unmaximize() : win.maximize())
handle('win-close', () => win.close())   // intercepted: hides to tray
// the page can't reload itself (navigation is locked); the language switch asks here
handle('reload-ui', () => { if (win && !win.isDestroyed()) win.webContents.reload() })

// ---- notifications ----

handle('notifs-list', async () => [...notifs].reverse())
handle('notifs-unread', async () => {
  const u = { reply: 0, dm: 0, post: 0, total: 0 }
  if (!engineUp) return u
  for (const n of notifs) if (!n.read) { u[n.type] = (u[n.type] || 0) + 1; u.total++ }
  return u
})
handle('notifs-mark-read', async (_e, { type }) => {
  for (const n of notifs) if (!type || n.type === type) n.read = true
  saveNotifs(); return true
})

// ---- settings ----

handle('get-settings', async () => {
  if (!dataDir) return { ...SETTINGS, storageBytes: 0, savedCount: 0, cacheCount: 0 }
  let storage = 0
  try {
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p); else { try { storage += fs.statSync(p).size } catch {} } } }
    walk(dataDir)
  } catch {}
  return { ...SETTINGS, storageBytes: storage, savedCount: saved.size, cacheCount: discovered.size }
})

handle('set-settings', async (_e, patch) => {
  const ok = {}
  if (typeof patch.theme === 'string' && ['paper','sepia','mist','carbon','slate','phosphor','ember'].includes(patch.theme)) ok.theme = patch.theme
  if (typeof patch.commons === 'boolean') ok.commons = patch.commons
  if (typeof patch.keepDmHistory === 'boolean') ok.keepDmHistory = patch.keepDmHistory
  if (Number.isInteger(patch.tailWindow) && patch.tailWindow >= 20 && patch.tailWindow <= 5000) ok.tailWindow = patch.tailWindow
  if (typeof patch.autostart === 'boolean') {
    ok.autostart = patch.autostart
    // the portable .exe runs from a temp folder that's gone next boot: point
    // autostart at the real file the user launched instead
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    app.setLoginItemSettings({ openAtLogin: patch.autostart, path: exe })
  }
  Object.assign(SETTINGS, ok); saveSettings()
  if ('commons' in ok) setCommons(ok.commons)
  if (!SETTINGS.keepDmHistory) { try { fs.unlinkSync(dmPath()) } catch {} }
  return SETTINGS
})

// ---- nearby (proximity in space, opt-in) ----

function startNearby () {
  let pending = null, firstHit = null
  nearby = new Nearby({
    me: () => ({ key: hex(myCore.key), edpk: myEdPk, name: myName }),
    sign: signMsg,
    verify: verifyMsg,
    knownEdPk: (k) => peerEdPk.get(k),
    isBlocked: (k) => blocked.has(k),
    swarmOpts,
    // coalesce: beacons arrive every few seconds per peer; the UI needs at most ~1 refresh/s
    onChange: (fresh) => {
      if (fresh && !firstHit) firstHit = { key: fresh.key, name: fresh.name }
      if (pending) return
      pending = setTimeout(() => { broadcast('near-updated', firstHit); pending = null; firstHit = null }, 700)
    }
  })
  applyNearby()
  buildTrayMenu()
}

// Bring the running channels in line with the saved choices. "Hide me from
// Nearby" wins over both, but keeps the choices so un-hiding restores them.
async function applyNearby () {
  if (!nearby) return
  const hidden = SETTINGS.nearHidden === true
  if (SETTINGS.nearLan && !hidden) nearby.startLan(); else nearby.stopLan()
  const a = SETTINGS.nearArea
  const want = a && typeof a.place === 'string' && !hidden
  const cur = nearby.area.cfg
  if (!want) await nearby.stopArea()
  else if (!nearby.area.on || !cur || cur.place !== a.place || cur.radius !== a.radius || cur.lat !== a.lat || cur.lon !== a.lon) await nearby.startArea(a).catch(() => {})
}
function nearState () {
  if (!engineUp || !nearby) return NEAR_OFF
  const a = SETTINGS.nearArea
  return { ...nearby.state(), hidden: SETTINGS.nearHidden === true, saved: { lan: SETTINGS.nearLan === true, area: a ? { place: a.place, lat: a.lat, lon: a.lon, radius: a.radius, source: a.source || 'typed' } : null } }
}
async function setNearHidden (h) {
  SETTINGS.nearHidden = h === true; saveSettings()
  await applyNearby(); buildTrayMenu()
  broadcast('near-updated', null)
  return nearState()
}

const NEAR_OFF = { lan: { on: false }, area: { on: false }, radii: disc.AREA_RADII, people: [], hidden: false, saved: { lan: false, area: null } }
const okCoords = (c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180
handle('near-state', async () => nearState())
handle('near-set-lan', async (_e, { on }) => {
  if (!nearby) return NEAR_OFF
  SETTINGS.nearLan = on === true; saveSettings()
  await applyNearby()
  return nearState()
})
handle('near-set-area', async (_e, cfg) => {
  if (!nearby) return NEAR_OFF
  if (!(cfg && typeof cfg.place === 'string' && cfg.place.length <= 80 && okCoords(cfg))) {
    SETTINGS.nearArea = null
  } else {
    const radius = disc.AREA_RADII.includes(cfg.radius) ? cfg.radius : 25
    const source = cfg.source === 'located' ? 'located' : 'typed'
    SETTINGS.nearArea = { place: cfg.place, lat: Math.round(cfg.lat * 100) / 100, lon: Math.round(cfg.lon * 100) / 100, radius, source }
  }
  saveSettings(); await applyNearby()
  return nearState()
})
// The PC's own location → nearest bundled town. The precise position never
// leaves this function: not to the page, not to disk, not to the network.
handle('near-locate', async (_e, { radius } = {}) => {
  if (!nearby) return { error: 'booting', state: NEAR_OFF }
  const town = await locateTown()
  if (town.error) return { error: town.error, state: nearState() }
  const r = disc.AREA_RADII.includes(radius) ? radius : ((SETTINGS.nearArea && SETTINGS.nearArea.radius) || 25)
  SETTINGS.nearArea = { place: town.place, lat: town.lat, lon: town.lon, radius: r, source: 'located' }
  saveSettings(); await applyNearby()
  return { town: { place: town.place, km: town.km }, state: nearState() }
})
handle('near-set-hidden', async (_e, { hidden }) => setNearHidden(hidden))
handle('near-search', async (_e, { q }) => searchPlaces(typeof q === 'string' ? q.slice(0, 80) : ''))

// ---- taste: topics, compass, dial, languages (v2.8) ----

function tasteState () {
  return {
    catalog: taste.CATALOG.map(t => ({ id: t.id, label: t.label })),
    langs: taste.LANGS,
    topics: SETTINGS.topics, topicText: SETTINGS.topicText, dial: SETTINGS.dial,
    onlyMyLangs: SETTINGS.onlyMyLangs === true, uiLang: SETTINGS.uiLang, readLangs: readLangs(),
    onboarded: SETTINGS.onboarded === true, campfires: SETTINGS.campfires !== false,
    terms: tasteStore ? tasteStore.top(24) : [], avoid: tasteStore ? tasteStore.avoid(8) : [],
    suggest: SETTINGS.topicText ? taste.classify(SETTINGS.topicText, 3) : []
  }
}
handle('taste-state', async () => tasteState())
handle('taste-set', async (_e, patch = {}) => {
  const ids = new Set(taste.CATALOG.map(t => t.id))
  if (Array.isArray(patch.topics)) SETTINGS.topics = [...new Set(patch.topics.filter(id => ids.has(id)))].slice(0, 12)
  if (typeof patch.topicText === 'string') SETTINGS.topicText = patch.topicText.slice(0, 280)
  if (Number.isInteger(patch.dial) && patch.dial >= 0 && patch.dial <= 3) SETTINGS.dial = patch.dial
  if (typeof patch.onlyMyLangs === 'boolean') SETTINGS.onlyMyLangs = patch.onlyMyLangs
  if (taste.LANGS.includes(patch.uiLang)) SETTINGS.uiLang = patch.uiLang
  if (Array.isArray(patch.readLangs)) { const l = [...new Set(patch.readLangs.filter(x => taste.LANGS.includes(x)))]; SETTINGS.readLangs = l.length ? l : null }
  if (typeof patch.onboarded === 'boolean') SETTINGS.onboarded = patch.onboarded
  if (typeof patch.campfires === 'boolean') SETTINGS.campfires = patch.campfires
  saveSettings()
  if (engineUp) syncRooms() // the page re-renders itself; this is not news
  return tasteState()
})
handle('taste-forget', async (_e, { term } = {}) => { if (tasteStore && typeof term === 'string') tasteStore.forget(term); if (engineUp) syncRooms(); return tasteState() })
handle('taste-reset', async () => { if (tasteStore) tasteStore.reset(); if (engineUp) syncRooms(); return tasteState() })
handle('not-interested', async (_e, { author, seq } = {}) => {
  if (!P.HEX64.test(author || '') || !Number.isInteger(seq)) return false
  const id = postId(author, seq)
  const a = discovered.get(id)
  notInterested.add(id); saveNotInterested()
  if (a) learn(a.text, -1.0)
  return true
})
// interface translations: src/i18n/{fr,zh,ar}.json (English is the source text)
handle('i18n', async (_e, { lang } = {}) => {
  if (!['fr', 'zh', 'ar'].includes(lang)) return null
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', lang + '.json'), 'utf8')) } catch { return null }
})

// ---- circle moderation (v2.8) ----
// Blocking stays personal. Optionally you PUBLISH your blocklist (a signed
// 'modlist' block in your own log). Others may SUBSCRIBE to it (it then hides
// those people for them), and the lists of people you follow act as a quiet
// signal: on two of them = hidden, on one = ranked down. Lists never hide
// someone you follow, and nothing here is ever enforced on anyone else.

// newest block of a type in a log; remote blocks outside the synced tail are
// fetched a few at a time, never chased forever
async function latestOf (core, type, depth = 400) {
  const floor = Math.max(0, core.length - depth)
  let misses = 0
  for (let i = core.length - 1; i >= floor; i--) {
    try {
      const local = await core.has(i)
      if (!local && core.writable) continue
      if (!local && ++misses > 15) break
      const blk = P.sanitizeBlock(await core.get(i, { timeout: local ? 1500 : 2500 }))
      if (blk && blk.type === type) return blk
    } catch {}
  }
  return null
}
let lastModlist = null
async function publishModlist (force) {
  if (!myCore || restorePending) return
  const keys = SETTINGS.publishBlocklist ? [...blocked].slice(0, 5000) : []
  if (lastModlist === null) { const b = await latestOf(myCore, 'modlist'); lastModlist = b ? b.keys.slice().sort().join() : '' }
  const sig = keys.slice().sort().join()
  if (!force && sig === lastModlist) return
  if (!SETTINGS.publishBlocklist && lastModlist === '' && !force) return // never published: nothing to retract
  await appendMine({ type: 'modlist', keys, ts: Date.now() })
  lastModlist = sig
}
// a replicated log only learns its owner's newest length when asked
const fresh = (core) => Promise.race([core.update({ wait: true }).catch(() => {}), new Promise(r => setTimeout(r, 3000))])
let circleBusy = false
async function refreshCircle () {
  if (!engineUp || circleBusy) return
  circleBusy = true
  try {
    const me = hex(myCore.key)
    const spare = (k) => follows.has(k) || k === me
    const fromSubs = new Set()
    for (const sub of SETTINGS.modSubs) {
      if (blocked.has(sub.key)) continue
      const core = feeds.get(sub.key) || await openFeed(sub.key)
      await fresh(core)
      const blk = await latestOf(core, 'modlist')
      if (blk) { for (const k of blk.keys) fromSubs.add(k); sub.count = blk.keys.length; sub.ts = blk.ts }
      if (!sub.name) { const p = await latestProfile(core).catch(() => null); if (p && p.name) sub.name = P.nearText(p.name, 40) }
    }
    const counts = new Map()
    if (SETTINGS.circleSignals) {
      for (const f of follows) {
        const core = feeds.get(f); if (!core || isHidden(f)) continue
        await fresh(core)
        const blk = await latestOf(core, 'modlist')
        if (blk) for (const k of blk.keys) counts.set(k, (counts.get(k) || 0) + 1)
      }
    }
    listHidden = new Set([...fromSubs].filter(k => !spare(k)))
    const hard = new Set(), soft = new Set()
    for (const [k, n] of counts) { if (spare(k) || listHidden.has(k)) continue; (n >= 2 ? hard : soft).add(k) }
    circleHidden = hard; circleSoft = soft
    saveSettings()
    broadcast('discover-updated', { fresh: false }); broadcast('mod-updated', null)
  } finally { circleBusy = false }
}
function modState () {
  return {
    publishBlocklist: SETTINGS.publishBlocklist === true, circleSignals: SETTINGS.circleSignals !== false,
    subs: SETTINGS.modSubs.map(s => ({ key: s.key, name: s.name || '', count: s.count || 0, ts: s.ts || 0 })),
    blocked: blocked.size, listHidden: listHidden.size, circleHidden: circleHidden.size, circleSoft: circleSoft.size
  }
}
handle('mod-state', async () => modState())
handle('mod-set', async (_e, patch = {}) => {
  let republish = false
  if (typeof patch.publishBlocklist === 'boolean' && patch.publishBlocklist !== SETTINGS.publishBlocklist) { SETTINGS.publishBlocklist = patch.publishBlocklist; republish = true }
  if (typeof patch.circleSignals === 'boolean') SETTINGS.circleSignals = patch.circleSignals
  saveSettings()
  if (republish) await publishModlist()
  refreshCircle()
  return modState()
})
handle('mod-sub', async (_e, { key } = {}) => {
  const k = P.cleanKey(key)
  if (!k) throw new Error('invalid key')
  if (k === hex(myCore.key)) throw new Error('that is your own key')
  if (!SETTINGS.modSubs.some(s => s.key === k)) { SETTINGS.modSubs.push({ key: k }); if (SETTINGS.modSubs.length > 20) SETTINGS.modSubs.shift() }
  saveSettings(); await refreshCircle()
  return modState()
})
handle('mod-unsub', async (_e, { key } = {}) => {
  SETTINGS.modSubs = SETTINGS.modSubs.filter(s => s.key !== key)
  saveSettings(); await refreshCircle()
  return modState()
})

// ---- campfires (v2.8) ----

function startFires () {
  let pending = null, lit = null
  const touched = new Set()
  fires = new Fires({
    me: () => ({ key: hex(myCore.key), edpk: myEdPk, name: myName }),
    sign: signMsg,
    verify: verifyMsg,
    knownEdPk: (k) => peerEdPk.get(k),
    hidden: (k) => isHidden(k),
    // what you're into stays on your machine: a fire shows its topic, not your compass
    terms: () => [],
    onChange: (ev) => {
      if (ev.lit) lit = ev.lit
      if (ev.fire) touched.add(ev.fire)
      if (pending) return
      pending = setTimeout(() => {
        broadcast('fires-updated', { lit, fires: [...touched] })
        pending = null; lit = null; touched.clear()
      }, 400)
    }
  })
  for (const s of gossipPeers) fires.attach(s)
}
handle('fires-list', async () => ({ on: SETTINGS.campfires !== false, fires: fires ? fires.list() : [] }))
handle('fire-messages', async (_e, { fire } = {}) => fires ? fires.messages(fire) : [])
handle('fire-send', async (_e, { fire, text } = {}) => {
  if (!fires) throw new Error('booting')
  const m = fires.send(fire, text)
  return m ? { ok: true } : { ok: false }
})

// ---- web access (v2.9) ----

function webCall (ch, args, ctx) {
  const fn = HANDLERS.get(ch)
  if (!fn) { const e = new Error('unknown call'); e.code = 'UNKNOWN_CHANNEL'; throw e }
  return fn({ web: true, session: ctx.session }, args)
}
function webState (e) {
  const st = web ? web.state() : { on: false, urls: [], devices: [], code: null }
  return { ...st, headless: HEADLESS, saved: SETTINGS.web, current: e && e.web ? e.session.id : null }
}
function webAnnounce (what) {
  broadcast('web-updated', { what })
  // headless: the console is where the operator reads the pairing code
  if (HEADLESS && web && web.server && what === 'code') {
    console.log(`\n  Pairing code: ${web.code.slice(0, 4)} ${web.code.slice(4)}   (single use; enter it at ${web.urls().join(' or ')})\n`)
  }
}
async function startWeb (opts) {
  if (!web) web = new Web({ dataDir, srcDir: __dirname, call: webCall, onChange: webAnnounce, codeTtl: HEADLESS ? Infinity : undefined })
  await web.start(opts)
  return web.state()
}
async function applyWeb () {
  if (HEADLESS) return
  const w = SETTINGS.web
  if (!w.on) { if (web) { await web.stop(); webAnnounce('state') } return }
  await startWeb({ port: w.port, host: w.lan ? '0.0.0.0' : '127.0.0.1' })
}
handle('web-state', async (e) => webState(e))
handle('web-set', async (e, patch = {}) => {
  if (e && e.web) throw new Error('only on the computer running Ember')
  const w = SETTINGS.web
  if (typeof patch.on === 'boolean') w.on = patch.on
  if (typeof patch.lan === 'boolean') w.lan = patch.lan
  if (Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535) w.port = patch.port
  saveSettings(); await applyWeb()
  return webState(e)
})
handle('web-new-code', async (e) => { if (web && web.server) web.rotate(); return webState(e) })
handle('web-revoke', async (e, { id } = {}) => { if (web) web.revoke(id); return webState(e) })
handle('web-open', async (e) => {
  if (e && e.web) throw new Error('only on the computer running Ember')
  if (!web || !web.server) return false
  // the code rides in the URL fragment: it never reaches a server log or a proxy
  require('electron').shell.openExternal(`${web.urls()[0]}/#code=${web.currentCode()}`)
  return true
})

handle('clear-cache', async () => {
  discovered.clear(); saveCache(); return true
})

// ---------- window ----------

function trayIcon () {
  // 16x16 diamond, drawn raw RGBA — no asset file needed
  const S = 16, buf = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5)
    const on = d <= 7 && d >= 4.6
    const i = (y * S + x) * 4
    buf[i] = buf[i+1] = buf[i+2] = 20; buf[i+3] = on ? 255 : 0
  }
  return nativeImage.createFromBuffer(buf, { width: S, height: S })
}

function buildTrayMenu () {
  if (!tray) return
  const nearOn = !!nearby && (SETTINGS.nearLan || !!SETTINGS.nearArea)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Ember', click: () => { win.show(); win.focus() } },
    { type: 'separator' },
    // one click to disappear from Nearby, from anywhere, without opening the app
    { label: 'Hide me from Nearby', type: 'checkbox', checked: SETTINGS.nearHidden === true, enabled: !!nearby,
      sublabel: nearOn ? undefined : 'Nearby is off', click: (item) => { setNearHidden(item.checked) } },
    { type: 'separator' },
    { label: 'Quit (go offline)', click: () => { quitting = true; app.quit() } }
  ]))
}

function createTray () {
  tray = new Tray(trayIcon())
  tray.setToolTip('Ember — online, broadcasting')
  buildTrayMenu()
  tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()) })
}

function createWindow () {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: '#e9e7e2',
    frame: false,                       // Ember draws its own titlebar
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
    }
  })
  // the window may only ever show our own page: block navigation (e.g. a file
  // dropped on the window), webviews, and every permission except mic + notifs
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'notifications'))
  win.loadFile(path.join(__dirname, 'index.html'))
  const { shell } = require('electron')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // closing the window hides to tray: the node keeps replicating + gossiping
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })
}

async function startHeadless () {
  const opt = host.options
  dataDir = path.join(app.getPath('userData'), 'ember-data')
  fs.mkdirSync(dataDir, { recursive: true })
  loadSettings()
  if (opt.restoreKey) {
    if (!/^[0-9a-f]{64}$/.test(opt.restoreKey)) { console.error('--restore needs the 64-character primary key'); process.exit(1) }
    if (fs.existsSync(path.join(dataDir, 'CORESTORE'))) { console.error(`--restore only works on an empty data folder (${dataDir})`); process.exit(1) }
    fs.writeFileSync(path.join(dataDir, 'RESTORE_KEY'), opt.restoreKey)
  }
  try { await startEngine() } catch (e) { console.error('Ember failed to start:', (e && e.stack) || e); process.exit(1) }
  engineUp = true
  if (opt.exportIdentity) {
    console.log(['EMBER IDENTITY BACKUP: KEEP THIS SECRET. Anyone with it IS you on the network.', '',
      'PRIMARY KEY: ' + store.primaryKey.toString('hex'), 'PUBLIC KEY : ' + hex(myCore.key), '',
      'Restore on a new server: npm run serve -- --data <empty folder> --restore <PRIMARY KEY>'].join('\n'))
    app.quit(); return
  }
  console.log(`\n  EMBER is running headless.  Data: ${dataDir}\n  Key:  ${hex(myCore.key)}`)
  await startWeb({ port: opt.port, host: opt.host, allowHosts: opt.allowHosts })
  if (!web.server) { console.error('  Web interface could not start: ' + web.error); process.exit(1) }
  if (opt.host === '0.0.0.0' || opt.host === '::') console.log('  Listening on every network interface over plain HTTP: put it behind HTTPS before exposing it to the internet.')
}

app.whenReady().then(async () => {
  if (HEADLESS) return startHeadless()
  // settings before the window, so the page knows its language at first paint
  try { dataDir = path.join(app.getPath('userData'), 'ember-data'); fs.mkdirSync(dataDir, { recursive: true }); loadSettings() } catch {}
  // window first: boot must never be able to leave the user staring at nothing
  createWindow(); createTray()
  try {
    await startEngine()
    engineUp = true
    broadcast('engine-ready', true)
    applyWeb().catch(() => {})
  } catch (e) {
    dialog.showErrorBox('Ember failed to start',
      String((e && e.stack) || e) + '\n\nYour data is untouched. Send this to the developer.')
  }
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { /* stay alive in tray; engine keeps broadcasting */ })
app.on('quit', async () => {
  saveCache(); saveDms(); saveSaved(); saveSettings(); saveNotifs(); saveAccepted(); saveMod(); saveOutbox()
  try { if (web) await web.stop(); if (nearby) await nearby.destroy(); await feedSwarm.destroy(); await gossipSwarm.destroy(); await dmSwarm.destroy() } catch {}
})
