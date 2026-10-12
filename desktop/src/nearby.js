// EMBER nearby — two opt-in ways to find people near you in SPACE
// (discovery.js finds people near you in MEANING). Both are OFF by default.
//
//   lan   SAME NETWORK. A signed "near card" is sent every few seconds as a UDP
//         multicast + broadcast packet with TTL 1: it never leaves the local
//         network. Anyone running Ember on the same Wi-Fi/LAN sees you.
//   area  SAME AREA. You pick a town from a bundled list (places.tsv); Ember
//         never reads GPS and never asks a geolocation service. It joins DHT
//         topics for the grid cells around that town (discovery.areaTopics) on
//         a dedicated swarm and swaps signed cards with whoever else opted in
//         nearby. Your chosen radius is enforced on town centres.
//
// Cards only carry: your key, your signer key, your display name and (area)
// the town you picked. They are verified against your published signer key
// whenever we already know it; otherwise they are shown as UNCONFIRMED until
// the person's profile is fetched.
const dgram = require('dgram')
const { execFile } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
const Hyperswarm = require('hyperswarm')
const P = require('./protocol')
const disc = require('./discovery')

const MCAST = '239.255.77.77'
const PORT = 47777
const LAN_EVERY = 8000          // beacon interval
const LAN_TTL = 45_000          // forget a LAN peer after this long unheard
const AREA_EVERY = 120_000      // re-send our card on open area connections
const AREA_TTL = 6 * 60_000     // forget an area peer after this long unheard
// Two people opting in at the same moment each look the other up before the
// other's announcement has landed; Hyperswarm only re-looks every ~10 min.
// Re-run the lookup soon after joining, then every few minutes.
const AREA_RELOOK = [8_000, 30_000]
const AREA_RELOOK_EVERY = 4 * 60_000
const MAX_PEOPLE = 300

// broadcast address of every IPv4 interface that isn't loopback
function lanInterfaces () {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue
      if (i.internal) continue
      const a = i.address.split('.').map(Number); const m = i.netmask.split('.').map(Number)
      out.push({ address: i.address, broadcast: a.map((x, k) => (x | (~m[k] & 255))).join('.') })
    }
  }
  return out
}

// ---- places (offline town list) ----
let PLACES = null
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function loadPlaces () {
  if (PLACES) return PLACES
  PLACES = []
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'places.tsv'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line || line[0] === '#') continue
      const [name, cc, lat, lon, pop] = line.split('\t')
      PLACES.push({ name, cc, lat: +lat, lon: +lon, pop: +pop, key: fold(name) })
    }
  } catch {}
  return PLACES
}
// "paris" · "paris fr" · "paris, france" (country part matched on its code only)
function searchPlaces (q, limit = 8) {
  const words = fold(q).split(' ').filter(Boolean)
  if (!words.length) return []
  let cc = null
  if (words.length > 1 && words[words.length - 1].length === 2) cc = words.pop().toUpperCase()
  const needle = words.join(' ')
  const hits = []
  for (const p of loadPlaces()) {
    if (cc && p.cc !== cc) continue
    const exact = p.key === needle
    if (!exact && !p.key.startsWith(needle) && !p.key.includes(' ' + needle)) continue
    hits.push({ p, score: (exact ? 2 : p.key.startsWith(needle) ? 1 : 0) * 1e9 + p.pop })
    if (hits.length > 4000) break
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit).map(({ p }) => ({ place: `${p.name}, ${p.cc}`, lat: p.lat, lon: p.lon, pop: p.pop }))
}

// nearest bundled town to a point. Used to turn the PC's own location into a
// town: the precise position is used for this lookup and then thrown away.
function nearestPlace (lat, lon) {
  let best = null, bestKm = Infinity
  const r = Math.PI / 180, cl = Math.cos(lat * r)
  for (const p of loadPlaces()) {
    // cheap equirectangular pre-filter, exact distance only for close candidates
    const dx = (p.lon - lon) * cl, dy = p.lat - lat
    if (dx * dx + dy * dy > 1.2 * 1.2) continue // > ~130 km away
    const km = disc.distanceKm(lat, lon, p.lat, p.lon)
    // prefer bigger towns when two are about equally close (suburbs vs the town people name)
    const score = km - Math.min(3, Math.log10(Math.max(p.pop, 1)) - 3.7)
    if (score < bestKm) { bestKm = score; best = { place: `${p.name}, ${p.cc}`, lat: p.lat, lon: p.lon, pop: p.pop, km: Math.round(km) } }
  }
  return best
}

// ---- the PC's own location (never shared: only the nearest town is) ----
// Windows: the OS Location service (Settings → Privacy → Location), read through
// .NET's GeoCoordinateWatcher in Windows PowerShell. Linux: GeoClue's where-am-i
// demo when installed. Anything else: unavailable, and the user can type a town.
const WIN_LOCATE = [
  'Add-Type -AssemblyName System.Device',
  '$w = New-Object System.Device.Location.GeoCoordinateWatcher',
  '$null = $w.TryStart($false, [TimeSpan]::FromSeconds(12))',
  '$end = (Get-Date).AddSeconds(14)',
  "while ($w.Status -ne 'Ready' -and $w.Permission -ne 'Denied' -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }",
  '$c = $w.Position.Location',
  '$inv = [Globalization.CultureInfo]::InvariantCulture',
  "if ($w.Permission -eq 'Denied') { 'DENIED' } elseif ($c.IsUnknown) { 'UNKNOWN' } else { 'POS ' + $c.Latitude.ToString($inv) + ' ' + $c.Longitude.ToString($inv) }",
  '$w.Stop()'
].join('; ')
function run (cmd, args, ms) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? null : String(stdout || '')))
  })
}
async function locateDevice () {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_LOCATE], 25_000)
    if (!out) return { error: 'unavailable' }
    if (/DENIED/.test(out)) return { error: 'denied' }
    const m = out.match(/POS (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/)
    return m ? { lat: +m[1], lon: +m[2] } : { error: 'unknown' }
  }
  if (process.platform === 'linux') {
    for (const bin of ['/usr/libexec/geoclue-2.0/demos/where-am-i', '/usr/lib/geoclue-2.0/demos/where-am-i']) {
      if (!fs.existsSync(bin)) continue
      const out = await run(bin, ['-t', '12'], 15_000)
      const la = out && out.match(/Latitude:\s*(-?\d+(?:[.,]\d+)?)/), lo = out && out.match(/Longitude:\s*(-?\d+(?:[.,]\d+)?)/)
      if (la && lo) return { lat: +la[1].replace(',', '.'), lon: +lo[1].replace(',', '.') }
    }
    return { error: 'unavailable' }
  }
  return { error: 'unavailable' }
}
// → { place, lat, lon, km } (km = how far the PC is from that town's centre, shown locally only) | { error }
async function locateTown (locate = locateDevice) {
  const pos = await locate()
  if (!pos || pos.error) return { error: (pos && pos.error) || 'unavailable' }
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lon) || Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) return { error: 'unknown' }
  const town = nearestPlace(pos.lat, pos.lon)
  return town || { error: 'no-town' }
}

class Nearby {
  // me(): { key, edpk, name } · sign(str) → b64 · verify(str, sig, edpkHex) → bool
  // knownEdPk(key) → published signer key or undefined · isBlocked(key) · onChange()
  // swarmOpts: only for tests (a private DHT testnet); the app uses the public DHT
  constructor ({ me, sign, verify, knownEdPk, isBlocked, onChange, swarmOpts }) {
    Object.assign(this, { me, sign, verify, knownEdPk, isBlocked, onChange, swarmOpts })
    this.people = new Map()       // key -> person
    this.lan = { on: false, sock: null, timer: null, error: null }
    this.area = { on: false, swarm: null, timer: null, sockets: new Set(), cfg: null, error: null }
  }

  card (via) {
    const m = this.me()
    const a = this.area.cfg || {}
    const c = P.makeNearCard({ via, key: m.key, edpk: m.edpk, name: m.name, place: a.place, lat: a.lat, lon: a.lon, ts: Date.now() })
    c.sig = this.sign(P.nearMsg(c))
    return c
  }

  // every card, from either channel, goes through here
  receive (raw, via) {
    const c = P.cleanNear(raw, Date.now())
    if (!c || (c.via !== via && c.via !== 'bye')) return
    const m = this.me()
    if (c.key === m.key || this.isBlocked(c.key)) return
    if (!this.verify(P.nearMsg(c), c.sig, c.edpk)) return
    if (c.via === 'bye') { // they hid or switched this channel off: drop them now
      const p = this.people.get(c.key)
      if (p && p.edpk === c.edpk && p[via]) { delete p[via]; if (!p.lan && !p.area) this.people.delete(c.key); this.onChange(null) }
      return
    }
    const known = this.knownEdPk(c.key)
    if (known && known !== c.edpk) return // signed by a key that isn't theirs: an impersonation attempt
    let km = null
    if (via === 'area') {
      const mine = this.area.cfg
      if (!mine) return
      km = disc.distanceKm(mine.lat, mine.lon, c.lat, c.lon)
      if (km > mine.radius) return
    }
    let p = this.people.get(c.key)
    if (!p) {
      if (this.people.size >= MAX_PEOPLE) return
      p = { key: c.key, firstSeen: Date.now() }
      this.people.set(c.key, p)
    }
    const fresh = !p.lan && !p.area
    p.edpk = c.edpk; p.name = c.name; p.verified = !!known
    if (via === 'lan') p.lan = { seen: Date.now() }
    else p.area = { seen: Date.now(), place: c.place, km: Math.round(km) }
    this.onChange(fresh ? p : null)
  }

  list () {
    const now = Date.now()
    for (const [k, p] of this.people) {
      if (p.lan && now - p.lan.seen > LAN_TTL) delete p.lan
      if (p.area && (now - p.area.seen > AREA_TTL || !this.area.on)) delete p.area
      if (this.isBlocked(k) || (!p.lan && !p.area)) this.people.delete(k)
      else { const known = this.knownEdPk(k); if (known === p.edpk) p.verified = true }
    }
    return [...this.people.values()].sort((a, b) =>
      (b.lan ? 1 : 0) - (a.lan ? 1 : 0) || ((a.area && a.area.km) ?? 1e9) - ((b.area && b.area.km) ?? 1e9) || b.firstSeen - a.firstSeen)
  }

  state () {
    return {
      lan: { on: this.lan.on, error: this.lan.error },
      area: { on: this.area.on, error: this.area.error, ...(this.area.cfg || {}), connections: this.area.sockets.size },
      radii: disc.AREA_RADII,
      people: this.list()
    }
  }

  // ---------------- same network ----------------
  startLan () {
    if (this.lan.on) return
    this.lan.on = true; this.lan.error = null
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.lan.sock = sock
    sock.on('error', (e) => { this.lan.error = e.code || e.message; this.onChange(null) })
    sock.on('message', (buf) => {
      if (buf.length > 2048) return
      try { const m = JSON.parse(buf.toString()); if (m && m.t === 'ember-near') this.receive(m.c, 'lan') } catch {}
    })
    sock.bind(PORT, () => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(1); sock.setMulticastLoopback(true) } catch {}
      for (const i of lanInterfaces()) { try { sock.addMembership(MCAST, i.address) } catch {} }
      this.beacon()
    })
    this.lan.timer = setInterval(() => this.beacon(), LAN_EVERY)
    this.onChange(null)
  }

  beacon () { if (this.lan.on) this.say('lan') }

  say (via, sock = this.lan.sock) {
    if (!sock) return
    const msg = Buffer.from(JSON.stringify({ t: 'ember-near', c: this.card(via) }))
    const send = (addr) => { try { sock.send(msg, PORT, addr, () => {}) } catch {} }
    send(MCAST)                                         // multicast: the clean way
    for (const i of lanInterfaces()) send(i.broadcast)  // broadcast: for routers that drop multicast
  }

  stopLan () {
    if (!this.lan.on) return
    // say bye twice (UDP may drop one), and only close once the packets are out
    const sock = this.lan.sock
    this.say('bye'); setTimeout(() => this.say('bye', sock), 120)
    this.lan.on = false
    clearInterval(this.lan.timer); this.lan.timer = null
    setTimeout(() => { try { sock.close() } catch {} }, 400)
    this.lan.sock = null
    for (const p of this.people.values()) delete p.lan
    this.onChange(null)
  }

  // ---------------- same area ----------------
  async startArea (cfg) {
    await this.stopArea()
    const radius = disc.AREA_RADII.includes(cfg.radius) ? cfg.radius : 25
    this.area.cfg = { place: cfg.place, lat: Math.round(cfg.lat * 100) / 100, lon: Math.round(cfg.lon * 100) / 100, radius }
    this.area.on = true; this.area.error = null
    const swarm = new Hyperswarm(typeof this.swarmOpts === 'function' ? this.swarmOpts() : this.swarmOpts)
    this.area.swarm = swarm
    let lastKick = 0
    swarm.on('connection', (socket) => {
      this.area.sockets.add(socket)
      // Two peers dialling each other at the same moment can leave one side with
      // a connection the other already dropped: nothing ever arrives on it, so
      // their cards (and their bye) never would either. Everyone sends a card the
      // moment a connection opens: silence after 4 s means a dead line. Drop it
      // and look the area up again so a working one replaces it.
      const zombie = setTimeout(() => {
        if (socket._heard || this.area.swarm !== swarm) return
        socket.destroy()
        if (Date.now() - lastKick > 10_000) { lastKick = Date.now(); relook() }
      }, 4000)
      socket.on('close', () => {
        clearTimeout(zombie)
        this.area.sockets.delete(socket); this.onChange(null)
        // fallback for a lost 'bye': once the last connection that carried
        // someone's card has been gone for a few seconds (a connection being
        // swapped for a fresh one doesn't count), they're gone too
        const k = socket._nearKey
        if (k) setTimeout(() => {
          const p = this.people.get(k)
          if (this.area.swarm !== swarm || !p || !p.area || [...this.area.sockets].some(x => x._nearKey === k)) return
          delete p.area; if (!p.lan) this.people.delete(k)
          this.onChange(null)
        }, 3000)
      })
      socket.on('error', () => {})
      let buf = ''; let n = 0
      socket.on('data', (chunk) => {
        socket._heard = true
        buf += chunk.toString()
        if (buf.length > 16384) { socket.destroy(); return }
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          if (++n > 200) { socket.destroy(); return } // a card every 2 min: 200 is days of honest traffic
          try {
            const m = JSON.parse(line)
            if (m && m.t === 'near') { this.receive(m.c, 'area'); if (m.c && m.c.via === 'area' && this.people.get(m.c.key)) socket._nearKey = m.c.key }
          } catch {}
        }
      })
      this.sendArea(socket)
      this.onChange(null)
    })
    const joins = disc.areaTopics(this.area.cfg.lat, this.area.cfg.lon, radius)
      .map(t => swarm.join(t.topic, { server: t.server, client: t.client }))
    const relook = () => { if (this.area.swarm === swarm) for (const d of joins) d.refresh().catch(() => {}) }
    this.area.relooks = AREA_RELOOK.map(ms => setTimeout(relook, ms))
    let since = 0
    this.area.timer = setInterval(() => {
      for (const s of this.area.sockets) this.sendArea(s)
      if ((since += AREA_EVERY) >= AREA_RELOOK_EVERY) { since = 0; relook() }
    }, AREA_EVERY)
    this.onChange(null)
    swarm.flush().catch(() => {})
  }

  sendArea (socket) {
    try { socket.write(JSON.stringify({ t: 'near', c: this.card('area') }) + '\n') } catch {}
  }

  async stopArea () {
    if (!this.area.on && !this.area.swarm) return
    if (this.area.cfg) { const bye = JSON.stringify({ t: 'near', c: this.card('bye') }) + '\n'; for (const s of this.area.sockets) { try { s.write(bye) } catch {} } }
    this.area.on = false
    clearInterval(this.area.timer); this.area.timer = null
    for (const t of this.area.relooks || []) clearTimeout(t)
    const s = this.area.swarm; this.area.swarm = null; this.area.sockets.clear()
    this.area.cfg = null
    for (const p of this.people.values()) delete p.area
    this.onChange(null)
    if (s) { await new Promise(r => setTimeout(r, 150)); await s.destroy().catch(() => {}) }
  }

  async destroy () { this.stopLan(); await this.stopArea() }
}

module.exports = { Nearby, searchPlaces, nearestPlace, locateTown, MCAST, PORT }
