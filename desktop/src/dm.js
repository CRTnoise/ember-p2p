// EMBER DMs — E2E encrypted direct messages.
//
// Reachability: every identity has an inbox topic hash('ember/v1/dm/' + hexKey).
// You always sit in your own inbox topic; to message someone you join theirs.
//
// Encryption: Ed25519 feed keys are converted to Curve25519 and messages are
// sealed with crypto_box (XSalsa20-Poly1305, authenticated). A message that
// decrypts against a claimed sender's public key IS proof of that sender —
// no separate signature needed. Content is end-to-end encrypted.
//
// What is NOT hidden (see SECURITY.md): inbox topics are derived from public
// keys, so anyone can join yours. Peers connected to it learn the `from`/`to`
// routing fields, timing, message sizes and IP addresses of connections.
// Hyperswarm's Noise encryption only protects the wire between two sockets.
//
// Delivery: live when both sides are online; otherwise queued locally and
// handed over only to a socket that proves (dmhello challenge → dmproof
// signature) that it holds the recipient's identity key. History is local only.

const crypto = require('crypto')
const sodium = require('sodium-universal')
const b4a = require('b4a')

function inboxTopic (hexKey) {
  return crypto.createHash('sha256').update(`ember/v1/dm/${hexKey}`).digest()
}

function curveKeys (edKeyPair) {
  const pk = b4a.alloc(32); const sk = b4a.alloc(32)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, edKeyPair.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(sk, edKeyPair.secretKey)
  return { pk, sk }
}

// NOTE: core.key in Hypercore v11 is the manifest hash, NOT the signer key —
// it cannot be converted to Curve25519. DM keys are therefore the underlying
// Ed25519 signer publicKey, published in the author's (self-signed) profile
// block. Fetching it from the author's core = authenticated key distribution.

function curvePk (edPublicKeyHex) {
  const pk = b4a.alloc(32)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, b4a.from(edPublicKeyHex, 'hex'))
  return pk
}

function seal (text, theirEdPkHex, myCurveSk) {
  const msg = b4a.from(text)
  const nonce = b4a.alloc(sodium.crypto_box_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const boxed = b4a.alloc(msg.length + sodium.crypto_box_MACBYTES)
  sodium.crypto_box_easy(boxed, msg, nonce, curvePk(theirEdPkHex), myCurveSk)
  return { n: b4a.toString(nonce, 'base64'), c: b4a.toString(boxed, 'base64') }
}

function open (payload, senderEdPkHex, myCurveSk) {
  try {
    const nonce = b4a.from(payload.n, 'base64')
    const boxed = b4a.from(payload.c, 'base64')
    if (boxed.length <= sodium.crypto_box_MACBYTES || boxed.length > 600000) return null
    const out = b4a.alloc(boxed.length - sodium.crypto_box_MACBYTES)
    const ok = sodium.crypto_box_open_easy(out, boxed, nonce, curvePk(senderEdPkHex), myCurveSk)
    if (ok === false) return null
    return b4a.toString(out)
  } catch { return null }
}

module.exports = { inboxTopic, curveKeys, seal, open }
