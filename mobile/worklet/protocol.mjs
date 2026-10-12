import crypto from 'bare-crypto'

// ─────────────────────────────────────────────────────────────────────────────
// EMBER PROTOCOL — shared by desktop (CommonJS) and mobile (ESM worklet).
// Canonical copy. mobile/worklet/protocol.mjs is generated from this file by
// tools/sync-shared.js — edit here, then run `node tools/sync-shared.js`.
//
// Everything that crosses a trust boundary passes through here: blocks read
// from other people's feeds, gossip announcements, pasted keys, DM handshakes.
// Rule: other peers' data is hostile until it has been reduced to a known shape.
// ─────────────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 2

const HEX64 = /^[0-9a-f]{64}$/
// strict data URLs: a fixed MIME list and a pure base64 body. Nothing that can
// close an attribute, start a tag, or point at a URL scheme survives this.
const SAFE_IMG = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

const sha256hex = (s) => crypto.createHash('sha256').update(s || '').digest('hex')

// Keys get pasted from share sheets, chat apps and alert dialogs: extract the
// first 64-hex run instead of demanding a pristine string.
function cleanKey (raw) {
  if (typeof raw !== 'string') return null
  const s = raw.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
  const m = s.match(/[0-9a-f]{64}/)
  return m ? m[0] : null
}

function safeImg (s, max) {
  return typeof s === 'string' && s.length <= max && SAFE_IMG.test(s) ? s : undefined
}
function str (s, max) { return typeof s === 'string' ? s.slice(0, max) : undefined }
function nat (n) { return Number.isInteger(n) && n >= 0 ? n : undefined }
function cleanRef (r) {
  return r && typeof r === 'object' && typeof r.author === 'string' && HEX64.test(r.author) && nat(r.seq) !== undefined
    ? { author: r.author, seq: r.seq } : null
}
function cleanVideoMeta (v) {
  if (!v || typeof v !== 'object') return undefined
  if (nat(v.start) === undefined || !Number.isInteger(v.count) || v.count <= 0 || v.count > 30000) return undefined
  if (typeof v.mime !== 'string' || !/^video\/(mp4|webm)$/.test(v.mime)) return undefined
  if (!Number.isInteger(v.size) || v.size <= 0 || v.size > 2_000_000_000) return undefined
  return { start: v.start, count: v.count, mime: v.mime, size: v.size }
}
function normKind (k) { return k === 'reply' ? 'reply' : k === 'quote' ? 'quote' : 'post' }

// Reduce any block read from ANY feed to a whitelisted shape. Unknown fields
// are dropped, wrong types are dropped, unknown block types become null.
function sanitizeBlock (b) {
  if (!b || typeof b !== 'object' || typeof b.type !== 'string') return null
  const ts = Number.isFinite(b.ts) ? b.ts : 0
  const o = { type: b.type, ts }
  const put = (k, v) => { if (v !== undefined && v !== null) o[k] = v }
  switch (b.type) {
    case 'post': case 'quote': case 'repost': case 'reply':
      put('text', str(b.text, 20000) || '')
      put('ref', cleanRef(b.ref))
      put('mediaSeq', nat(b.mediaSeq))
      put('thumb', safeImg(b.thumb, 40000))
      put('videoMeta', cleanVideoMeta(b.videoMeta))
      return o
    case 'media':   put('data', safeImg(b.data, 40_000_000)); return o.data ? o : null
    case 'story':   put('data', safeImg(b.data, 5_000_000)); put('caption', str(b.caption, 280)); return o.data ? o : null
    case 'profile':
      put('name', str(b.name, 64)); put('status', str(b.status, 64)); put('bio', str(b.bio, 500))
      put('avatar', safeImg(b.avatar, 120000))
      if (typeof b.dmKey === 'string' && HEX64.test(b.dmKey)) o.dmKey = b.dmKey
      return o
    case 'follow': case 'unfollow':
      return typeof b.key === 'string' && HEX64.test(b.key) ? { type: b.type, ts, key: b.key } : null
    case 'delete':
      return b.ref && nat(b.ref.seq) !== undefined ? { type: 'delete', ts, ref: { seq: b.ref.seq } } : null
    case 'modlist': {
      // a published blocklist: keys this person blocks, for people who chose to
      // trust their judgement (subscriptions / circle signals). Capped, deduped.
      const keys = Array.isArray(b.keys) ? [...new Set(b.keys.filter(k => typeof k === 'string' && HEX64.test(k)))].slice(0, 5000) : []
      return { type: 'modlist', ts, keys }
    }
    case 'vchunk':
      return typeof b.d === 'string' && b.d.length <= 70000 && B64.test(b.d) ? { type: 'vchunk', ts, d: b.d } : null
    default:
      return null
  }
}

// ---- announcement signatures ----
// v1 signs only the text. v2 additionally binds every field a relay could
// otherwise swap (kind, quote/reply target, thumbnail, media pointers), so a
// hostile relay can't attach a different image to your signed post.
function annExtras (a) {
  const ref = a.ref ? `${a.ref.author}:${a.ref.seq}` : ''
  const vm = a.videoMeta ? `${a.videoMeta.start}:${a.videoMeta.count}:${a.videoMeta.mime}:${a.videoMeta.size}` : ''
  const ms = a.mediaSeq != null ? String(a.mediaSeq) : ''
  return sha256hex(`${normKind(a.kind)}|${ref}|${sha256hex(typeof a.thumb === 'string' ? a.thumb : '')}|${ms}|${vm}`)
}
function annMsgV1 (a) { return `${a.author}|${a.seq}|${a.ts}|${sha256hex(a.text || '')}` }
function annMsgV2 (a) { return `ember/ann/2|${annMsgV1(a)}|${annExtras(a)}` }

// The media fields a v2 signature covers, sanitized exactly as relays do. If
// sanitizing would CHANGE anything, downstream peers can no longer verify the
// signature, so the caller must drop both the media and sig2.
function cleanAnnMedia (a) {
  const out = {}
  if (a.thumb !== undefined) { const t = safeImg(a.thumb, 20000); if (t) out.thumb = t; else return null }
  if (a.mediaSeq !== undefined) { const m = nat(a.mediaSeq); if (m !== undefined) out.mediaSeq = m; else return null }
  if (a.videoMeta !== undefined) { const v = cleanVideoMeta(a.videoMeta); if (v) out.videoMeta = v; else return null }
  return out
}

// ---- deletes ----
// A tombstone gossiped to peers must be signed by the author: otherwise anyone
// could purge anyone's posts from every cache they reach.
function delMsg (author, seq, ts) { return `ember/del/1|${author}|${seq}|${ts}` }

// ---- DM peer proof ----
// dmhello carries a random challenge; the other side signs it with its
// identity key. Only a verified socket may receive our queued outbox.
function dmProofMsg (chal, key) { return `ember/dm-proof/1|${chal}|${key}` }

// ---- nearby ----
// A "near card" says: this identity is on this network ('lan') or has opted
// into an area ('area'). It is signed with the identity's published signer key,
// so nobody can put someone else's key on the map. A 'bye' card (same shape as
// 'lan') is sent when someone hides or turns a channel off, so they disappear
// from other people's lists at once instead of when their last card expires. `place` is a town the user
// picked from a bundled list (Ember never reads GPS); lat/lon are that town's
// centre rounded to 0.01°. Name and place may not contain '|' or control
// characters: a field could otherwise slide into its neighbour and still verify.
const NEAR_TEXT = /^[^|\u0000-\u001f\u007f]*$/
const round2 = (n) => Math.round(n * 100) / 100
function nearText (s, max) { return String(s || '').replace(/[|\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) }
function makeNearCard ({ via, key, edpk, name, place, lat, lon, ts }) {
  const c = { via, key, edpk, name: nearText(name, 40), ts }
  if (via === 'area') { c.place = nearText(place, 80); c.lat = round2(lat); c.lon = round2(lon) }
  return c
}
function nearMsg (c) {
  const area = c.via === 'area' ? `${c.place}|${c.lat}|${c.lon}` : '||'
  return `ember/near/1|${c.via}|${c.key}|${c.edpk}|${c.name}|${area}|${c.ts}`
}
function cleanNear (c, now) {
  if (!c || typeof c !== 'object') return null
  if (c.via !== 'lan' && c.via !== 'area' && c.via !== 'bye') return null
  if (typeof c.key !== 'string' || !HEX64.test(c.key) || typeof c.edpk !== 'string' || !HEX64.test(c.edpk)) return null
  if (typeof c.sig !== 'string' || c.sig.length > 120 || !B64.test(c.sig)) return null
  if (!Number.isInteger(c.ts) || Math.abs(now - c.ts) > 10 * 60_000) return null
  if (typeof c.name !== 'string' || c.name.length > 40 || !NEAR_TEXT.test(c.name)) return null
  const out = { via: c.via, key: c.key, edpk: c.edpk, name: c.name, ts: c.ts, sig: c.sig }
  if (c.via === 'area') {
    if (typeof c.place !== 'string' || !c.place || c.place.length > 80 || !NEAR_TEXT.test(c.place)) return null
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) return null
    if (round2(c.lat) !== c.lat || round2(c.lon) !== c.lon) return null // finer than a town centre: refuse
    out.place = c.place; out.lat = c.lat; out.lon = c.lon
  } else if (c.place !== undefined || c.lat !== undefined || c.lon !== undefined) return null
  return out
}

// ---- campfires ----
// A campfire is a live, temporary room that exists while 3+ people sit in the
// same topic room. Messages are signed by the author's signer key and are never
// stored: they live in memory while the fire burns.
const FIRE_ID = /^[a-z0-9-]{1,32}$/
function fireMsg (m) { return `ember/fire/1|${m.fire}|${m.author}|${m.edpk}|${m.name}|${m.ts}|${sha256hex(m.text)}` }
function cleanFire (m, now) {
  if (!m || typeof m !== 'object') return null
  if (typeof m.fire !== 'string' || !FIRE_ID.test(m.fire)) return null
  if (typeof m.author !== 'string' || !HEX64.test(m.author) || typeof m.edpk !== 'string' || !HEX64.test(m.edpk)) return null
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 400) return null
  if (typeof m.name !== 'string' || m.name.length > 40 || !NEAR_TEXT.test(m.name)) return null
  if (!Number.isInteger(m.ts) || Math.abs(now - m.ts) > 15 * 60_000) return null
  if (typeof m.sig !== 'string' || m.sig.length > 120 || !B64.test(m.sig)) return null
  return { fire: m.fire, author: m.author, edpk: m.edpk, name: m.name, ts: m.ts, text: m.text, sig: m.sig }
}

// DM payloads are wrapped {k:'t'|'i'|'v', d}. Unwrap for previews/notifications.
function dmPreview (raw) {
  try {
    const e = JSON.parse(raw)
    if (e && e.k === 't') return String(e.d).slice(0, 140)
    if (e && e.k === 'i') return '[image]'
    if (e && e.k === 'v') return '[voice message]'
  } catch {}
  return String(raw || '').slice(0, 140)
}

export { PROTOCOL_VERSION, HEX64, SAFE_IMG, sha256hex, cleanKey, safeImg, cleanRef, cleanVideoMeta, normKind, sanitizeBlock, annExtras, annMsgV1, annMsgV2, cleanAnnMedia, delMsg, dmProofMsg, dmPreview, makeNearCard, nearMsg, cleanNear, nearText, fireMsg, cleanFire }
