// EMBER — main process
// Two network layers:
//   1. FEED layer   — Corestore + Hyperswarm: signed append-only logs, replication, re-seeding.
//   2. GOSSIP layer — a second Hyperswarm whose topics come from LSH codes (discovery)
//                     and per-post rendezvous hashes (replies). Connections exchange
//                     newline-delimited JSON announcements.
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog } = require('electron')
Menu.setApplicationMenu(null)
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
let SETTINGS = { theme: 'paper', tailWindow: 150, commons: true, keepDmHistory: true, nearLan: false, nearArea: null, nearHidden: false }
let nearby = null              // proximity in space (nearby.js); both channels opt-in
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
    broadcast('discover-updated')
  }
  saveCache()
  // relay once to other gossip peers (epidemic spread within bucket)
  for (const s of gossipPeers) sendMsg(s, { t: 'ann', a: clean })
}

function setupGossip () {
  gossipSwarm = new Hyperswarm()
  gossipSwarm.on('connection', (socket) => {
    gossipPeers.add(socket)
    socket.on('close', () => gossipPeers.delete(socket))
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
          else if (msg.t === 'hello') {
            // delta sync: send only announcements newer than the peer's watermark
            const since = typeof msg.since === 'number' ? msg.since : 0
            const missing = [...discovered.values()].filter(a => a.ts > since).slice(-200)
            for (const a of missing) sendMsg(socket, { t: 'ann', a })
            for (const a of saved.values()) if (a.ts > since) sendMsg(socket, { t: 'ann', a }) // saved stay warm through you
            for (const m of replies.values()) for (const a of [...m.values()].slice(-20)) if (a.ts > since) sendMsg(socket, { t: 'ann', a })
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
  dmSwarm = new Hyperswarm()
  dmSwarm.on('connection', (socket) => {
    dmSockets.add(socket)
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

// Re-derive which discovery buckets we should live in from our recent posts + follows' posts.
async function refreshInterests () {
  const texts = []
  for (const [k, core] of feeds) {
    if (k !== hex(myCore.key) && !follows.has(k)) continue
    const start = Math.max(0, core.length - 20)
    for (let i = start; i < core.length; i++) {
      try { const b = await core.get(i, { timeout: 1500 }); if (b.type === 'post') texts.push(b.text) } catch {}
    }
  }
  const topicSet = new Map()
  for (const t of texts.slice(-40)) {
    for (const topic of disc.topicsForText(t)) topicSet.set(hex(topic), topic)
  }
  for (const [, topic] of topicSet) joinGossip(topic, 'disc')
  if (SETTINGS.commons) joinGossip(disc.commonsTopic(), 'commons') // small-network rendezvous
  broadcast('buckets', gossipTopics.size)
}

// ---------- feed engine (unchanged core) ----------

async function startEngine () {
  dataDir = path.join(app.getPath('userData'), 'ember-data')
  fs.mkdirSync(dataDir, { recursive: true })
  loadCache()
  const restoreFile = path.join(dataDir, 'RESTORE_KEY')
  let primaryKey = null
  if (fs.existsSync(restoreFile)) {
    try {
      primaryKey = b4a.from(fs.readFileSync(restoreFile, 'utf8').trim(), 'hex')
      // wipe the old store so the restored identity starts clean
      for (const f of ['db', 'cores', 'CORESTORE', 'primary-key']) {
        try { fs.rmSync(path.join(dataDir, f), { recursive: true, force: true }) } catch {}
      }
      fs.unlinkSync(restoreFile)
    } catch { primaryKey = null }
  }
  store = primaryKey ? new Corestore(dataDir, { primaryKey, unsafe: true }) : new Corestore(dataDir)
  feedSwarm = new Hyperswarm()
  feedSwarm.on('connection', (socket) => {
    store.replicate(socket)
    broadcast('peers', feedSwarm.connections.size)
    socket.on('close', () => broadcast('peers', feedSwarm.connections.size))
  })
  setupGossip()

  myCore = store.get({ name: 'ember-self', valueEncoding: 'json' })
  await myCore.ready()
  myCurve = dm.curveKeys(myCore.keyPair)
  myEdPk = b4a.toString(myCore.keyPair.publicKey, 'hex')
  loadSettings(); loadDms(); loadSaved(); loadNotifs(); loadAccepted(); loadMod(); loadOutbox(); loadWatched()
  setupDm()
  feeds.set(hex(myCore.key), myCore)
  feedSwarm.join(myCore.discoveryKey, { server: true, client: true })

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
    await myCore.append({
      type: 'profile',
      name: (prof && prof.name) || '', status: (prof && prof.status) || '', bio: (prof && prof.bio) || '',
      ...(prof && prof.avatar ? { avatar: prof.avatar } : {}),
      dmKey: myEdPk, ts: Date.now()
    })
  }
  myName = (prof && prof.name) || ''
  startNearby()
  refreshInterests()
  setInterval(refreshInterests, 60_000)
  // auto-commons: once proximity buckets alone sustain enough peers, leave the
  // global rendezvous (less noise, pure meaning-space); rejoin if we go quiet.
  let commonsJoined = SETTINGS.commons
  setInterval(async () => {
    if (!SETTINGS.commons) return // user override wins
    const peers = gossipPeers.size
    if (commonsJoined && peers >= 10) {
      try { await gossipSwarm.leave(disc.commonsTopic()); commonsJoined = false
        broadcast('commons-state', false) } catch {}
    } else if (!commonsJoined && peers < 4) {
      joinGossip(disc.commonsTopic(), 'commons'); commonsJoined = true
      broadcast('commons-state', true)
    }
  }, 90_000)
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
  core.on('append', async () => {
    broadcast('feed-updated', hexKey); tailSync(core)
    if (follows.has(hexKey)) {
      try {
        const blk = await core.get(core.length - 1, { timeout: 3000 })
        if (blk.type === 'post') pushNotif({ type: 'post', from: hexKey, ts: blk.ts, text: (blk.text || '').slice(0, 140), ref: { author: hexKey, seq: core.length - 1 } })
      } catch {}
    }
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

function broadcast (ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }

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

ipcMain.handle('me', async () => {
  if (!engineUp || !myCore) return { key: '', length: 0, profile: null, booting: true }
  return { key: hex(myCore.key), length: myCore.length, profile: await latestProfile(myCore) }
})

ipcMain.handle('post', async (_e, { text, image, thumb, quoteRef }) => {
  let mediaSeq = null
  if (image && typeof image === 'string' && image.length < 30_000_000) {
    await myCore.append({ type: 'media', data: image, ts: Date.now() })
    mediaSeq = myCore.length - 1
  }
  const block = { type: quoteRef ? 'quote' : 'post', text, ts: Date.now() }
  if (quoteRef && /^[0-9a-f]{64}$/.test(quoteRef.author) && typeof quoteRef.seq === 'number') block.ref = { author: quoteRef.author, seq: quoteRef.seq }
  if (mediaSeq !== null) { block.mediaSeq = mediaSeq; block.thumb = (thumb || '').slice(0, 8000) }
  await myCore.append(block)
  const seq = myCore.length - 1
  for (const topic of disc.topicsForText(text)) joinGossip(topic, 'disc')
  joinGossip(disc.replyTopic(hex(myCore.key), seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, seq)
  broadcast('feed-updated', hex(myCore.key))
  return seq
})

// full-resolution media, fetched on demand while a holder is online
ipcMain.handle('get-media', async (_e, { author, seq }) => {
  const blk = await resolveBlock(author, seq)
  return blk && blk.type === 'media' ? blk.data : null
})

ipcMain.handle('resolve-block', async (_e, { author, seq }) => resolveBlock(author, seq))

ipcMain.handle('reply', async (_e, { author, seq, text }) => {
  const block = { type: 'reply', text, ref: { author, seq }, ts: Date.now() }
  await myCore.append(block)
  const mySeq = myCore.length - 1
  joinGossip(disc.replyTopic(author, seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, mySeq)
  return mySeq
})

ipcMain.handle('get-replies', async (_e, { author, seq }) => {
  joinGossip(disc.replyTopic(author, seq), 'reply') // subscribe on view
  const m = replies.get(postId(author, seq))
  return m ? [...m.values()].filter(r => !blocked.has(r.author) && !muted.has(r.author)).sort((a, b) => a.ts - b.ts) : []
})

ipcMain.handle('set-profile', async (_e, { name, bio, status, avatar }) => {
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
  await myCore.append(blk); myName = blk.name || ''; return true
})

ipcMain.handle('follow', async (_e, { key }) => {
  const raw = key
  key = P.cleanKey(key)
  if (!key) throw new Error(`invalid key — expected 64 hex characters, got: ${String(raw).trim().slice(0, 40)}`)
  if (key === hex(myCore.key) || follows.has(key)) return [...follows]
  await myCore.append({ type: 'follow', key, ts: Date.now() })
  follows.add(key); await openFeed(key); refreshInterests()
  return [...follows]
})

ipcMain.handle('unfollow', async (_e, { key }) => {
  key = P.cleanKey(key) || key
  if (!follows.has(key)) return [...follows]
  await myCore.append({ type: 'unfollow', key, ts: Date.now() })
  follows.delete(key); return [...follows]
})

ipcMain.handle('timeline', async () => {
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

ipcMain.handle('discover', async (_e, { query }) => {
  // If a query is given, rank the gossip cache by cosine proximity; else recency.
  let list = [...discovered.values()].filter(a => a.author !== hex(myCore.key) && !blocked.has(a.author) && !muted.has(a.author))
  if (query && query.trim()) {
    const qv = disc.embed(query)
    // multi-probe: join the query's primary buckets AND their 1-bit neighbors
    for (const topic of disc.probeTopicsForText(query)) joinGossip(topic, 'disc')
    const now = Date.now()
    list = list.map(a => {
      const cos = disc.cosine(qv, disc.embed(a.text))
      const rec = Math.exp(-(now - a.ts) / (3 * 86_400_000)) // 3-day half-ish decay
      return { ...a, score: cos, rank: 0.78 * cos + 0.22 * rec }
    }).sort((a, b) => b.rank - a.rank)
  } else {
    list = list.sort((a, b) => b.ts - a.ts)
  }
  return { items: list.slice(0, 100), buckets: gossipTopics.size, gossipPeers: gossipPeers.size }
})

ipcMain.handle('profile-page', async (_e, { key }) => {
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

ipcMain.handle('repost', async (_e, { author, seq }) => {
  await myCore.append({ type: 'repost', ref: { author, seq }, ts: Date.now() }); return true
})

// ---- delete (tombstone + local clear + gossip purge) ----

ipcMain.handle('delete-post', async (_e, { seq }) => {
  if (!Number.isInteger(seq) || seq < 0 || seq >= myCore.length) throw new Error('bad seq')
  let media = null
  try {
    if (!(await myCore.has(seq))) return true // already gone
    const blk = await myCore.get(seq, { timeout: 1500 })
    if (!blk || !['post', 'quote', 'repost'].includes(blk.type)) throw new Error('not a post') // never tombstone profiles/media by accident
    if (blk.mediaSeq != null) media = blk.mediaSeq
  } catch (e) { if (e.message === 'not a post') throw e }
  await myCore.append({ type: 'delete', ref: { seq }, ts: Date.now() })
  try { await myCore.clear(seq, seq + 1) } catch {}                    // stop serving the content
  if (media != null) { try { await myCore.clear(media, media + 1) } catch {} }
  const id = postId(hex(myCore.key), seq)
  discovered.delete(id); replies.delete(id); saveCache()
  // gossip the tombstone so peers purge caches + clear replicated blocks
  const dts = Date.now()
  const delMsg = { t: 'del', a: { author: hex(myCore.key), seq, ts: dts, edpk: myEdPk, sig: signMsg(P.delMsg(hex(myCore.key), seq, dts)) } }
  for (const s of gossipPeers) sendMsg(s, delMsg)
  broadcast('feed-updated', hex(myCore.key))
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
  broadcast('discover-updated'); broadcast('feed-updated', a.author)
}

// ---- video: chunked blocks + watch-to-seed warm cache ----

// Transcode any input to a lean 720p/CRF-28 mp4, then chunk into the core.
// ffmpeg is bundled — no input format or size restrictions.
ipcMain.handle('post-video', async (_e, { inputPath, text, thumb }) => {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('no input')
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
  for (const c of chunks) await myCore.append({ type: 'vchunk', d: c })
  const videoMeta = { start, count: chunks.length, mime: 'video/mp4', size: buf.length }
  const block = { type: 'post', text: text || '', ts: Date.now(), videoMeta, thumb: (thumb || '').slice(0, 20000) }
  await myCore.append(block)
  const seq = myCore.length - 1
  for (const topic of disc.topicsForText(text || 'video')) joinGossip(topic, 'disc')
  joinGossip(disc.replyTopic(hex(myCore.key), seq), 'reply')
  await gossipSwarm.flush().catch(() => {})
  announceOwn(block, seq)
  broadcast('feed-updated', hex(myCore.key))
  return { seq, size: buf.length, chunks: chunks.length }
})

// Fetch + assemble a video. Fetched chunks are Hypercore-replicated blocks:
// from this moment this client SEEDS them to other peers (watch-to-seed).
// The range is recorded in the warm cache: protected from tail eviction,
// re-seeded across restarts, evicted only by the LRU byte budget.
ipcMain.handle('get-video', async (_e, { author, meta }) => {
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

ipcMain.handle('warm-cache-stats', async () => ({
  bytes: watchedBytes(), budget: WATCH_BUDGET,
  items: [...watched.values()].reduce((n, r) => n + r.length, 0)
}))

// ---- stories (24h ephemeral image blocks in your own core) ----

ipcMain.handle('post-story', async (_e, { image, caption }) => {
  if (!image || typeof image !== 'string' || image.length > 300_000) throw new Error('bad story')
  await myCore.append({ type: 'story', data: image, caption: (caption || '').slice(0, 140), ts: Date.now() })
  broadcast('feed-updated', hex(myCore.key))
  return true
})

ipcMain.handle('stories', async () => {
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

ipcMain.handle('get-story', async (_e, { author, seq }) => {
  const blk = await resolveBlock(author, seq)
  return blk && blk.type === 'story' ? { data: blk.data, caption: blk.caption, ts: blk.ts } : null
})

// ---- moderation ----

ipcMain.handle('block', async (_e, { key }) => {
  blocked.add(key); muted.delete(key)
  for (const [id, a] of discovered) if (a.author === key) discovered.delete(id)
  dmConvos.delete(key); saveDms(); saveMod(); saveCache()
  return { blocked: [...blocked], muted: [...muted] }
})
ipcMain.handle('mute', async (_e, { key }) => { muted.add(key); saveMod(); return { blocked: [...blocked], muted: [...muted] } })
ipcMain.handle('unblock', async (_e, { key }) => { blocked.delete(key); saveMod(); return { blocked: [...blocked], muted: [...muted] } })
ipcMain.handle('unmute', async (_e, { key }) => { muted.delete(key); saveMod(); return { blocked: [...blocked], muted: [...muted] } })
ipcMain.handle('moderation', async () => ({ blocked: [...blocked], muted: [...muted] }))

// ---- identity backup ----

ipcMain.handle('export-identity', async () => {
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

ipcMain.handle('restore-identity', async (_e, { primaryKey }) => {
  if (!/^[0-9a-f]{64}$/.test((primaryKey || '').trim())) throw new Error('invalid key')
  // only allowed on a fresh identity (no posts yet) to avoid clobbering
  if (myCore.length > 1) return { ok: false, reason: 'not-fresh' }
  fs.writeFileSync(path.join(dataDir, 'RESTORE_KEY'), primaryKey.trim())
  app.relaunch(); app.quit()
  return { ok: true }
})

ipcMain.handle('dm-send', async (_e, { to, text }) => {
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

ipcMain.handle('dm-open', async (_e, { key }) => {
  dmSwarm.join(dm.inboxTopic(key), { server: true, client: true }) // pre-join so replies flow
  return dmConvos.get(key) || []
})

ipcMain.handle('dm-list', async () => {
  if (!engineUp) return []
  return [...dmConvos.entries()].map(([k, msgs]) => ({
    key: k, last: msgs[msgs.length - 1] || null, count: msgs.length,
    request: !follows.has(k) && !dmAccepted.has(k) && msgs.some(x => x.from === k)
  })).sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0))
})

ipcMain.handle('dm-accept', async (_e, { key }) => { dmAccepted.add(key); saveAccepted(); return true })
ipcMain.handle('dm-ignore', async (_e, { key }) => { dmConvos.delete(key); saveDms(); return true })

// ---- saved posts ----

ipcMain.handle('save-post', async (_e, { author, seq }) => {
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
  for (const s of gossipPeers) sendMsg(s, { t: 'ann', a }) // start keeping it warm immediately
  return [...saved.values()]
})

ipcMain.handle('unsave-post', async (_e, { author, seq }) => {
  saved.delete(postId(author, seq)); saveSaved(); return [...saved.values()]
})

ipcMain.handle('saved-list', async () => engineUp ? [...saved.values()].sort((a, b) => b.ts - a.ts) : [])

// ---- window controls (custom titlebar) ----

ipcMain.handle('win-min', () => win.minimize())
ipcMain.handle('win-max', () => win.isMaximized() ? win.unmaximize() : win.maximize())
ipcMain.handle('win-close', () => win.close())   // intercepted: hides to tray

// ---- notifications ----

ipcMain.handle('notifs-list', async () => [...notifs].reverse())
ipcMain.handle('notifs-unread', async () => {
  const u = { reply: 0, dm: 0, post: 0, total: 0 }
  if (!engineUp) return u
  for (const n of notifs) if (!n.read) { u[n.type] = (u[n.type] || 0) + 1; u.total++ }
  return u
})
ipcMain.handle('notifs-mark-read', async (_e, { type }) => {
  for (const n of notifs) if (!type || n.type === type) n.read = true
  saveNotifs(); return true
})

// ---- settings ----

ipcMain.handle('get-settings', async () => {
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

ipcMain.handle('set-settings', async (_e, patch) => {
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
  if ('commons' in ok) {
    if (ok.commons) joinGossip(disc.commonsTopic(), 'commons')
    // leaving requires restart in V1 (swarm.leave is async and topic refcounts are simple); documented in UI
  }
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
ipcMain.handle('near-state', async () => nearState())
ipcMain.handle('near-set-lan', async (_e, { on }) => {
  if (!nearby) return NEAR_OFF
  SETTINGS.nearLan = on === true; saveSettings()
  await applyNearby()
  return nearState()
})
ipcMain.handle('near-set-area', async (_e, cfg) => {
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
ipcMain.handle('near-locate', async (_e, { radius } = {}) => {
  if (!nearby) return { error: 'booting', state: NEAR_OFF }
  const town = await locateTown()
  if (town.error) return { error: town.error, state: nearState() }
  const r = disc.AREA_RADII.includes(radius) ? radius : ((SETTINGS.nearArea && SETTINGS.nearArea.radius) || 25)
  SETTINGS.nearArea = { place: town.place, lat: town.lat, lon: town.lon, radius: r, source: 'located' }
  saveSettings(); await applyNearby()
  return { town: { place: town.place, km: town.km }, state: nearState() }
})
ipcMain.handle('near-set-hidden', async (_e, { hidden }) => setNearHidden(hidden))
ipcMain.handle('near-search', async (_e, { q }) => searchPlaces(typeof q === 'string' ? q.slice(0, 80) : ''))

ipcMain.handle('clear-cache', async () => {
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

app.whenReady().then(async () => {
  // window first: boot must never be able to leave the user staring at nothing
  createWindow(); createTray()
  try {
    await startEngine()
    engineUp = true
    broadcast('engine-ready', true)
  } catch (e) {
    dialog.showErrorBox('Ember failed to start',
      String((e && e.stack) || e) + '\n\nYour data is untouched. Send this to the developer.')
  }
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { /* stay alive in tray; engine keeps broadcasting */ })
app.on('quit', async () => {
  saveCache(); saveDms(); saveSaved(); saveSettings(); saveNotifs(); saveAccepted(); saveMod(); saveOutbox()
  try { if (nearby) await nearby.destroy(); await feedSwarm.destroy(); await gossipSwarm.destroy(); await dmSwarm.destroy() } catch {}
})
