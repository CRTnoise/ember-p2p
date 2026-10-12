// Campfires between three in-memory peers: lights at 3, signed messages relay,
// forged and blocked messages are dropped, the fire goes out when someone leaves.
// Run: node test/fires.test.js
const sodium = require('sodium-universal')
const b4a = require('b4a')
const crypto = require('crypto')
const { Fires } = require('../src/fires')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }

function person (name, blocked = new Set()) {
  const pk = b4a.alloc(32), sk = b4a.alloc(64); sodium.crypto_sign_keypair(pk, sk)
  const me = { key: crypto.randomBytes(32).toString('hex'), edpk: b4a.toString(pk, 'hex'), name }
  const sign = (s) => { const sig = b4a.alloc(64); sodium.crypto_sign_detached(sig, b4a.from(s), sk); return b4a.toString(sig, 'base64') }
  const verify = (s, sig, edpk) => { try { return sodium.crypto_sign_verify_detached(b4a.from(sig, 'base64'), b4a.from(s), b4a.from(edpk, 'hex')) } catch { return false } }
  const events = []
  const f = new Fires({ me: () => me, sign, verify, knownEdPk: () => undefined, hidden: (k) => blocked.has(k), onChange: (e) => events.push(e), terms: () => ['pixel', 'palette'] })
  return { me, f, events, sign }
}
// a pair of fake sockets: whatever one writes, the other side's Fires receives
function link (a, b) {
  const mk = (to) => { const s = { write: (line) => { const m = JSON.parse(line); queueMicrotask(() => { if (m.t === 'fire-here') to.f.onHere(s.peer, m); else if (m.t === 'fire-msg') to.f.onMsg(s.peer, m.m) }) } }; return s }
  const sa = mk(b), sb = mk(a); sa.peer = sb; sb.peer = sa
  a.f.attach(sa); b.f.attach(sb)
  return () => { a.f.detach(sa); b.f.detach(sb) }
}
const tick = () => new Promise(r => setTimeout(r, 20))

;(async () => {
  const A = person('ana'), B = person('ben'), C = person('cyd')
  for (const p of [A, B, C]) p.f.setMine(['pixel', 'music'])
  link(A, B); await tick()
  ok(!A.f.list().find(x => x.fire === 'pixel').lit, 'lit with only two people')
  const cutC = link(A, C); link(B, C); await tick()
  const fa = A.f.list().find(x => x.fire === 'pixel')
  ok(fa.lit && fa.people === 3, 'not lit with three people: ' + JSON.stringify(fa))
  ok(A.events.some(e => e.lit === 'pixel' || e.lit === 'music'), 'no "lit" event')
  ok(fa.terms.includes('pixel'), 'shared words missing from the label')

  A.f.send('pixel', 'anyone tried the new aseprite palette tools?'); await tick()
  ok(B.f.messages('pixel').some(m => m.text.includes('aseprite')), 'B did not get the message')
  ok(C.f.messages('pixel').length === 1, 'C got the message ' + C.f.messages('pixel').length + ' times (relay loop?)')
  ok(B.f.messages('music').length === 0, 'message leaked into another fire')

  // forged: claims to be A, signed by B
  const forged = { fire: 'pixel', author: A.me.key, edpk: A.me.edpk, name: 'ana', ts: Date.now(), text: 'i am ana, trust me' }
  forged.sig = B.sign(require('../src/protocol').fireMsg(forged))
  C.f.onMsg(null, forged); await tick()
  ok(!C.f.messages('pixel').some(m => m.text.includes('trust me')), 'forged message accepted')

  // blocked author: dropped
  const D = person('dee', new Set([A.me.key])); D.f.setMine(['pixel'])
  link(D, B); await tick()
  A.f.send('pixel', 'second message'); await tick()
  ok(!D.f.messages('pixel').some(m => m.author === A.me.key), 'blocked author shown')

  // C leaves: A's fire drops to 2 others (B, D)… D doesn't know A, but A still sees B; cut C and D's link
  cutC(); await tick()
  const after = A.f.list().find(x => x.fire === 'pixel')
  ok(after.people === 2 && !after.lit, 'fire still lit after C left: ' + JSON.stringify(after))
  ok(A.f.messages('pixel').length === 0, 'messages outlived the fire')

  // decoys: E sits silently at 'film' (a decoy), F and G really picked it
  const E = person('eve'), F = person('fox'), G = person('gus')
  const said = []
  E.f.setMine(['pixel'], ['film', 'pixel']); F.f.setMine(['film']); G.f.setMine(['film'])
  const sockE = { write: (l) => said.push(JSON.parse(l)) }; E.f.attach(sockE)
  const decl = said.find(m => m.t === 'fire-here')
  ok(decl && decl.fires.join() === 'film,pixel', 'decoys not declared, or declared in a telling order: ' + JSON.stringify(decl && decl.fires))
  E.f.detach(sockE)
  link(E, F); link(E, G); await tick() // F and G only meet through E
  const ff = F.f.list().find(x => x.fire === 'film')
  ok(ff.people === 2, 'F does not count E at the film fire: ' + JSON.stringify(ff))
  ok(!E.f.list().some(x => x.fire === 'film'), 'a decoy fire shows up in the list')
  let threw = false; try { E.f.send('film', 'x') } catch { threw = true }
  ok(threw, 'could speak at a decoy fire')
  F.f.send('film', 'anyone seen the new restoration?'); await tick()
  ok(G.f.messages('film').some(m => m.text.includes('restoration')), 'a decoy listener does not relay')
  ok(E.f.messages('film').length === 0, 'a decoy listener keeps messages')

  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
})()
