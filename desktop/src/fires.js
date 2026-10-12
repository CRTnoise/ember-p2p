// EMBER campfires — live, temporary rooms nobody creates.
//
// Everyone who picked a topic sits in that topic's room on the network. When
// at least three people (you + 2) are in the same room at the same moment, a
// campfire lights: a small live chat about whatever they're all into. It has no
// owner and no name beyond the topic and the words its members share, nothing
// is stored on disk, and it goes out when people leave.
//
// Wire format (over gossip connections, newline JSON):
//   {t:'fire-here', key, name, fires:[topicId…], terms:[…]}   who I am, which fires I sit at (refreshed every 60 s)
//   {t:'fire-msg', m:{fire, author, edpk, name, ts, text, sig}} a signed message (protocol.fireMsg)
const P = require('./protocol')

const LIT_AT = 2            // others needed, besides you, for a fire to burn
const MEMBER_TTL = 3 * 60_000
const KEEP = 200            // messages remembered per fire, in memory only
const FIRE_ID = /^[a-z0-9-]{1,32}$/

class Fires {
  // me(): {key, edpk, name} · sign(str) · verify(str, sig, edpk) · knownEdPk(key)
  // hidden(key) → true for blocked/muted/list-hidden authors · onChange({lit}) · terms() → my top words
  constructor ({ me, sign, verify, knownEdPk, hidden, onChange, terms }) {
    Object.assign(this, { me, sign, verify, knownEdPk, hidden, onChange, terms })
    this.mine = []                 // topic ids I sit at
    this.decoys = []               // decoy topics: declared and relayed like real ones, never shown or spoken in
    this.members = new Map()       // fire -> Map(key -> {name, terms, seen, sockets:Set})
    this.msgs = new Map()          // fire -> [msg]
    this.seen = new Set()
    this.sockets = new Set()
    this.lit = new Set()
    this.rl = new Map()            // author -> {tokens, ts}
  }

  // Which fires I declare is visible to every gossip peer, so the decoy rooms
  // are declared too: otherwise this list would give the real topics away. At a
  // decoy fire I'm a silent listener who relays; it never shows up for the user.
  setMine (ids, decoys = []) {
    const next = [...new Set(ids)].filter(id => FIRE_ID.test(id)).slice(0, 8)
    const nextD = [...new Set(decoys)].filter(id => FIRE_ID.test(id) && !next.includes(id)).slice(0, Math.max(0, 8 - next.length))
    if (next.join() === this.mine.join() && nextD.join() === this.decoys.join()) return
    this.mine = next; this.decoys = nextD
    for (const s of this.sockets) this.hello(s)
    this.changed()
  }

  hello (socket) {
    const m = this.me()
    const fires = [...this.mine, ...this.decoys].sort() // sorted: the order mustn't tell which are real
    try { socket.write(JSON.stringify({ t: 'fire-here', key: m.key, name: P.nearText(m.name, 40), fires, terms: (this.terms() || []).slice(0, 5) }) + '\n') } catch {}
  }

  attach (socket) { this.sockets.add(socket); this.hello(socket) }
  detach (socket) {
    this.sockets.delete(socket)
    for (const mem of this.members.values()) for (const [k, p] of mem) { p.sockets.delete(socket); if (!p.sockets.size) mem.delete(k) }
    this.changed()
  }
  refresh () { for (const s of this.sockets) this.hello(s); this.prune(); this.changed() }

  onHere (socket, msg) {
    if (!msg || typeof msg.key !== 'string' || !P.HEX64.test(msg.key) || msg.key === this.me().key) return
    if (!Array.isArray(msg.fires) || msg.fires.length > 8) return
    const fires = new Set(msg.fires.filter(f => typeof f === 'string' && FIRE_ID.test(f)))
    const name = P.nearText(msg.name, 40)
    const terms = Array.isArray(msg.terms) ? msg.terms.filter(t => typeof t === 'string' && t.length <= 24).slice(0, 5).map(t => P.nearText(t, 24)) : []
    socket._fireKey = msg.key
    for (const [fire, mem] of this.members) if (!fires.has(fire)) { const p = mem.get(msg.key); if (p) { p.sockets.delete(socket); if (!p.sockets.size) mem.delete(msg.key) } }
    for (const fire of fires) {
      if (!this.members.has(fire)) this.members.set(fire, new Map())
      const mem = this.members.get(fire)
      const p = mem.get(msg.key) || { sockets: new Set() }
      Object.assign(p, { name, terms, seen: Date.now() }); p.sockets.add(socket)
      mem.set(msg.key, p)
    }
    this.changed()
  }

  allow (author) {
    const now = Date.now(); const r = this.rl.get(author) || { tokens: 5, ts: now }
    r.tokens = Math.min(5, r.tokens + (now - r.ts) / 2000); r.ts = now
    this.rl.set(author, r)
    if (r.tokens < 1) return false
    r.tokens--; return true
  }

  onMsg (socket, raw) {
    const m = P.cleanFire(raw, Date.now())
    if (!m || !(this.mine.includes(m.fire) || this.decoys.includes(m.fire)) || this.hidden(m.author)) return
    if (m.author === this.me().key) return
    const id = `${m.author}:${m.ts}:${m.sig.slice(0, 16)}`
    if (this.seen.has(id)) return
    if (!this.verify(P.fireMsg(m), m.sig, m.edpk)) return
    const known = this.knownEdPk(m.author)
    if (known && known !== m.edpk) return // signed with a key that isn't theirs
    if (!this.allow(m.author)) return
    this.seen.add(id); if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500))
    if (this.mine.includes(m.fire)) this.store({ ...m, id, verified: !!known })
    this.relay(m, socket)
  }

  store (m) {
    if (!this.msgs.has(m.fire)) this.msgs.set(m.fire, [])
    const list = this.msgs.get(m.fire); list.push(m); if (list.length > KEEP) list.splice(0, list.length - KEEP)
    this.changed(m.fire)
  }

  // to everyone else sitting at that fire (by what they declared), never back
  relay (m, from) {
    const mem = this.members.get(m.fire); if (!mem) return
    const line = JSON.stringify({ t: 'fire-msg', m: { fire: m.fire, author: m.author, edpk: m.edpk, name: m.name, ts: m.ts, text: m.text, sig: m.sig } }) + '\n'
    const done = new Set([from])
    for (const p of mem.values()) for (const s of p.sockets) { if (done.has(s)) continue; done.add(s); try { s.write(line) } catch {} }
  }

  send (fire, text) {
    if (!this.mine.includes(fire)) throw new Error('not at this fire')
    text = String(text || '').trim().slice(0, 400)
    if (!text) return null
    const me = this.me()
    const m = { fire, author: me.key, edpk: me.edpk, name: P.nearText(me.name, 40), ts: Date.now(), text }
    m.sig = this.sign(P.fireMsg(m))
    const id = `${m.author}:${m.ts}:${m.sig.slice(0, 16)}`
    this.seen.add(id)
    this.store({ ...m, id, mine: true, verified: true })
    this.relay(m, null)
    return m
  }

  prune () {
    const now = Date.now()
    for (const mem of this.members.values()) for (const [k, p] of mem) if (now - p.seen > MEMBER_TTL || this.hidden(k)) mem.delete(k)
  }

  list () {
    this.prune()
    const out = []
    for (const fire of this.mine) {
      const mem = this.members.get(fire) || new Map()
      const others = [...mem.entries()].filter(([k]) => !this.hidden(k))
      const counts = new Map()
      for (const t of [...(this.terms() || []).slice(0, 5), ...others.flatMap(([, p]) => p.terms)]) counts.set(t, (counts.get(t) || 0) + 1)
      const shared = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t)
      const msgs = this.msgs.get(fire) || []
      out.push({ fire, lit: others.length >= LIT_AT, people: others.length + 1, names: others.map(([k, p]) => ({ key: k, name: p.name })), terms: shared, last: msgs[msgs.length - 1] || null, count: msgs.length })
    }
    return out.sort((a, b) => (b.lit - a.lit) || (b.people - a.people))
  }

  messages (fire) { return (this.msgs.get(fire) || []).filter(m => !this.hidden(m.author)) }

  changed (fire) {
    const nowLit = new Set(this.list().filter(f => f.lit).map(f => f.fire))
    let lit = null
    for (const f of nowLit) if (!this.lit.has(f)) lit = f
    for (const f of [...this.lit]) if (!nowLit.has(f)) { this.lit.delete(f); this.msgs.delete(f) } // the fire went out: its words go with it
    for (const f of nowLit) this.lit.add(f)
    this.onChange({ lit, fire: fire || null })
  }
}

module.exports = { Fires, LIT_AT }
