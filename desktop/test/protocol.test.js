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

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
