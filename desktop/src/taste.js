// EMBER taste — what you're into, kept on your machine only.
//
//   topics   named rooms on the network (sha256("ember/v1/topic/{id}")). Picking
//            a topic joins its room; posting about a topic (recognised in EN, FR,
//            ZH or AR) also sends the post into that room. Rooms are reliable
//            where LSH buckets alone are too coarse to meet in.
//   compass  a direction in meaning-space learned from what you post, reply to,
//            save, mute or mark "not interested". It decays (a few weeks), so
//            you're never stuck with who you were last month. It is shown as its
//            strongest terms, and every term can be removed.
//   dial     FAMILIAR ↔ STRANGE: how far from the compass Discover reaches.
//
// Nothing in this file is ever sent anywhere. What the network can see is
// which rooms and buckets you join (see the decoys in main.js).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const disc = require('./discovery')

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'topics.json'), 'utf8')).topics
const BY_ID = new Map(CATALOG.map(t => [t.id, t]))
const LANGS = ['en', 'fr', 'zh', 'ar']
const TAU = 21 * 86_400_000   // compass memory: weights halve in ~2 weeks
const MAX_TERMS = 400

function topicTopic (id) { return crypto.createHash('sha256').update(`ember/v1/topic/${id}`).digest() }

// ---- recognising what a text is about ----
// Arabic: one spelling per word — no diacritics, one alef, final yaa/taa marbuta
// folded — and the article and its clinging prefixes (ال، وال، بال، لل…) removed,
// so «الموسيقى» and «موسيقى» are the same word
const normAr = (s) => s.replace(/[\u064B-\u0652\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
const stripAr = (w) => /^[\u0600-\u06FF]/.test(w) ? w.replace(/^(?:[وف]?(?:[بكل]?ال|لل))(?=[\u0600-\u06FF]{2})/, '') : w
const fold = (s) => normAr(String(s || '').normalize('NFKC').toLowerCase())
const isCJK = (s) => /[㐀-鿿豈-﫿]/.test(s)
// seed terms per topic, all languages; CJK terms are matched as substrings
// (no spaces in Chinese), others on word starts so "team" doesn't hit "steam"
const TERMS = new Map(CATALOG.map(t => [t.id, [...new Set(LANGS.flatMap(l => fold(t.seeds[l] || '').split(/\s+/)).concat((t.keys || []).map(fold)).map(stripAr).filter(w => w.length >= 2))]]))
// strong words: one of these alone is enough to say what a post is about
const KEYS = new Map(CATALOG.map(t => [t.id, new Set((t.keys || []).map(k => stripAr(fold(k))))]))
function words (text) { return fold(text).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).map(stripAr) }
function topicHits (text) {
  const t = fold(text); const ws = words(text)
  const out = []
  for (const [id, terms] of TERMS) {
    let hits = 0, key = false
    for (const term of terms) {
      const hit = isCJK(term) ? t.includes(term) : ws.some(w => w === term || (term.length >= 5 && w.startsWith(term.slice(0, Math.max(5, term.length - 2)))))
      if (hit) { hits++; if (KEYS.get(id).has(term)) key = true }
    }
    if (hits) out.push({ id, hits, key })
  }
  return out.sort((a, b) => b.hits - a.hits)
}
// topics a text is clearly about: two different seed terms, or one plus meaning
function classify (text, max = 2) {
  const v = disc.embed(text)
  const long = String(text || '').trim().length >= 25 // one weak word in a tiny post ("Hello World!") says nothing
  return topicHits(text).filter(h => h.hits >= 2 || h.key || (long && LANGS.some(l => disc.cosine(v, disc.embed(BY_ID.get(h.id).seeds[l] || '')) >= 0.2)))
    .slice(0, max).map(h => h.id)
}

// script-level language guess, enough for "languages I read"
function scriptOf (text) {
  const s = String(text || '')
  const han = (s.match(/[㐀-鿿]/g) || []).length, ara = (s.match(/[؀-ۿ]/g) || []).length, lat = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length
  if (han >= 2 && han >= lat / 4) return 'zh'
  if (ara >= 3 && ara >= lat / 2) return 'ar'
  return lat ? 'latin' : 'other'
}
function readable (text, langs) {
  const s = scriptOf(text)
  if (s === 'zh') return langs.includes('zh')
  if (s === 'ar') return langs.includes('ar')
  if (s === 'latin') return langs.includes('en') || langs.includes('fr')
  return true
}

// ---- compass ----
const STOP = new Set(('the a an and or but of to in on at for with from by is are was were be been it its this that i you he she we they my your our me us so not no do does did have has had will would can could should just about into very really like get got one all any some more most what when where who why how than then there here also too ' +
  'new now today tonight time make made want need going still even much many well way thing things day first last back good great lot dont im ive its youre thats there their them then '+
  'le la les un une des du de et ou mais dans sur pour avec par est sont il elle ils elles nous vous je tu ce cette ces son sa ses que qui pas ne plus tout tous très aussi bien encore ça fait faire suis être avoir mon ma mes ton ta tes nouveau nouvelle aujourd hui ' +
  'في من على الى إلى عن مع هذا هذه ذلك التي الذي هو هي انا أنا انت أنت نحن هم كان كانت لا ما لم لن قد كل بعد قبل ثم او أو اليوم').split(' '))
function keyTerms (text) {
  const out = new Set()
  for (const w of words(text)) {
    if (isCJK(w)) { for (let i = 0; i + 2 <= w.length && out.size < 30; i++) out.add(w.slice(i, i + 2)) } // Chinese: character bigrams
    else if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w)
  }
  return [...out].slice(0, 30)
}

class Taste {
  constructor (dir) {
    this.file = path.join(dir, 'taste.json')
    this.v = new Float32Array(disc.DIM)
    this.terms = new Map()
    this.ts = Date.now()
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(j.v) && j.v.length === disc.DIM) this.v = Float32Array.from(j.v)
      for (const [k, w] of j.terms || []) if (typeof k === 'string' && Number.isFinite(w)) this.terms.set(k, w)
      if (Number.isFinite(j.ts)) this.ts = j.ts
    } catch {}
  }
  save () { try { fs.writeFileSync(this.file, JSON.stringify({ v: [...this.v], terms: [...this.terms], ts: this.ts })) } catch {} }
  decay (now = Date.now()) {
    const f = Math.exp(-(now - this.ts) / TAU)
    if (f < 0.9999) { for (let i = 0; i < this.v.length; i++) this.v[i] *= f; for (const [k, w] of this.terms) { const x = w * f; if (Math.abs(x) < 0.02) this.terms.delete(k); else this.terms.set(k, x) } }
    this.ts = now
  }
  // weight > 0: more of this · < 0: less of this
  learn (text, weight) {
    if (!text || !weight) return
    this.decay()
    const e = disc.embed(text)
    for (let i = 0; i < e.length; i++) this.v[i] += weight * e[i]
    for (const t of keyTerms(text)) this.terms.set(t, (this.terms.get(t) || 0) + weight)
    if (this.terms.size > MAX_TERMS) {
      const keep = [...this.terms].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, MAX_TERMS)
      this.terms = new Map(keep)
    }
    this.save()
  }
  forget (term) {
    const w = this.terms.get(term); if (w === undefined) return false
    const e = disc.embed(term)
    for (let i = 0; i < e.length; i++) this.v[i] -= w * e[i]
    this.terms.delete(term); this.save(); return true
  }
  reset () { this.v = new Float32Array(disc.DIM); this.terms.clear(); this.save() }
  top (n = 16) { return [...this.terms].filter(([, w]) => w > 0.05).sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, w]) => ({ term, w: Math.round(w * 100) / 100 })) }
  avoid (n = 8) { return [...this.terms].filter(([, w]) => w < -0.05).sort((a, b) => a[1] - b[1]).slice(0, n).map(([term, w]) => ({ term, w: Math.round(w * 100) / 100 })) }
  // the direction Discover aims at: the learned compass blended with the topics picked
  vector (topicIds = [], langs = ['en'], extra = '') {
    const out = new Float32Array(disc.DIM)
    const add = (vec, k) => { let n = 0; for (const x of vec) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < out.length; i++) out[i] += k * vec[i] / n }
    const seedText = topicIds.map(id => BY_ID.get(id)).filter(Boolean).flatMap(t => langs.map(l => t.seeds[l] || '')).join(' ') + ' ' + (extra || '')
    if (seedText.trim()) add(disc.embed(seedText), 0.45)
    let learned = 0; for (const x of this.v) learned += x * x
    if (learned > 1e-6) add(this.v, 0.55)
    let n = 0; for (const x of out) n += x * x
    return n > 0 ? out : null
  }
}

// FAMILIAR (0) … STRANGE (3): which buckets to sit in around the compass
function compassTopics (vec, dial) {
  if (!vec) return []
  const cs = disc.codes(vec)
  const out = new Map()
  const push = (table, code) => { const t = disc.topicFor(table, code & ((1 << disc.BITS) - 1)); out.set(t.toString('hex'), t) }
  for (const c of cs) push(c.table, c.code)                                   // always: the compass itself
  if (dial >= 1) for (const c of cs) push(c.table, c.code ^ 1)                // a step aside
  if (dial >= 2) for (const c of cs) push(c.table, c.code ^ 6)                // two steps
  if (dial >= 3) for (const c of cs) push(c.table, c.code ^ ((1 << disc.BITS) - 1)) // the opposite corner
  return [...out.values()]
}
// rank Discover: FAMILIAR prefers posts closest to the compass, STRANGE prefers
// the ones furthest from it that still arrived in your buckets
function rank (items, vec, dial, now = Date.now()) {
  if (!vec) return items.map(a => ({ ...a, near: null })).sort((a, b) => b.ts - a.ts)
  const sims = items.map(a => disc.cosine(vec, disc.embed(a.text || '')))
  const max = Math.max(0.05, ...sims)
  const target = max * (1 - dial / 3)
  return items.map((a, i) => {
    const rec = Math.exp(-(now - a.ts) / (3 * 86_400_000))
    return { ...a, near: sims[i], rank: 0.72 * (1 - Math.abs(sims[i] - target) / max) + 0.28 * rec }
  }).sort((a, b) => b.rank - a.rank)
}
// the honest one-line reason a post is in your Discover
function why (item, ctx) {
  if (ctx.query) return { k: 'search' }
  if (ctx.follows.has(item.author)) return { k: 'follow' }
  const ts = classify(item.text).filter(id => ctx.topics.includes(id))
  if (ts.length) return { k: 'topic', topic: ts[0] }
  const mine = new Set(ctx.terms)
  const shared = keyTerms(item.text).filter(t => mine.has(t)).slice(0, 2)
  if (shared.length) return { k: 'compass', terms: shared }
  if (item.near != null && item.near > 0.15) return { k: 'near' }
  return { k: 'wide' }
}

module.exports = { CATALOG, LANGS, Taste, topicTopic, classify, topicHits, keyTerms, scriptOf, readable, compassTopics, rank, why }
