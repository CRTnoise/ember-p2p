// EMBER discovery layer — Semantic DHT Layer 1 (LSH placement) over Hyperswarm.
//
// Every post is embedded, hashed into L LSH codes, and each code becomes a
// swarm topic. Clients join the topics nearest to what they write/read, so
// semantically-close users find each other with no key exchange and no rooms.
//
// V1 embedding = feature-hashed character n-grams (deterministic, model-free).
// Captures topical/lexical proximity. embed() is the only function to swap
// when upgrading to sentence embeddings or VSA sketches.

const crypto = require('crypto')

const DIM = 256          // embedding dimensionality
const BITS = 4           // coarse: buckets are candidate generation, cosine re-ranks at read time
const TABLES = 8         // L amplification tables
const STOPWORDS = new Set(('the a an and or but of to in on at for with from by is are was were be been being it its this that these those i you he she we they them his her their our your my me us as if so not no do does did done have has had will would can could should than then there here what which who whom when where why how all any both each few more most other some such only own same very just about into over under again once ' +
  'le la les un une des du de et ou mais dans sur pour avec par est sont etait ete etre il elle ils elles nous vous je tu me te se ce cette ces cet son sa ses leur leurs notre nos votre vos mon ma mes que qui quoi dont ou quand comment pourquoi pas ne plus moins tres tout tous toute toutes autre autres meme aussi bien encore deja').split(' '))
const PROTO_SEED = 'ember/v1/lsh' // protocol constant: every client derives identical hyperplanes

// ---------- embedding ----------

function embed (text) {
  const v = new Float32Array(DIM)
  const raw = (text || '').replace(/\*\*|\*|~~|`/g, '').toLowerCase() // md markers stripped: meaning only
  const t = ' ' + raw.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim() + ' '
  // word-level features: whole words + crude prefix stems; stopwords carry
  // almost no topical signal in either language, so they're heavily downweighted
  const words = t.trim().split(' ').filter(w => w.length > 1)
  const feats = []
  for (const w of words) {
    const sw = STOPWORDS.has(w) ? 0.15 : 1
    feats.push(['w' + w, 1.4 * sw])
    if (w.length > 3 && sw === 1) feats.push(['s' + w.slice(0, 4), 1.6])
  }
  // word bigrams (weight 1.5): phrases
  for (let i = 0; i + 1 < words.length; i++) feats.push(['b' + words[i] + '_' + words[i + 1], 1.5])
  // char n-grams (weight 1/n): typos + morphology
  for (const n of [3, 4]) {
    for (let i = 0; i + n <= t.length; i++) feats.push(['g' + n + t.slice(i, i + n), 1 / n])
  }
  for (const [f, w] of feats) {
    const h = crypto.createHash('sha1').update(f).digest()
    const idx = h.readUInt32BE(0) % DIM
    const sign = (h[4] & 1) ? 1 : -1
    v[idx] += sign * w
  }
  let norm = 0; for (let i = 0; i < DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

// ---------- LSH ----------

// Deterministic pseudo-random hyperplanes from the protocol seed.
function hyperplane (table, bit) {
  const r = new Float32Array(DIM)
  let counter = 0
  for (let i = 0; i < DIM; i += 8) {
    const h = crypto.createHash('sha256').update(`${PROTO_SEED}/${table}/${bit}/${counter++}`).digest()
    for (let j = 0; j < 8 && i + j < DIM; j++) {
      // map 4 bytes -> approx N(0,1) via sum of uniforms
      const u = (h.readUInt32BE(j * 4) / 0xffffffff)
      r[i + j] = (u - 0.5) * 3.46 // variance-matched uniform
    }
  }
  return r
}

const PLANES = [] // [table][bit] -> Float32Array
for (let ti = 0; ti < TABLES; ti++) {
  PLANES.push(Array.from({ length: BITS }, (_, b) => hyperplane(ti, b)))
}

function codes (vec) {
  const out = []
  for (let ti = 0; ti < TABLES; ti++) {
    let code = 0
    for (let b = 0; b < BITS; b++) {
      let dot = 0
      const p = PLANES[ti][b]
      for (let i = 0; i < DIM; i++) dot += vec[i] * p[i]
      code = (code << 1) | (dot >= 0 ? 1 : 0)
    }
    out.push({ table: ti, code })
  }
  return out
}

function topicFor (table, code) {
  return crypto.createHash('sha256').update(`ember/v1/disc/${table}/${code}`).digest()
}

function topicsForText (text) {
  return codes(embed(text)).map(c => topicFor(c.table, c.code))
}

// Multi-probe LSH: also derive the 1-bit-flip neighbors of each code.
// Near-miss content (cosine just under the collision threshold) usually lands
// one hamming step away — probing neighbors buys recall without more tables.
function probeTopicsForText (text, maxTopics = 24) {
  const cs = codes(embed(text))
  const topics = []
  const seen = new Set()
  const push = (t, c) => {
    const buf = topicFor(t, c); const k = buf.toString('hex')
    if (!seen.has(k)) { seen.add(k); topics.push(buf) }
  }
  for (const c of cs) push(c.table, c.code)              // primary buckets first
  for (const c of cs) {
    for (let b = 0; b < BITS && topics.length < maxTopics; b++) push(c.table, c.code ^ (1 << b))
  }
  return topics.slice(0, maxTopics)
}

// Global rendezvous: every client joins. At small scale this guarantees the
// network is one connected gossip component; LSH buckets add proximity on top.
// At large scale, clients can stop joining it (V2 network-size heuristic).
function commonsTopic () {
  return crypto.createHash('sha256').update('ember/v1/commons').digest()
}

function replyTopic (author, seq) {
  return crypto.createHash('sha256').update(`ember/v1/replies/${author}/${seq}`).digest()
}

function cosine (a, b) {
  let d = 0; for (let i = 0; i < DIM; i++) d += a[i] * b[i]
  return d
}

module.exports = { commonsTopic, probeTopicsForText, embed, codes, topicsForText, replyTopic, cosine, TABLES, BITS, DIM }
