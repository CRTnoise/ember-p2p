// SAME AREA over a real (private, local) DHT: three peers opt into areas,
// only the two within each other's radius should end up on each other's list.
// Run: node test/nearby-area.test.js
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const sodium = require('sodium-universal')
const b4a = require('b4a')
const crypto = require('crypto')
const { Nearby } = require('../src/nearby')

function identity (name) {
  const pk = b4a.alloc(32), sk = b4a.alloc(64); sodium.crypto_sign_keypair(pk, sk)
  return { key: crypto.randomBytes(32).toString('hex'), edpk: b4a.toString(pk, 'hex'), name,
    sign: (s) => { const sig = b4a.alloc(64); sodium.crypto_sign_detached(sig, b4a.from(s), sk); return b4a.toString(sig, 'base64') } }
}
const verify = (s, sig, pk) => { try { return sodium.crypto_sign_verify_detached(b4a.from(sig, 'base64'), b4a.from(s), b4a.from(pk, 'hex')) } catch { return false } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  const testnet = await createTestnet(4)
  const mk = (me) => new Nearby({ me: () => me, sign: me.sign, verify, knownEdPk: () => undefined, isBlocked: () => false, onChange: () => {},
    // a fresh local DHT node per swarm, bound to loopback so the test runs anywhere
    swarmOpts: () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) }) })
  const alice = identity('alice'), bob = identity('bob'), carol = identity('carol')
  const na = mk(alice), nb = mk(bob), nc = mk(carol)
  await na.startArea({ place: 'Paris, FR', lat: 48.85, lon: 2.35, radius: 50 })
  await nb.startArea({ place: 'Évry, FR', lat: 48.63, lon: 2.44, radius: 10 })   // smaller radius: still announced, filtered client-side
  await nc.startArea({ place: 'Lyon, FR', lat: 45.76, lon: 4.84, radius: 150 })
  const names = (n) => n.list().filter(p => p.area).map(p => `${p.name}@${p.area.km}km`)
  for (let i = 0; i < 40 && !(names(na).length && names(nb).length === 0 && na.area.sockets.size); i++) await sleep(500)
  await sleep(1500)
  const A = names(na), B = names(nb), C = names(nc)
  console.log('alice (Paris, 50km):', A, '· bob (Évry, 10km):', B, '· carol (Lyon, 150km):', C)
  let fail = 0
  const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m) } }
  ok(A.length === 1 && A[0].startsWith('bob@25'), 'alice should see bob at ~25 km')
  ok(B.length === 0, 'bob (10 km radius) should not list alice 25 km away')
  ok(C.length === 0, 'carol in Lyon should see nobody')
  ok(!A.some(x => x.startsWith('carol')), 'alice should not see carol (391 km)')
  const t0 = Date.now()
  await nb.stopArea()                       // bob turns SAME AREA off → his bye reaches alice at once
  for (let i = 0; i < 40 && names(na).some(x => x.startsWith('bob')); i++) await sleep(250) // (or, if the bye is lost, his closed connection does within seconds)
  const gone = Date.now() - t0
  ok(!names(na).some(x => x.startsWith('bob')), 'bob should vanish from alice\'s list when he stops')
  console.log('bob gone from alice\'s list after', gone, 'ms')
  await na.stopArea()
  ok(na.list().length === 0, 'stopping area should clear area people')
  await Promise.all([nb.destroy(), nc.destroy()]); await testnet.destroy()
  console.log(fail ? `${fail} failed` : 'area test passed'); process.exit(fail ? 1 : 0)
})()
