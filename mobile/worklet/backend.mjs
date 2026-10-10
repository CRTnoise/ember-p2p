// EMBER MOBILE ENGINE — runs inside the bare-kit worklet (a real Bare runtime).
// This is desktop main.js, minus Electron: same cores, same swarms, same gossip,
// same signatures. RPC over worklet IPC mirrors the desktop IPC names 1:1.
/* global Bare, BareKit */
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import fs from 'bare-fs'
import { join } from 'bare-path'
import sodium from 'sodium-universal'
import crypto from 'bare-crypto'
import * as disc from './discovery.mjs'
import * as dm from './dm.mjs'
import * as P from './protocol.mjs'

const DATA_DIR = join(Bare.argv[0] || '/data/ember', 'ember-data') // documentsDir passed as arg
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}

// ---------------- state ----------------
let store, feedSwarm, gossipSwarm, dmSwarm, myCore, myCurve, myEdPk
const feeds = new Map()
const follows = new Set()
const gossipTopics = new Map()
const gossipPeers = new Set()
const discovered = new Map()
const replies = new Map()
const dmSockets = new Set()
const dmConvos = new Map()
const dmOutbox = []
const dmSeen = new Map()
const dmAccepted = new Set()
const saved = new Map()
const notifs = []
const blocked = new Set()
const muted = new Set()
const peerEdPk = new Map()
let SETTINGS = { theme: 'paper', tailWindow: 80, commons: true, keepDmHistory: true }
let engineUp = false

const hex = (buf) => b4a.toString(buf, 'hex')
const postId = (a, s) => `${a}:${s}`

// ---------------- persistence ----------------
const jpath = (n) => join(DATA_DIR, n + '.json')
function loadJ (n, fallback) { try { return JSON.parse(fs.readFileSync(jpath(n), 'utf8')) } catch { return fallback } }
function saveJ (n, v) { try { fs.writeFileSync(jpath(n), JSON.stringify(v)) } catch {} }
function persistAll () {
  saveJ('settings', SETTINGS)
  saveJ('gossip-cache', [...discovered.values()].slice(-500))
  saveJ('saved', [...saved.values()])
  saveJ('notifs', notifs.slice(-200))
  saveJ('moderation', { blocked: [...blocked], muted: [...muted] })
  saveJ('dm-accepted', [...dmAccepted])
  saveJ('dm-outbox', dmOutbox.slice(-200))
  if (SETTINGS.keepDmHistory) saveJ('dm-history', [...dmConvos.entries()])
}

// ---------------- RPC over IPC (newline JSON) ----------------
const { IPC } = BareKit
let ipcBuf = ''
IPC.on('data', (chunk) => {
  ipcBuf += b4a.toString(chunk)
  let nl
  while ((nl = ipcBuf.indexOf('\n')) >= 0) {
    const line = ipcBuf.slice(0, nl); ipcBuf = ipcBuf.slice(nl + 1)
    handleRpc(line)
  }
})
function send (obj) { try { IPC.write(b4a.from(JSON.stringify(obj) + '\n')) } catch {} }
function emit (ev, data) { send({ ev, data }) }
async function handleRpc (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const fn = handlers[msg.cmd]
  if (!fn) return send({ id: msg.id, ok: false, err: 'no such cmd' })
  try { send({ id: msg.id, ok: true, data: await fn(msg.args || {}) }) }
  catch (e) { send({ id: msg.id, ok: false, err: String((e && e.message) || e) }) }
}

// ---------------- helpers (ported, hole-tolerant everywhere) ----------------
function pushNotif (n) {
  n.id = Date.now() + ':' + Math.random().toString(36).slice(2, 7)
  n.read = false
  notifs.push(n); if (notifs.length > 200) notifs.splice(0, notifs.length - 200)
  saveJ('notifs', notifs.slice(-200))
  emit('notif', { type: n.type, text: (n.text || '').slice(0, 80), from: n.from })
}

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
    if (known) return known === a.edpk ? 'verified' : 'forged'
    return 'tofu'
  } catch { return 'forged' }
}

function allowMsg (socket) {
  const now = Date.now()
  if (!socket._rl) socket._rl = { tokens: 60, ts: now, dropped: 0 }
  const rl = socket._rl
  rl.tokens = Math.min(60, rl.tokens + (now - rl.ts) * 0.02); rl.ts = now
  if (rl.tokens < 1) { rl.dropped++; if (rl.dropped > 2000) socket.destroy(); return false }
  rl.tokens--; return true
}

function sendSock (socket, msg) { try { socket.write(JSON.stringify(msg) + '\n') } catch {} }

function tailSync (core) {
  const start = Math.max(0, core.length - (SETTINGS.tailWindow || 150))
  core.download({ start, end: core.length })
  if (start > 0) core.clear(0, start).catch(() => {})
}

async function openFeed (hexKey) {
  if (feeds.has(hexKey)) return feeds.get(hexKey)
  const core = store.get({ key: b4a.from(hexKey, 'hex'), valueEncoding: 'json' })
  await core.ready()
  feeds.set(hexKey, core)
  feedSwarm.join(core.discoveryKey, { server: true, client: true })
  let dTimer = null
  core.on('download', () => {           // blocks arriving from peers -> refresh the list
    clearTimeout(dTimer)
    dTimer = setTimeout(() => emit('feed-updated', hexKey), 500)
  })
  core.on('append', async () => {
    emit('feed-updated', hexKey); tailSync(core)
    if (follows.has(hexKey)) {
      try {
        const blk = await core.get(core.length - 1, { timeout: 3000 })
        if (blk.type === 'post') pushNotif({ type: 'post', from: hexKey, ts: blk.ts, text: (blk.text || '').slice(0, 140) })
      } catch {}
    }
  })
  tailSync(core)
  return core
}

// MOBILE RULE: never block the UI on the network. Read ONLY blocks already on
// disk; replication fills the rest in the background and fires 'download',
// which pushes a feed-updated event so the list grows as data arrives.
// Feed scans are the hot path. Two rules:
//  1. only read blocks already on disk (never wait on the network)
//  2. NEVER carry media payloads out of the scan — a single post can hold a
//     multi-MB base64 image, and shipping those over RPC is what froze the UI.
function stripHeavy (blk) {
  if (!blk) return blk
  if (blk.type === 'media' || blk.type === 'story' || blk.type === 'vchunk') return null
  if (blk.data) { const { data, ...rest } = blk; return rest }
  return blk
}

async function readFeed (core, max = 80) {
  const out = []; const deleted = new Set()
  const start = Math.max(0, core.length - max)
  for (let i = core.length - 1; i >= start; i--) {
    if (deleted.has(i)) continue
    try {
      if (!(await core.has(i))) continue
      const blk = P.sanitizeBlock(await core.get(i, { timeout: 1000 }))
      if (!blk) continue
      if (blk.type === 'delete') { deleted.add(blk.ref.seq); continue }
      const light = stripHeavy(blk)
      if (light) out.push({ seq: i, author: hex(core.key), ...light })
    } catch {}
  }
  return out.filter(b => !deleted.has(b.seq))
}

// Explicitly pull a single block that isn't local yet (media, stories, quoted
// posts). Used only where the user ASKED for it, so waiting is acceptable.
async function fetchBlock (core, seq, ms = 25000) {
  const blk = await fetchRawBlock(core, seq, ms)
  const clean = P.sanitizeBlock(blk)
  if (!clean) throw new Error('unreadable block')
  return clean
}
async function fetchRawBlock (core, seq, ms) {
  if (await core.has(seq)) return core.get(seq, { timeout: 2000 })
  const range = core.download({ start: seq, end: seq + 1 })
  await Promise.race([
    range.done(),
    new Promise(r => setTimeout(r, ms))
  ]).catch(() => {})
  try { range.destroy() } catch {}
  if (!(await core.has(seq))) throw new Error('no holder online')
  return core.get(seq, { timeout: 3000 })
}

const profileCache = new Map()   // author -> { at: core.length, profile }

// A stale name means we read an OLD profile block because the new one hadn't
// replicated. Profile blocks are tiny, so for remote cores we actively fetch
// the newest one instead of silently falling back to history.
async function freshProfile (core) {
  const k = hex(core.key)
  const cached = profileCache.get(k)
  if (cached && cached.at === core.length) return cached.profile
  let prof = await latestProfile(core)
  if (!core.writable) {
    // look for a newer profile block that simply hasn't downloaded yet
    const floor = Math.max(0, core.length - 40)
    for (let i = core.length - 1; i >= floor; i--) {
      if (await core.has(i)) continue
      try {
        const blk = await fetchBlock(core, i, 4000)
        if (blk && blk.type === 'profile') {
          prof = { ...(prof || {}), ...Object.fromEntries(Object.entries(blk).filter(([, v]) => v !== '' && v != null)) }
          if (blk.dmKey && /^[0-9a-f]{64}$/.test(blk.dmKey)) peerEdPk.set(k, blk.dmKey)
          break
        }
      } catch { break }   // no holder: keep what we have
    }
  }
  profileCache.set(k, { at: core.length, profile: prof })
  return prof
}

async function latestProfile (core) {
  const merged = {}; let found = false
  const fields = ['name', 'bio', 'status', 'avatar', 'dmKey', 'ts']
  const floor = Math.max(0, core.length - 600)
  for (let i = core.length - 1; i >= floor; i--) {
    let blk
    try {
      if (!(await core.has(i))) continue
      blk = P.sanitizeBlock(await core.get(i, { timeout: 1000 }))
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

async function resolveBlock (author, seq) {
  const core = feeds.get(author) || await openFeed(author)
  try {
    if (core.writable && !(await core.has(seq))) throw new Error('cleared')
    const blk = await fetchBlock(core, seq, 12000)
    return { seq, author, ...blk }
  } catch {
    const a = discovered.get(postId(author, seq))
    return a ? { seq, author, ts: a.ts, type: 'post', text: a.text, unverified: true } : null
  }
}

// ---------------- gossip ----------------
function handleAnnouncement (a) {
  if (!a || typeof a.author !== 'string' || !/^[0-9a-f]{64}$/.test(a.author)) return
  if (typeof a.seq !== 'number' || typeof a.ts !== 'number') return
  if (typeof a.text !== 'string' || a.text.length > 600) return
  if (blocked.has(a.author)) return
  if (!Number.isInteger(a.seq) || a.seq < 0) return
  const trust = verifyAnn(a)
  if (trust === 'forged') return
  let bound = false   // v2 signature binds kind/ref/thumb/media; if present it MUST verify
  if (typeof a.sig2 === 'string' && trust !== 'unsigned') {
    if (!verifyMsg(P.annMsgV2(a), a.sig2, a.edpk)) return
    bound = true
  }
  const kind = P.normKind(a.kind)
  const clean = { author: a.author, seq: a.seq, ts: a.ts, text: a.text, kind, ref: null, trust }
  if (a.sig && trust !== 'unsigned') { clean.sig = a.sig; clean.edpk = a.edpk }
  if (bound || trust === 'unsigned') {
    const media = P.cleanAnnMedia(a)
    if (media) { Object.assign(clean, media); if (bound) clean.sig2 = a.sig2 }
  }
  if ((kind === 'quote' || kind === 'reply') && a.ref && /^[0-9a-f]{64}$/.test(a.ref.author) && typeof a.ref.seq === 'number') {
    clean.ref = { author: a.ref.author, seq: a.ref.seq }
  }
  if (kind === 'reply') {
    if (!clean.ref) return
    const rid = postId(clean.ref.author, clean.ref.seq)
    if (!replies.has(rid)) {
      replies.set(rid, new Map())
      if (replies.size > 5000) replies.delete(replies.keys().next().value)
    }
    const m = replies.get(rid)
    if (m.has(postId(clean.author, clean.seq)) || m.size >= 500) return
    m.set(postId(clean.author, clean.seq), clean)
    emit('replies-updated', rid)
    if (clean.ref.author === hex(myCore.key) && clean.author !== hex(myCore.key)) {
      pushNotif({ type: 'reply', from: clean.author, ts: clean.ts, text: clean.text, ref: clean.ref })
    }
  } else {
    const id = postId(clean.author, clean.seq)
    if (discovered.has(id)) return
    discovered.set(id, clean)
    if (discovered.size > 5000) discovered.delete(discovered.keys().next().value)
    emit('discover-updated', null)
  }
  saveJ('gossip-cache', [...discovered.values()].slice(-500))
  for (const s of gossipPeers) sendSock(s, { t: 'ann', a: clean })
}

function handleDelete (a) {
  if (!a || !P.HEX64.test(a.author || '') || !Number.isInteger(a.seq) || typeof a.ts !== 'number') return
  if (typeof a.sig !== 'string' || typeof a.edpk !== 'string') return
  const id = postId(a.author, a.seq)
  const known = peerEdPk.get(a.author) || (discovered.get(id) && discovered.get(id).edpk)
  if (!known || known !== a.edpk || !verifyMsg(P.delMsg(a.author, a.seq, a.ts), a.sig, a.edpk)) return
  discovered.delete(id); replies.delete(id)
  const core = feeds.get(a.author)
  if (core) core.clear(a.seq, a.seq + 1).catch(() => {})
  emit('discover-updated', null); emit('feed-updated', a.author)
}

function joinGossip (topicBuf) {
  const k = hex(topicBuf)
  if (gossipTopics.has(k)) return
  gossipTopics.set(k, 1)
  gossipSwarm.join(topicBuf, { server: true, client: true })
}

async function refreshInterests () {
  const texts = []
  for (const [k, core] of feeds) {
    if (k !== hex(myCore.key) && !follows.has(k)) continue
    const start = Math.max(0, core.length - 20)
    for (let i = start; i < core.length; i++) {
      try {
        if (!(await core.has(i))) continue
        const b = await core.get(i, { timeout: 1200 })
        if (b.type === 'post') texts.push(b.text)
      } catch {}
    }
  }
  for (const t of texts.slice(-40)) for (const topic of disc.topicsForText(t)) joinGossip(topic)
  if (SETTINGS.commons) joinGossip(disc.commonsTopic())
  emit('buckets', gossipTopics.size)
}

function announceOwn (block, seq) {
  const a = {
    author: hex(myCore.key), seq, ts: block.ts, text: block.text || '',
    kind: block.type === 'reply' ? 'reply' : block.type === 'quote' ? 'quote' : 'post',
    ref: block.ref || null
  }
  if (block.thumb) a.thumb = block.thumb
  if (block.mediaSeq != null) a.mediaSeq = block.mediaSeq
  a.edpk = myEdPk; a.sig = signAnn(a); a.sig2 = signMsg(P.annMsgV2(a))
  handleAnnouncement(a)
}

// ---------------- DM layer ----------------
async function verifyDmPeer (socket) {
  if (socket.peerKey || !socket.claimedKey || !socket._proof) return
  const k = socket.claimedKey
  let pk = peerEdPk.get(k)
  if (!pk && feeds.has(k)) { try { await latestProfile(feeds.get(k)) } catch {} ; pk = peerEdPk.get(k) }
  if (!pk) return
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
    saveJ('dm-outbox', dmOutbox)
    const convo = dmConvos.get(peerKey)
    if (convo) { for (const m of convo) if (m.delivered === false) m.delivered = true; persistAll() }
    emit('dm-received', peerKey)
  }
}

function wireLineSocket (socket, onMsg) {
  let buf = ''
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buf += chunk.toString()
    if (buf.length > 1e6) { buf = ''; return }
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!allowMsg(socket)) continue
      try { onMsg(JSON.parse(line)) } catch {}
    }
  })
}

// ---------------- engine boot ----------------
async function startEngine () {
  store = new Corestore(join(DATA_DIR, 'store'))
  feedSwarm = new Hyperswarm()
  gossipSwarm = new Hyperswarm()
  dmSwarm = new Hyperswarm()

  Object.assign(SETTINGS, loadJ('settings', {}))
  for (const a of loadJ('gossip-cache', [])) discovered.set(postId(a.author, a.seq), a)
  for (const a of loadJ('saved', [])) saved.set(postId(a.author, a.seq), a)
  notifs.push(...loadJ('notifs', []))
  const mod = loadJ('moderation', {}); for (const k of mod.blocked || []) blocked.add(k); for (const k of mod.muted || []) muted.add(k)
  for (const k of loadJ('dm-accepted', [])) dmAccepted.add(k)
  dmOutbox.push(...loadJ('dm-outbox', []))
  for (const [k, v] of loadJ('dm-history', [])) dmConvos.set(k, v)

  feedSwarm.on('connection', (socket) => {
    store.replicate(socket)
    emit('peers', feedSwarm.connections.size)
    // a new peer may hold blocks we're missing: re-arm the tail window
    for (const core of feeds.values()) { try { tailSync(core) } catch {} }
    socket.on('close', () => emit('peers', feedSwarm.connections.size))
  })

  gossipSwarm.on('connection', (socket) => {
    gossipPeers.add(socket)
    socket.on('close', () => { gossipPeers.delete(socket); emit('gossip-peers', gossipPeers.size) })
    wireLineSocket(socket, (msg) => {
      if (msg.t === 'ann') handleAnnouncement(msg.a)
      else if (msg.t === 'del') handleDelete(msg.a)
      else if (msg.t === 'hello') {
        const since = typeof msg.since === 'number' ? msg.since : 0
        for (const a of [...discovered.values()].filter(x => x.ts > since).slice(-200)) sendSock(socket, { t: 'ann', a })
        for (const a of saved.values()) if (a.ts > since) sendSock(socket, { t: 'ann', a })
        const mine = [...discovered.values()].filter(a => a.author === hex(myCore.key)).slice(-10)
        for (const a of mine) sendSock(socket, { t: 'ann', a })
      }
    })
    let since = 0
    for (const a of discovered.values()) if (a.ts > since) since = a.ts
    sendSock(socket, { t: 'hello', since })
    emit('gossip-peers', gossipPeers.size)
  })

  dmSwarm.on('connection', (socket) => {
    dmSockets.add(socket)
    socket.on('close', () => dmSockets.delete(socket))
    const cb = b4a.alloc(32); sodium.randombytes_buf(cb); socket._chal = b4a.toString(cb, 'hex')
    try { socket.write(JSON.stringify({ t: 'dmhello', v: P.PROTOCOL_VERSION, key: hex(myCore.key), chal: socket._chal }) + '\n') } catch {}
    wireLineSocket(socket, (msg) => {
      if (msg.t === 'dmhello' && P.HEX64.test(msg.key || '')) {
        socket.claimedKey = msg.key
        if (typeof msg.chal === 'string' && P.HEX64.test(msg.chal)) {
          try { socket.write(JSON.stringify({ t: 'dmproof', sig: signMsg(P.dmProofMsg(msg.chal, hex(myCore.key))) }) + '\n') } catch {}
        }
        verifyDmPeer(socket)
      }
      if (msg.t === 'dmproof' && typeof msg.sig === 'string') { socket._proof = msg.sig; verifyDmPeer(socket) }
      if (msg.t === 'dm' && msg.to === hex(myCore.key) && /^[0-9a-f]{64}$/.test(msg.from || '') && /^[0-9a-f]{64}$/.test(msg.edpk || '')) {
        if (blocked.has(msg.from)) return
        const known = peerEdPk.get(msg.from)
        if (known && known !== msg.edpk) return
        const mid = msg.mid || (msg.p && msg.p.n)
        if (mid) {
          if (!dmSeen.has(msg.from)) dmSeen.set(msg.from, new Set())
          const seen = dmSeen.get(msg.from)
          if (seen.has(mid)) return
          seen.add(mid)
        }
        const raw = dm.openBox(msg.p, msg.edpk, myCurve.sk)
        if (raw === null) return
        // desktop wraps every DM in {k:'t'|'i'|'v', d}. Unwrap at the boundary
        // so the UI only ever sees clean text/media, never protocol JSON.
        let text = raw, kind = 't'
        try {
          const env = JSON.parse(raw)
          if (env && typeof env.k === 'string' && env.d !== undefined) { kind = env.k; text = env.d }
        } catch {}
        if (!known) peerEdPk.set(msg.from, msg.edpk)
        if (!dmConvos.has(msg.from)) dmConvos.set(msg.from, [])
        const convo = dmConvos.get(msg.from)
        convo.push({ from: msg.from, to: hex(myCore.key), text, kind, ts: msg.ts || Date.now(), verified: !!known })
        if (convo.length > 500) convo.splice(0, convo.length - 500)
        persistAll()
        emit('dm-received', msg.from)
        pushNotif({ type: 'dm', from: msg.from, ts: msg.ts || Date.now(), text: '[encrypted message]' })
      }
    })
  })

  myCore = store.get({ name: 'ember-self', valueEncoding: 'json' })
  await myCore.ready()
  myCurve = dm.curveKeys(myCore.keyPair)
  myEdPk = hex(myCore.keyPair.publicKey)
  feeds.set(hex(myCore.key), myCore)
  feedSwarm.join(myCore.discoveryKey, { server: true, client: true })
  dmSwarm.join(dm.inboxTopic(hex(myCore.key)), { server: true, client: true })

  for (let i = 0; i < myCore.length; i++) {
    try {
      if (!(await myCore.has(i))) continue
      const blk = await myCore.get(i, { timeout: 1500 })
      if (blk.type === 'follow') follows.add(blk.key)
      if (blk.type === 'unfollow') follows.delete(blk.key)
    } catch {}
  }
  for (const k of follows) await openFeed(k)

  const prof = await latestProfile(myCore)
  if (!prof || prof.dmKey !== myEdPk) {
    await myCore.append({
      type: 'profile',
      name: (prof && prof.name) || '', status: (prof && prof.status) || '', bio: (prof && prof.bio) || '',
      ...(prof && prof.avatar ? { avatar: prof.avatar } : {}),
      dmKey: myEdPk, ts: Date.now()
    })
  }
  refreshInterests()
  setInterval(refreshInterests, 60_000)
  setInterval(() => {
    const mine = [...discovered.values()].filter(a => a.author === hex(myCore.key)).slice(-10)
    for (const s of gossipPeers) for (const a of mine) sendSock(s, { t: 'ann', a })
  }, 240_000)
  setInterval(persistAll, 60_000)
  engineUp = true
  emit('engine-ready', true)
}

// ---------------- RPC handlers (names mirror desktop IPC) ----------------
const handlers = {
  async me () {
    if (!engineUp) return { key: '', length: 0, profile: null, booting: true }
    return { key: hex(myCore.key), length: myCore.length, profile: await latestProfile(myCore) }
  },

  async post ({ text, image, thumb, quoteRef }) {
    let mediaSeq = null
    if (image && typeof image === 'string' && image.length < 30_000_000) {
      await myCore.append({ type: 'media', data: image, ts: Date.now() })
      mediaSeq = myCore.length - 1
    }
    const block = { type: quoteRef ? 'quote' : 'post', text: text || '', ts: Date.now() }
    if (quoteRef && /^[0-9a-f]{64}$/.test(quoteRef.author) && typeof quoteRef.seq === 'number') block.ref = quoteRef
    if (mediaSeq !== null) { block.mediaSeq = mediaSeq; block.thumb = (thumb || '').slice(0, 20000) }
    await myCore.append(block)
    const seq = myCore.length - 1
    for (const topic of disc.topicsForText(text || 'image')) joinGossip(topic)
    joinGossip(disc.replyTopic(hex(myCore.key), seq))
    await gossipSwarm.flush().catch(() => {})
    announceOwn(block, seq)
    emit('feed-updated', hex(myCore.key))
    return seq
  },

  async reply ({ author, seq, text }) {
    const block = { type: 'reply', text, ref: { author, seq }, ts: Date.now() }
    await myCore.append(block)
    joinGossip(disc.replyTopic(author, seq))
    await gossipSwarm.flush().catch(() => {})
    announceOwn(block, myCore.length - 1)
    return true
  },

  async 'get-replies' ({ author, seq }) {
    joinGossip(disc.replyTopic(author, seq))
    const m = replies.get(postId(author, seq))
    return m ? [...m.values()].filter(r => !blocked.has(r.author) && !muted.has(r.author)).sort((a, b) => a.ts - b.ts) : []
  },

  async 'set-profile' ({ name, bio, status, avatar }) {
    const prev = await latestProfile(myCore) || {}
    const blk = {
      type: 'profile',
      name: name || prev.name || '', bio: bio || prev.bio || '',
      status: (status !== undefined && status !== null) ? status : (prev.status || ''),
      dmKey: myEdPk, ts: Date.now()
    }
    if (avatar && typeof avatar === 'string' && avatar.length <= 60_000) blk.avatar = avatar
    else if (prev.avatar) blk.avatar = prev.avatar
    await myCore.append(blk)
    return true
  },

  async follow ({ key }) {
    const raw = key
    key = P.cleanKey(key)
    if (!key) throw new Error(`invalid key — expected 64 hex characters, got: ${String(raw).trim().slice(0, 40)}`)
    if (key === hex(myCore.key) || follows.has(key)) return [...follows]
    await myCore.append({ type: 'follow', key, ts: Date.now() })
    follows.add(key)
    const core = await openFeed(key)
    await feedSwarm.flush().catch(() => {})
    tailSync(core)
    refreshInterests()                    // fire and forget: never delays the reply
    emit('feed-updated', key)
    return [...follows]
  },

  async unfollow ({ key }) {
    if (!follows.has(key)) return [...follows]
    await myCore.append({ type: 'unfollow', key, ts: Date.now() })
    follows.delete(key); return [...follows]
  },

  async timeline () {
    if (!engineUp) return { items: [], profiles: {}, follows: [], peers: 0, replyCounts: {}, booting: true }
    const items = []; const profiles = {}
    for (const [k, core] of feeds) {
      if (k !== hex(myCore.key) && !follows.has(k)) continue
      if (blocked.has(k) || muted.has(k)) continue
      items.push(...(await readFeed(core)).filter(b => ['post', 'repost', 'quote'].includes(b.type)))
      const p = await freshProfile(core); if (p) profiles[k] = p
    }
    items.sort((a, b) => b.ts - a.ts)
    const replyCounts = {}
    for (const it of items) { const m = replies.get(postId(it.author, it.seq)); if (m) replyCounts[postId(it.author, it.seq)] = m.size }
    // contiguousLength is O(1); the old per-block has() loop ran hundreds of
    // awaits on every timeline call and was a large part of the lag.
    let known = 0, held = 0
    for (const [k, core] of feeds) {
      if (k !== hex(myCore.key) && !follows.has(k)) continue
      known += core.length
      held += Math.min(core.contiguousLength || 0, core.length)
    }
    return {
      items: items.slice(0, 300), profiles, follows: [...follows],
      peers: feedSwarm.connections.size,
      seeders: (myCore.peers && myCore.peers.length) || 0,   // peers replicating OUR core
      replyCounts,
      sync: { held, known, syncing: held < known }
    }
  },

  async discover ({ query }) {
    let list = [...discovered.values()].filter(a => a.author !== hex(myCore.key) && !blocked.has(a.author) && !muted.has(a.author))
    if (query && query.trim()) {
      const qv = disc.embed(query)
      for (const topic of disc.probeTopicsForText(query)) joinGossip(topic)
      const now = Date.now()
      list = list.map(a => {
        const cos = disc.cosine(qv, disc.embed(a.text))
        const rec = Math.exp(-(now - a.ts) / (3 * 86_400_000))
        return { ...a, score: cos, rank: 0.78 * cos + 0.22 * rec }
      }).sort((a, b) => b.rank - a.rank)
    } else list = list.sort((a, b) => b.ts - a.ts)
    const top = list.slice(0, 100)
    // resolve display names for whoever we already have a feed for
    const profiles = {}
    for (const a of top) {
      if (profiles[a.author]) continue
      const core = feeds.get(a.author)
      if (core) { const p = await freshProfile(core); if (p) profiles[a.author] = p }
    }
    return { items: top, profiles, buckets: gossipTopics.size, gossipPeers: gossipPeers.size }
  },

  async 'profile-page' ({ key }) {
    const self = key === hex(myCore.key)
    const core = self ? myCore : (feeds.get(key) || await openFeed(key))
    const all = await readFeed(core, 300)
    const posts = all.filter(b => b.type === 'post' || b.type === 'quote')
    const profile = await freshProfile(core)
    let joined = null
    try { if (await core.has(0)) joined = (await core.get(0, { timeout: 1500 })).ts } catch {}
    return {
      key, self, profile, joined,
      stats: { posts: posts.length, following: self ? follows.size : 0, blocks: core.length },
      posts: posts.slice(0, 60), isFollowed: follows.has(key)
    }
  },

  async repost ({ author, seq }) { await myCore.append({ type: 'repost', ref: { author, seq }, ts: Date.now() }); return true },
  async 'resolve-block' ({ author, seq }) { return resolveBlock(author, seq) },
  async 'get-media' ({ author, seq }) {
    const core = feeds.get(author) || await openFeed(author)
    await feedSwarm.flush().catch(() => {})
    try {
      const blk = await fetchBlock(core, seq, 25000)
      return blk && blk.type === 'media' ? blk.data : null
    } catch { return null }
  },

  async 'delete-post' ({ seq }) {
    if (!Number.isInteger(seq) || seq < 0 || seq >= myCore.length) throw new Error('bad seq')
    let media = null
    try {
      if (!(await myCore.has(seq))) return true
      const blk = await myCore.get(seq, { timeout: 1500 })
      if (!blk || !['post', 'quote', 'repost'].includes(blk.type)) throw new Error('not a post')
      if (blk.mediaSeq != null) media = blk.mediaSeq
    } catch (e) { if (e.message === 'not a post') throw e }
    await myCore.append({ type: 'delete', ref: { seq }, ts: Date.now() })
    try { await myCore.clear(seq, seq + 1) } catch {}
    if (media != null) { try { await myCore.clear(media, media + 1) } catch {} }
    discovered.delete(postId(hex(myCore.key), seq))
    const dts = Date.now()
    for (const s of gossipPeers) sendSock(s, { t: 'del', a: { author: hex(myCore.key), seq, ts: dts, edpk: myEdPk, sig: signMsg(P.delMsg(hex(myCore.key), seq, dts)) } })
    emit('feed-updated', hex(myCore.key))
    return true
  },

  // stories
  async 'post-story' ({ image, caption }) {
    if (!image || image.length > 300_000) throw new Error('bad story')
    await myCore.append({ type: 'story', data: image, caption: (caption || '').slice(0, 140), ts: Date.now() })
    emit('feed-updated', hex(myCore.key)); return true
  },
  async stories () {
    if (!engineUp) return []
    const cutoff = Date.now() - 86_400_000
    const out = []
    for (const [k, core] of feeds) {
      if (k !== hex(myCore.key) && !follows.has(k)) continue
      if (blocked.has(k) || muted.has(k)) continue
      const st = []
      const start = Math.max(0, core.length - 60)
      for (let i = core.length - 1; i >= start; i--) {
        try {
          if (!(await core.has(i))) continue
          const blk = P.sanitizeBlock(await core.get(i, { timeout: 1000 }))
          if (blk && blk.type === 'story' && blk.ts > cutoff) st.push({ author: k, seq: i, caption: blk.caption, ts: blk.ts })
        } catch { continue }
      }
      if (st.length) {
        const p = await latestProfile(core)   // local blocks only: never waits on the network
        out.push({ author: k, self: k === hex(myCore.key), name: (p && p.name) || '', avatar: p && p.avatar, stories: st.reverse() })
      }
    }
    out.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0))
    return out
  },
  async 'get-story' ({ author, seq }) {
    const core = feeds.get(author) || await openFeed(author)
    await feedSwarm.flush().catch(() => {})
    try {
      const b = await fetchBlock(core, seq, 25000)
      return b && b.type === 'story' ? { data: b.data, caption: b.caption, ts: b.ts } : null
    } catch { return null }
  },

  // DMs
  async 'dm-send' ({ to, text }) {
    if (!/^[0-9a-f]{64}$/.test(to) || !text || text.length > 450_000) throw new Error('bad dm')
    if (!peerEdPk.get(to)) {
      const core = feeds.get(to) || await openFeed(to)
      await feedSwarm.flush().catch(() => {})
      for (let t = 0; t < 3 && !peerEdPk.get(to); t++) {
        await latestProfile(core)
        if (!peerEdPk.get(to)) await new Promise(r => setTimeout(r, 1500))
      }
    }
    const theirPk = peerEdPk.get(to)
    if (!theirPk) return { sent: false, reason: 'no-key' }
    dmSwarm.join(dm.inboxTopic(to), { server: true, client: true })
    await dmSwarm.flush().catch(() => {})
    // wrap to match the desktop protocol exactly
    const wire = JSON.stringify({ k: 't', d: text })
    const payload = { t: 'dm', from: hex(myCore.key), to, edpk: myEdPk, ts: Date.now(), mid: Date.now() + ':' + Math.random().toString(36).slice(2, 8), p: dm.seal(wire, theirPk, myCurve.sk) }
    let sent = 0
    for (const s of dmSockets) {
      if (s.peerKey !== to) continue   // only sockets that PROVED they are the recipient
      try { s.write(JSON.stringify(payload) + '\n'); sent++ } catch {}
    }
    if (!sent) { dmOutbox.push({ to, payload }); saveJ('dm-outbox', dmOutbox) }
    if (!dmConvos.has(to)) dmConvos.set(to, [])
    dmConvos.get(to).push({ from: hex(myCore.key), to, text, kind: 't', ts: payload.ts, delivered: sent > 0 })
    persistAll()
    return { sent: sent > 0, queued: !sent }
  },
  async 'dm-open' ({ key }) { dmSwarm.join(dm.inboxTopic(key), { server: true, client: true }); return dmConvos.get(key) || [] },
  async 'dm-list' () {
    if (!engineUp) return []
    const rows = await Promise.all([...dmConvos.entries()].map(async ([k, msgs]) => {
      let p = null
      try { p = feeds.has(k) ? await latestProfile(feeds.get(k)) : ((profileCache.get(k) || {}).profile || null) } catch {}
      return {
        key: k, name: (p && p.name) || '', avatar: p && p.avatar,
        last: msgs[msgs.length - 1] || null, count: msgs.length,
        request: !follows.has(k) && !dmAccepted.has(k) && msgs.some(x => x.from === k)
      }
    }))
    return rows.sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0))
  },
  async 'dm-accept' ({ key }) { dmAccepted.add(key); saveJ('dm-accepted', [...dmAccepted]); return true },
  async 'dm-ignore' ({ key }) { dmConvos.delete(key); persistAll(); return true },

  // saved
  async 'save-post' ({ author, seq }) {
    const blk = await resolveBlock(author, seq)
    if (!blk || !blk.text) throw new Error('cannot resolve')
    const orig = discovered.get(postId(author, seq))
    let a
    if (orig && orig.sig) a = { ...orig }   // keep the author's signatures
    else {
      a = { author, seq, ts: blk.ts, text: blk.text, kind: 'post', ref: null }
      if (blk.thumb) a.thumb = blk.thumb
      if (blk.mediaSeq != null) a.mediaSeq = blk.mediaSeq
    }
    saved.set(postId(author, seq), a); saveJ('saved', [...saved.values()])
    for (const s of gossipPeers) sendSock(s, { t: 'ann', a })
    return true
  },
  async 'unsave-post' ({ author, seq }) { saved.delete(postId(author, seq)); saveJ('saved', [...saved.values()]); return true },
  async 'saved-list' () { return [...saved.values()].sort((a, b) => b.ts - a.ts) },

  // notifications
  async 'notifs-list' () { return [...notifs].reverse() },
  async 'notifs-unread' () {
    const u = { reply: 0, dm: 0, post: 0, total: 0 }
    for (const n of notifs) if (!n.read) { u[n.type] = (u[n.type] || 0) + 1; u.total++ }
    return u
  },
  async 'notifs-mark-read' ({ type }) { for (const n of notifs) if (!type || n.type === type) n.read = true; saveJ('notifs', notifs.slice(-200)); return true },

  // moderation
  async block ({ key }) {
    blocked.add(key); muted.delete(key)
    for (const [id, a] of discovered) if (a.author === key) discovered.delete(id)
    dmConvos.delete(key); persistAll()
    return { blocked: [...blocked], muted: [...muted] }
  },
  async mute ({ key }) { muted.add(key); persistAll(); return { blocked: [...blocked], muted: [...muted] } },
  async unblock ({ key }) { blocked.delete(key); persistAll(); return { blocked: [...blocked], muted: [...muted] } },
  async unmute ({ key }) { muted.delete(key); persistAll(); return { blocked: [...blocked], muted: [...muted] } },
  async moderation () { return { blocked: [...blocked], muted: [...muted] } },

  // settings + identity
  async 'get-settings' () { return { ...SETTINGS } },
  async 'set-settings' (patch) {
    if (typeof patch.theme === 'string' && ['paper', 'carbon', 'phosphor'].includes(patch.theme)) SETTINGS.theme = patch.theme
    if (typeof patch.commons === 'boolean') SETTINGS.commons = patch.commons
    if (typeof patch.keepDmHistory === 'boolean') SETTINGS.keepDmHistory = patch.keepDmHistory
    if (Number.isInteger(patch.tailWindow) && patch.tailWindow >= 20 && patch.tailWindow <= 5000) SETTINGS.tailWindow = patch.tailWindow
    saveJ('settings', SETTINGS); return SETTINGS
  },
  async 'export-identity' () { return { primaryKey: b4a.toString(store.primaryKey, 'hex'), publicKey: hex(myCore.key) } }
}

startEngine().catch(e => emit('engine-error', String((e && e.stack) || e)))
