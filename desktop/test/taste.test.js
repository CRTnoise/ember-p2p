// Taste: topic recognition in four languages, the compass (learn, forget, fade),
// the FAMILIAR↔STRANGE dial, "why am I seeing this", and the modlist block.
// Run: node test/taste.test.js
const fs = require('fs'); const os = require('os'); const path = require('path')
const taste = require('../src/taste')
const disc = require('../src/discovery')
const P = require('../src/protocol')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const has = (text, id) => taste.classify(text).includes(id)

// ---- catalog ----
ok(taste.CATALOG.length >= 20, 'catalog too small')
for (const t of taste.CATALOG) {
  ok(/^[a-z0-9-]{1,32}$/.test(t.id), 'topic id not a valid fire id: ' + t.id)
  for (const l of taste.LANGS) ok(t.label[l] && t.seeds[l], `topic ${t.id} missing ${l}`)
}
ok(taste.topicTopic('music').length === 32, 'topic room is not 32 bytes')
ok(!taste.topicTopic('music').equals(taste.topicTopic('art')), 'two topics share a room')

// ---- recognising what a post is about, in each language ----
ok(has('Finished the risograph run this morning, two passes, pink then blue', 'art'), 'EN art')
ok(has('new synth patch for tonight\'s rehearsal, mixtape soon', 'music'), 'EN music')
ok(has('Rust borrow checker finally clicked, refactoring the whole parser', 'code'), 'EN code')
ok(has('Le match de foot ce soir, quel but à la dernière minute', 'football'), 'FR football')
ok(has('je lis un roman de Camus, la littérature française me manquait', 'books'), 'FR books')
ok(has('今天去看了一部电影，导演的镜头语言太美了', 'film'), 'ZH film')
ok(has('周末在家做饭，红烧肉和米饭', 'food'), 'ZH food')
ok(has('أحب الموسيقى العربية القديمة، أم كلثوم وفيروز', 'music'), 'AR music')
ok(taste.classify('Hello World!').length === 0, 'a greeting got a topic')
ok(taste.classify('ok').length === 0, 'two letters got a topic')
ok(taste.classify('music art code football food film books science').length <= 2, 'more than 2 topics per post')

// ---- scripts / languages I read ----
ok(taste.scriptOf('今天天气很好') === 'zh', 'zh script')
ok(taste.scriptOf('مرحبا بالعالم الجميل') === 'ar', 'ar script')
ok(taste.scriptOf('bonjour tout le monde') === 'latin', 'latin script')
ok(taste.readable('今天天气很好', ['en', 'fr']) === false, 'zh readable without zh')
ok(taste.readable('今天天气很好', ['zh']) === true, 'zh unreadable with zh')
ok(taste.readable('hello there', ['fr']) === true, 'latin unreadable for a French reader')
ok(taste.readable('🔥🔥🔥', ['ar']) === true, 'emoji-only post hidden')

// ---- compass: learn, forget, fade, persist ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-taste-'))
const t = new taste.Taste(dir)
ok(t.vector([], ['en']) === null, 'empty compass has a direction')
t.learn('risograph zine printing two colours', 1)
t.learn('riso print register drift zine', 1)
ok(t.top(5).some(x => x.term === 'zine'), 'learned term missing from top')
ok(t.vector([], ['en']) !== null, 'learned compass has no direction')
t.learn('crypto token pump airdrop', -1)
ok(t.avoid().some(x => x.term === 'crypto'), 'negative term missing from avoid')
ok(!t.top(50).some(x => x.term === 'crypto'), 'negative term listed as liked')
ok(t.forget('zine') && !t.top(50).some(x => x.term === 'zine'), 'forget failed')
ok(!t.forget('never-seen'), 'forgetting an unknown word reported success')
const t2 = new taste.Taste(dir)
ok(t2.top(50).some(x => x.term === 'riso') && !t2.top(50).some(x => x.term === 'zine'), 'compass not persisted')
const w0 = t2.terms.get('riso'); t2.ts -= 21 * 86_400_000; t2.decay()
ok(t2.terms.get('riso') < w0 * 0.4, 'compass does not fade')
t2.reset(); ok(t2.top().length === 0 && t2.vector([], ['en']) === null, 'reset kept something')
ok(new taste.Taste(dir).top().length === 0, 'reset not persisted')
const tv = new taste.Taste(dir)
ok(tv.vector(['music'], ['en']) !== null, 'topics alone give no direction')
ok(disc.cosine(tv.vector(['music'], ['en']), disc.embed('band music album concert')) > disc.cosine(tv.vector(['music'], ['en']), disc.embed('football match goal league')), 'music compass closer to football')

// ---- the dial ----
const vec = tv.vector(['art'], ['en'])
const sizes = [0, 1, 2, 3].map(d => taste.compassTopics(vec, d).length)
ok(sizes[0] === disc.TABLES && sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] < sizes[3], 'dial does not widen: ' + sizes)
ok(taste.compassTopics(null, 2).length === 0, 'no compass still joins buckets')
const now = Date.now()
const items = [
  { text: 'risograph print zine two colours', ts: now },
  { text: 'linocut printmaking poster', ts: now },
  { text: 'football league match goal', ts: now }
]
// the dial picks the band; inside it, newest first
const close = ['risograph print zine two colours', 'riso zine print shop', 'zine risograph colours print', 'linocut printmaking poster', 'printmaking ink poster', 'two colour print poster']
const far = ['football league match goal', 'tax return deadline form', 'kubernetes cluster upgrade', 'marathon training plan', 'stock market quarterly', 'volcano eruption iceland']
const pool = [...close, ...far].map((text, i) => ({ text, ts: now - i * 3600_000 }))
const fam = taste.rank(pool, vec, 0), str = taste.rank(pool, vec, 3)
const isClose = (a) => close.includes(a.text)
ok(fam.length >= 4 && fam.filter(isClose).length >= fam.length - 1, 'FAMILIAR is not mostly close posts: ' + fam.map(a => a.text.slice(0, 12)))
ok(str.length >= 4 && str.filter(a => !isClose(a)).length >= str.length - 1, 'STRANGE is not mostly far posts: ' + str.map(a => a.text.slice(0, 12)))
for (const [name, list] of [['FAMILIAR', fam], ['STRANGE', str], ['step 1', taste.rank(pool, vec, 1)], ['step 2', taste.rank(pool, vec, 2)]]) {
  ok(list.every((a, i) => i === 0 || list[i - 1].ts >= a.ts), name + ' is not newest-first')
}
ok(taste.rank(pool, vec, 1).length > fam.length && taste.rank(pool, vec, 2).length > str.length, 'middle steps are not wider')
ok(taste.rank(items, vec, 0).length === 3, 'a tiny network hides posts')
ok(taste.rank(items, null, 1).length === 3 && taste.rank(items, null, 1).every((a, i, l) => i === 0 || l[i - 1].ts >= a.ts), 'no compass: not everything newest-first')
const damped = taste.rank(pool, vec, 0, (a) => a.text === close[0] ? 0.01 : 1)
ok(!damped.some(a => a.text === close[0]), 'a ranked-down post stays in FAMILIAR')

// ---- why am I seeing this ----
const ctx = { query: '', follows: new Set(['f'.repeat(64)]), topics: ['art'], terms: ['riso', 'zine'] }
ok(taste.why({ author: 'a'.repeat(64), text: 'x' }, { ...ctx, query: 'riso' }).k === 'search', 'why: search')
ok(taste.why({ author: 'f'.repeat(64), text: 'football' }, ctx).k === 'follow', 'why: follow')
ok(taste.why({ author: 'a'.repeat(64), text: 'risograph printing, two passes of pink and blue ink' }, ctx).k === 'topic', 'why: topic')
const wc = taste.why({ author: 'a'.repeat(64), text: 'my riso is jammed again' }, { ...ctx, topics: [] })
ok(wc.k === 'compass' && wc.terms.includes('riso'), 'why: compass words')
ok(taste.why({ author: 'a'.repeat(64), text: 'zzz qqq', near: 0.01 }, ctx).k === 'wide', 'why: wide')

// ---- modlist block ----
const keys = ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64), 'nope', 42, 'C'.repeat(64)]
const m = P.sanitizeBlock({ type: 'modlist', keys, ts: 5, extra: 1 })
ok(m && m.keys.length === 2 && m.extra === undefined && m.ts === 5, 'modlist not cleaned: ' + JSON.stringify(m))
ok(P.sanitizeBlock({ type: 'modlist', keys: 'x' }).keys.length === 0, 'modlist with junk keys')
ok(P.sanitizeBlock({ type: 'modlist', keys: Array.from({ length: 6000 }, (_, i) => i.toString(16).padStart(64, '0')) }).keys.length === 5000, 'modlist not capped')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
