// EMBER web — the same interface in a browser, served by this node.
//
// Turn it on in SETUP › WEB ACCESS (desktop), or run Ember headless on a
// server with `npm run serve`. Either way, Ember is still one node with one
// identity: the browser is a window onto it, not a separate account.
//
// Who may use it:
//   · a browser must PAIR once with an 8-digit code shown by the node (in SETUP,
//     or printed by the headless server). It then gets a session cookie
//     (HttpOnly, SameSite=Strict); sessions are listed in SETUP and revocable.
//   · 5 wrong codes lock pairing for 5 minutes; a code is single-use, and on
//     desktop it also expires after 10 minutes.
//   · requests must name a host this node answers to (DNS-rebinding guard),
//     and every call must come from the page itself (Origin == Host, JSON body).
//   · a few calls never work from a browser: exporting or restoring the
//     identity, the window buttons, and turning web access itself on or off.
//   · by default it only listens on this computer (127.0.0.1). Other devices
//     on the network (LAN switch, or --host 0.0.0.0) get plain HTTP: put it
//     behind HTTPS (a reverse proxy, Tailscale…) before exposing it further.
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const COOKIE = 'ember_session'
const CODE_TTL = 10 * 60_000
const LOCK_AFTER = 5
const LOCK_FOR = 5 * 60_000
const MAX_JSON = 48 * 1048576            // a post with a full-size image fits
const MAX_UPLOAD = 2 * 1024 * 1048576    // video files, transcoded on the node
const UPLOAD_TTL = 60 * 60_000
const DENY = new Set(['export-identity', 'restore-identity', 'win-min', 'win-max', 'win-close', 'reload-ui', 'web-set', 'web-open'])

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

function deviceLabel (ua) {
  ua = String(ua || '')
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser'
  const osName = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system'
  return `${browser} on ${osName}`
}

class Web {
  // call(channel, args, ctx) runs one of the node's handlers; onChange(what) tells the node something changed
  constructor ({ dataDir, srcDir, call, onChange, codeTtl = CODE_TTL }) {
    Object.assign(this, { dataDir, srcDir, call, onChange: onChange || (() => {}), codeTtl })
    this.server = null; this.cfg = null; this.error = null
    this.clients = new Set()
    this.sessionsFile = path.join(dataDir, 'web-sessions.json')
    this.uploadDir = path.join(dataDir, 'web-uploads')
    this.sessions = []
    try { this.sessions = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')).filter(s => s && /^[0-9a-f]{64}$/.test(s.hash)) } catch {}
    this.code = null; this.codeExp = 0; this.fails = 0; this.lockedUntil = 0
    this.sweeper = null
  }

  // ---------- pairing + sessions ----------
  rotate () {
    this.code = String(crypto.randomInt(0, 1e8)).padStart(8, '0')
    this.codeExp = Date.now() + this.codeTtl
    this.onChange('code')
    return this.code
  }
  currentCode () { return (!this.code || Date.now() > this.codeExp) ? this.rotate() : this.code }
  saveSessions () { try { fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions), { mode: 0o600 }) } catch {} }
  sessionOf (req) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]{20,100})'))
    if (!m) return null
    const h = sha(m[1])
    const s = this.sessions.find(x => x.hash === h)
    if (s && Date.now() - (s.lastSeen || 0) > 60_000) { s.lastSeen = Date.now(); this.saveSessions() }
    return s || null
  }
  pair (code, req) {
    const now = Date.now()
    if (now < this.lockedUntil) return { status: 429, body: { ok: false, error: 'locked', retryIn: Math.ceil((this.lockedUntil - now) / 1000) } }
    const want = this.currentCode()
    const got = String(code || '').replace(/\D/g, '')
    const good = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))
    if (!good) {
      if (++this.fails >= LOCK_AFTER) { this.fails = 0; this.lockedUntil = now + LOCK_FOR; this.rotate() }
      return { status: 401, body: { ok: false, error: 'wrong code' } }
    }
    this.fails = 0
    const token = crypto.randomBytes(32).toString('base64url')
    const s = { id: crypto.randomBytes(8).toString('hex'), hash: sha(token), label: deviceLabel(req.headers['user-agent']), created: now, lastSeen: now }
    this.sessions.push(s)
    if (this.sessions.length > 50) this.sessions.shift()
    this.saveSessions()
    this.rotate() // single use
    this.onChange('device')
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    return { status: 200, body: { ok: true }, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}` }
  }
  revoke (id) {
    const before = this.sessions.length
    this.sessions = this.sessions.filter(s => s.id !== id)
    if (this.sessions.length !== before) {
      this.saveSessions()
      for (const c of [...this.clients]) if (c.session.id === id) { try { c.res.end() } catch {} this.clients.delete(c) }
      this.onChange('device')
    }
    return this.sessions.length !== before
  }

  // ---------- who may talk to us ----------
  hostNames () {
    const names = new Set(['localhost', '127.0.0.1', '[::1]'])
    const h = this.cfg && this.cfg.host
    const wide = h === '0.0.0.0' || h === '::'
    if (wide) {
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
        if (a.internal) continue
        names.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0]}]` : a.address)
      }
      names.add(os.hostname().toLowerCase()); names.add(os.hostname().toLowerCase() + '.local')
    } else if (h) names.add(h.includes(':') ? `[${h}]` : h)
    for (const a of (this.cfg && this.cfg.allowHosts) || []) names.add(String(a).toLowerCase())
    return names
  }
  hostOk (req) {
    const h = String(req.headers.host || '').toLowerCase()
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
    return this.hostNames().has(name)
  }
  originOk (req) {
    const o = req.headers.origin
    if (!o) return false
    try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase() } catch { return false }
  }

  // ---------- pages ----------
  appPage () {
    const html = fs.readFileSync(path.join(this.srcDir, 'index.html'), 'utf8')
    const shim = fs.readFileSync(path.join(this.srcDir, 'web-shim.js'), 'utf8')
    return html
      .replace("connect-src 'none'", "connect-src 'self'")
      .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">')
      .replace('<script>', '<script>\n' + shim + '\n</script>\n<script>')
  }
  pairPage () {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>EMBER · pair this browser</title>
<style>
  *{box-sizing:border-box;margin:0}
  body{background:#e9e7e2;color:#000;font:400 13px/1.6 ui-monospace,Menlo,Consolas,monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
  .box{background:#fff;border:1px solid #000;box-shadow:8px 8px 0 rgba(0,0,0,.14);width:min(440px,100%);padding:28px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:20px}
  .mark{width:20px;height:20px;border:3px solid #000;transform:rotate(45deg)}
  .word{font-weight:700;font-size:19px;letter-spacing:.3em}
  h1{font-size:13px;letter-spacing:.08em;margin-bottom:10px}
  p{color:#605c55;font-size:12px;margin-bottom:16px}
  input{width:100%;border:1px solid #000;height:52px;font:700 26px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3em;text-align:center;outline:none}
  button{margin-top:14px;width:100%;height:40px;background:#000;color:#fff;border:0;font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;cursor:pointer}
  .err{color:#c85a19;min-height:20px;margin-top:10px;font-size:12px}
</style></head><body><div class="box">
<div class="logo"><div class="mark"></div><span class="word">EMBER</span></div>
<h1>PAIR THIS BROWSER</h1>
<p>Enter the code shown by the Ember that runs this page: in the app, SETUP › WEB ACCESS; on a server, the code it printed when it started. You only do this once per browser.</p>
<form id="f"><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="0000 0000" autofocus>
<button>PAIR →</button><div class="err" id="e"></div></form></div>
<script>
const f = document.getElementById('f'), c = document.getElementById('c'), e = document.getElementById('e')
const fromLink = () => { const m = location.hash.match(/code=(\\d{8})/); if (!m) return false; c.value = m[1]; history.replaceState(null, '', '/'); return true }
f.onsubmit = async (ev) => {
  ev.preventDefault(); e.textContent = ''
  const r = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.value }) }).catch(() => null)
  const j = r ? await r.json().catch(() => ({})) : {}
  if (j.ok) { location.replace('/'); return }
  e.textContent = j.error === 'locked' ? 'Too many wrong codes. Try again in ' + Math.ceil(j.retryIn / 60) + ' min.' : r ? 'That code is not right (codes change after each pairing).' : 'Ember is not reachable.'
  c.select()
}
if (fromLink()) f.requestSubmit()
addEventListener('hashchange', () => { if (fromLink()) f.requestSubmit() })
</script></body></html>`
  }

  // ---------- uploads (video files) ----------
  uploadPath (id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
    const p = path.join(this.uploadDir, id)
    return fs.existsSync(p) ? p : null
  }
  sweep () {
    try { for (const f of fs.readdirSync(this.uploadDir)) { const p = path.join(this.uploadDir, f); if (Date.now() - fs.statSync(p).mtimeMs > UPLOAD_TTL) fs.rmSync(p, { force: true }) } } catch {}
  }

  // ---------- events ----------
  broadcast (ch, data) {
    if (!this.clients.size) return
    let line
    try { line = `data: ${JSON.stringify({ ch, data: data === undefined ? null : data })}\n\n` } catch { return }
    for (const c of this.clients) { try { c.res.write(line) } catch {} }
  }

  // ---------- http ----------
  send (res, status, body, headers = {}) {
    const isStr = typeof body === 'string'
    res.writeHead(status, {
      'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer', 'content-security-policy': CSP, ...headers
    })
    res.end(isStr ? body : JSON.stringify(body))
  }
  readJson (req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) return reject(Object.assign(new Error('json only'), { status: 415 }))
      let size = 0; const parts = []
      req.on('data', (c) => { size += c.length; if (size > MAX_JSON) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy() } else parts.push(c) })
      req.on('end', () => { try { const t = Buffer.concat(parts).toString('utf8'); resolve(t ? JSON.parse(t) : undefined) } catch { reject(Object.assign(new Error('bad json'), { status: 400 })) } })
      req.on('error', reject)
    })
  }
  async handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    if (!this.hostOk(req)) return this.send(res, 403, { ok: false, error: 'unknown host' })
    const session = this.sessionOf(req)

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return this.send(res, 200, session ? this.appPage() : this.pairPage())
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end() }

    if (req.method === 'POST' && p === '/pair') {
      if (!this.originOk(req)) return this.send(res, 403, { ok: false, error: 'bad origin' })
      const body = await this.readJson(req).catch(() => ({}))
      const r = this.pair(body && body.code, req)
      return this.send(res, r.status, r.body, r.cookie ? { 'set-cookie': r.cookie } : {})
    }

    if (!p.startsWith('/api/')) return this.send(res, 404, { ok: false, error: 'not found' })
    if (!session) return this.send(res, 401, { ok: false, error: 'not paired' })
    // calls must come from our own page. A same-origin EventSource sends no
    // Origin header, so the event stream checks the browser's Sec-Fetch-Site
    const sameSite = req.method === 'GET' && p === '/api/events' && !req.headers.origin && ['same-origin', undefined].includes(req.headers['sec-fetch-site'])
    if (!sameSite && !this.originOk(req)) return this.send(res, 403, { ok: false, error: 'bad origin' })

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive' })
      res.write('retry: 3000\n\n')
      const c = { res, session }
      this.clients.add(c)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25_000)
      req.on('close', () => { clearInterval(ping); this.clients.delete(c) })
      return
    }
    if (req.method === 'POST' && p === '/api/logout') {
      this.revoke(session.id)
      return this.send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` })
    }
    if (req.method === 'POST' && p === '/api/upload') {
      fs.mkdirSync(this.uploadDir, { recursive: true })
      const id = crypto.randomBytes(16).toString('hex')
      const file = path.join(this.uploadDir, id)
      const out = fs.createWriteStream(file, { mode: 0o600 })
      let size = 0, failed = false
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD && !failed) { failed = true; req.destroy(); out.destroy(); fs.rm(file, { force: true }, () => {}) } })
      req.pipe(out)
      out.on('finish', () => failed ? null : this.send(res, 200, { ok: true, id, size }))
      out.on('error', () => { if (!res.headersSent) this.send(res, 500, { ok: false, error: 'upload failed' }) })
      return
    }
    const m = p.match(/^\/api\/call\/([a-z0-9-]{1,40})$/)
    if (req.method === 'POST' && m) {
      if (DENY.has(m[1])) return this.send(res, 403, { ok: false, error: 'only on the computer running Ember' })
      let args
      try { args = await this.readJson(req) } catch (e) { return this.send(res, e.status || 400, { ok: false, error: e.message }) }
      try {
        const value = await this.call(m[1], args === null ? undefined : args, { web: true, session: { id: session.id, label: session.label } })
        return this.send(res, 200, { ok: true, value: value === undefined ? null : value })
      } catch (e) {
        return this.send(res, e && e.code === 'UNKNOWN_CHANNEL' ? 404 : 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
      }
    }
    return this.send(res, 404, { ok: false, error: 'not found' })
  }

  // ---------- lifecycle ----------
  async start ({ port = 7777, host = '127.0.0.1', allowHosts = [] } = {}) {
    await this.stop()
    this.cfg = { port, host, allowHosts }
    this.error = null
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => { try { if (!res.headersSent) this.send(res, 500, { ok: false, error: 'server error' }); else res.end() } catch {} })
    })
    server.requestTimeout = 0 // uploads and event streams are long
    server.headersTimeout = 30_000
    await new Promise((resolve) => {
      server.once('error', (e) => { this.error = e.code === 'EADDRINUSE' ? `port ${port} is already in use` : String(e.message || e); this.server = null; resolve() })
      server.listen(port, host, () => { this.server = server; resolve() })
    })
    if (this.server) { this.sweeper = setInterval(() => this.sweep(), 10 * 60_000); this.currentCode() }
    this.onChange('state')
    return !!this.server
  }
  async stop () {
    clearInterval(this.sweeper); this.sweeper = null
    for (const c of this.clients) { try { c.res.end() } catch {} }
    this.clients.clear()
    const s = this.server; this.server = null
    if (s) await new Promise(r => { s.close(() => r()); s.closeAllConnections && s.closeAllConnections() })
  }
  urls () {
    if (!this.server || !this.cfg) return []
    const { host, port } = this.cfg
    const wide = host === '0.0.0.0' || host === '::'
    const out = [`http://${wide || host === '127.0.0.1' ? '127.0.0.1' : host}:${port}`]
    if (wide) for (const n of this.hostNames()) if (/^\d+\.\d+\.\d+\.\d+$/.test(n) && n !== '127.0.0.1') out.push(`http://${n}:${port}`)
    return out
  }
  state ({ withCode = true } = {}) {
    return {
      on: !!this.server, error: this.error, port: this.cfg && this.cfg.port, host: this.cfg && this.cfg.host, urls: this.urls(),
      code: withCode && this.server ? this.currentCode() : null, codeExpires: this.codeTtl === Infinity ? null : this.codeExp,
      locked: Date.now() < this.lockedUntil,
      devices: this.sessions.map(s => ({ id: s.id, label: s.label, created: s.created, lastSeen: s.lastSeen }))
    }
  }
}

module.exports = { Web, DENY, deviceLabel }
