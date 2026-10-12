// Protocol hardening tests: sanitizer vs XSS payloads, v2 signature binding,
// relay consistency, DM proof replay. Run: npm test
const P = require('../src/protocol')
const sodium = require('sodium-universal')
const b4a = require('b4a')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='
const K = 'ab'.repeat(32)

// ---- XSS payloads through sanitizeBlock ----
const evil = [
  'x" onerror="alert(1)', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=',
  'data:image/svg+xml;base64,PHN2Zz4=', IMG + '" onerror="x', IMG + '<svg>', 'https://tracker.example/p.gif'
]
for (const e of evil) {
  const prof = P.sanitizeBlock({ type: 'profile', name: 'n', avatar: e })
  ok(prof && prof.avatar === undefined, 'avatar payload kept: ' + e)
  const post = P.sanitizeBlock({ type: 'post', text: 't', thumb: e, ts: 1 })
  ok(post && post.thumb === undefined, 'thumb payload kept: ' + e)
  ok(P.sanitizeBlock({ type: 'media', data: e }) === null, 'media payload kept: ' + e)
}
ok(P.sanitizeBlock({ type: 'profile', avatar: IMG }).avatar === IMG, 'valid avatar dropped')
const q = P.sanitizeBlock({ type: 'quote', text: 'q', ref: { author: '"><img src=x onerror=1>', seq: 1 } })
ok(q && q.ref === undefined, 'evil ref kept')
const v = P.sanitizeBlock({ type: 'post', videoMeta: { start: 0, count: 2, mime: "video/mp4'><img src=x>", size: 9 } })
ok(v && v.videoMeta === undefined, 'evil videoMeta kept')
ok(P.sanitizeBlock({ type: 'post', mediaSeq: '1"><b>' }).mediaSeq === undefined, 'evil mediaSeq kept')
ok(P.sanitizeBlock({ type: 'post', text: { toString () { return 'x' } } }).text === '', 'object text kept')
ok(P.sanitizeBlock({ type: 'post', text: 'hi', __proto__: { polluted: 1 }, extra: 'z' }).extra === undefined, 'unknown field kept')
ok(P.sanitizeBlock({ type: 'weird' }) === null, 'unknown type kept')
ok(P.sanitizeBlock(null) === null && P.sanitizeBlock('str') === null, 'non-object accepted')
ok(P.sanitizeBlock({ type: 'delete', ref: { seq: 3 } }).ref.seq === 3, 'delete ref lost')
ok(P.sanitizeBlock({ type: 'follow', key: K }).key === K, 'follow key lost')
ok(P.sanitizeBlock({ type: 'follow', key: 'nope' }) === null, 'bad follow kept')
ok(P.sanitizeBlock({ type: 'vchunk', d: 'QUJD' }).d === 'QUJD', 'vchunk lost')
ok(P.sanitizeBlock({ type: 'vchunk', d: '<x>' }) === null, 'bad vchunk kept')

// ---- cleanKey ----
const bs = String.fromCharCode(92)
ok(P.cleanKey('publicKey: ' + K + '\n') === K, 'share-sheet key')
ok(P.cleanKey(K.slice(0, 5) + String.fromCharCode(0x200b) + K.slice(5)) === K, 'zero-width key')
ok(P.cleanKey(K.toUpperCase()) === K, 'uppercase key')
ok(P.cleanKey('hello') === null, 'garbage key accepted')

// ---- v2 signatures: binding + relay tamper ----
const kp = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(64) }
sodium.crypto_sign_keypair(kp.publicKey, kp.secretKey)
const sign = (m) => { const s = b4a.alloc(64); sodium.crypto_sign_detached(s, b4a.from(m), kp.secretKey); return s }
const vfy = (m, s) => sodium.crypto_sign_verify_detached(s, b4a.from(m), kp.publicKey)
const a = { author: K, seq: 4, ts: 99, text: 'hello', kind: 'post', thumb: IMG, mediaSeq: 3 }
const s2 = sign(P.annMsgV2(a))
ok(vfy(P.annMsgV2(a), s2), 'v2 roundtrip')
ok(!vfy(P.annMsgV2({ ...a, thumb: 'data:image/jpeg;base64,AAAA' }), s2), 'thumb swap undetected')
ok(!vfy(P.annMsgV2({ ...a, mediaSeq: 9 }), s2), 'mediaSeq swap undetected')
ok(!vfy(P.annMsgV2({ ...a, kind: 'quote', ref: { author: K, seq: 1 } }), s2), 'ref injection undetected')
ok(!vfy(P.annMsgV2({ ...a, text: 'hellO' }), s2), 'text swap undetected')
ok(P.annMsgV2({ ...a, kind: undefined }) === P.annMsgV2({ ...a, kind: 'post' }), 'kind normalization mismatch')
// relay consistency: what a relay keeps must re-verify downstream
const media = P.cleanAnnMedia(a)
ok(media && vfy(P.annMsgV2({ ...a, ...media }), s2), 'relayed media no longer verifies')
ok(P.cleanAnnMedia({ thumb: 'data:image/svg+xml;base64,AA' }) === null, 'unrelayable media not flagged')

// ---- DM proof ----
const chal = 'cd'.repeat(32)
const proof = sign(P.dmProofMsg(chal, K))
ok(vfy(P.dmProofMsg(chal, K), proof), 'dm proof roundtrip')
ok(!vfy(P.dmProofMsg('ee'.repeat(32), K), proof), 'dm proof replay on other challenge')
ok(!vfy(P.dmProofMsg(chal, 'ff'.repeat(32)), proof), 'dm proof for other identity')

// ---- signed deletes ----
const dsig = sign(P.delMsg(K, 7, 1234))
ok(vfy(P.delMsg(K, 7, 1234), dsig), 'delete roundtrip')
ok(!vfy(P.delMsg(K, 8, 1234), dsig), 'delete re-targeted to another post')
ok(!vfy(P.delMsg('cd'.repeat(32), 7, 1234), dsig), 'delete re-targeted to another author')

// ---- dm preview ----
ok(P.dmPreview(JSON.stringify({ k: 't', d: 'hey hey' })) === 'hey hey', 'preview text')
ok(P.dmPreview(JSON.stringify({ k: 'i', d: IMG })) === '[image]', 'preview image')
ok(P.dmPreview('raw legacy') === 'raw legacy', 'preview legacy')

// ---- nearby: near cards ----
const D = require('../src/discovery')
const now = Date.now()
const EDPK = b4a.toString(kp.publicKey, 'hex')
const sig64 = (m) => b4a.toString(sign(m), 'base64')
const vfy64 = (m, s) => vfy(m, b4a.from(s, 'base64'))
const card = (o) => { const c = P.makeNearCard({ via: 'area', key: K, edpk: EDPK, name: 'iglesias', place: 'Évry, FR', lat: 48.6312, lon: 2.4410, ts: now, ...o }); c.sig = sig64(P.nearMsg(c)); return c }
const good = card({})
ok(good.lat === 48.63 && good.lon === 2.44, 'near card not rounded to a town centre')
ok(P.cleanNear(good, now) && vfy64(P.nearMsg(P.cleanNear(good, now)), good.sig), 'near card roundtrip')
ok(!vfy64(P.nearMsg({ ...good, name: 'mallory' }), good.sig), 'near card name swap still verifies')
ok(!vfy64(P.nearMsg({ ...good, place: 'Oran, DZ' }), good.sig), 'near card place swap still verifies')
ok(!vfy64(P.nearMsg({ ...good, via: 'lan' }), good.sig), 'area card replayed as lan still verifies')
const piped = card({ name: 'a|b', place: 'c|d' })
ok(!piped.name.includes('|') && !piped.place.includes('|'), 'pipe kept in signed near fields')
ok(P.cleanNear({ ...good, name: 'a|b' }, now) === null, 'near card with pipe in name accepted')
ok(P.cleanNear({ ...good, lat: 48.6312 }, now) === null, 'near card finer than a town centre accepted')
ok(P.cleanNear({ ...good, lat: 91 }, now) === null, 'near card off the globe accepted')
ok(P.cleanNear(good, now + 11 * 60_000) === null, 'stale near card accepted')
ok(P.cleanNear({ ...good, name: '<img src=x onerror=1>'.repeat(5) }, now) === null, 'overlong near name accepted')
ok(P.cleanNear({ ...good, key: 'nothex' }, now) === null, 'near card with bad key accepted')
const lan = P.makeNearCard({ via: 'lan', key: K, edpk: EDPK, name: 'iglesias', place: 'Évry, FR', lat: 1, lon: 1, ts: now })
ok(lan.place === undefined && lan.lat === undefined, 'lan card leaks a place')
lan.sig = sig64(P.nearMsg(lan))
ok(P.cleanNear(lan, now) && P.cleanNear({ ...lan, place: 'x' }, now) === null, 'lan card place handling')
const bye = P.makeNearCard({ via: 'bye', key: K, edpk: EDPK, name: 'iglesias', ts: now }); bye.sig = sig64(P.nearMsg(bye))
ok(P.cleanNear(bye, now) && vfy64(P.nearMsg(bye), bye.sig), 'bye card roundtrip')
ok(!vfy64(P.nearMsg({ ...lan, via: 'bye' }), lan.sig), 'a presence card replayed as bye still verifies')

// ---- nearby: area grid ----
const meet = (a, b, rA, rB = rA) => {
  const ta = D.areaTopics(a[0], a[1], rA), tb = D.areaTopics(b[0], b[1], rB)
  const hit = (x, y) => y.some(t => t.client && x.some(u => u.server && u.cell === t.cell))
  return hit(ta, tb) || hit(tb, ta)
}
const PARIS = [48.85, 2.35], EVRY = [48.63, 2.44], LYON = [45.76, 4.84]
ok(Math.abs(D.distanceKm(...PARIS, ...EVRY) - 25.3) < 0.5, 'distance Paris–Évry')
ok(meet(PARIS, EVRY, 25), 'Paris and Évry do not meet at 25 km')
ok(meet(PARIS, EVRY, 10, 150), 'mixed radii do not meet')
ok(!meet(PARIS, LYON, 150), 'Paris and Lyon meet at 150 km')
ok(meet([-16.5, 179.9], [-16.5, -179.9], 25), 'cells do not wrap the antimeridian')
let misses = 0
for (let i = 0; i < 4000; i++) {
  const la = Math.random() * 140 - 70, lo = Math.random() * 360 - 180, b = Math.random() * 2 * Math.PI
  for (const [r, max] of [[50, 49], [150, 149]]) {
    const dk = Math.random() * max
    const lb = [la + dk / 111 * Math.cos(b), lo + dk / (111 * Math.cos(la * Math.PI / 180)) * Math.sin(b)]
    if (!meet([la, lo], lb, r)) misses++
  }
}
ok(misses === 0, `area grid missed ${misses} pairs within radius`)
ok(D.areaTopics(...PARIS, 25).every(t => t.topic.length === 32), 'area topic is not 32 bytes')

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
