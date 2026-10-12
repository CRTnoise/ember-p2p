// Web access (web.js) without a network: pairing, lockout, sessions, the
// host/origin guards, the deny list, uploads, the event stream, and that the
// browser shim offers exactly what the Electron preload does.
// Run: node test/web.test.js
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http')
const { Web, DENY } = require('../src/web')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const SRC = path.join(__dirname, '..', 'src')

function req (port, { method = 'GET', p = '/', headers = {}, body, raw } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => {
        const t = Buffer.concat(parts).toString(); let j = null; try { j = JSON.parse(t) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: t, json: j })
      })
    })
    r.on('error', () => resolve({ status: 0 }))
    if (raw) r.end(raw); else r.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

;(async () => {
  // ---- parity: the browser gets the same API as the window ----
  const keys = (file) => [...fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/^\s{2,4}(\w+): /gm)].map(m => m[1])
  const pre = new Set(keys('preload.js')), shim = new Set(keys('web-shim.js'))
  const missing = [...pre].filter(k => !shim.has(k))
  ok(pre.size > 80 && missing.length === 0, 'shim is missing ' + missing.join(', '))
  const channels = [...fs.readFileSync(path.join(SRC, 'web-shim.js'), 'utf8').matchAll(/call\('([a-z0-9-]+)'/g)].map(m => m[1])
  const handlers = new Set([...fs.readFileSync(path.join(SRC, 'main.js'), 'utf8').matchAll(/^handle\('([a-z0-9-]+)'/gm)].map(m => m[1]))
  const unknown = channels.filter(c => !handlers.has(c))
  ok(unknown.length === 0, 'shim calls channels main.js does not handle: ' + unknown.join(', '))

  // ---- a server with a fake node behind it ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-web-'))
  const calls = []; const events = []
  const web = new Web({ dataDir: dir, srcDir: SRC, onChange: (w) => events.push(w), call: async (ch, args, ctx) => {
    calls.push({ ch, args, ctx })
    if (ch === 'me') return { key: 'k', length: 1 }
    if (ch === 'boom') throw new Error('kaboom')
    if (ch === 'nope') { const e = new Error('unknown call'); e.code = 'UNKNOWN_CHANNEL'; throw e }
    return { echo: args }
  } })
  await web.start({ port: 7899, host: '127.0.0.1' })
  ok(!!web.server, 'server did not start: ' + web.error)
  const P = 7899, ORIGIN = { origin: `http://127.0.0.1:${P}` }, JSONH = { ...ORIGIN, 'content-type': 'application/json' }

  // pages
  let r = await req(P)
  ok(r.status === 200 && r.text.includes('PAIR THIS BROWSER'), 'unpaired / is not the pairing page')
  ok(/frame-ancestors 'none'/.test(r.headers['content-security-policy']) && r.headers['x-frame-options'] === 'DENY', 'security headers missing')
  r = await req(P, { headers: { host: 'evil.example:7899' } })
  ok(r.status === 403, 'foreign host accepted (DNS rebinding)')

  // pairing
  const code = web.currentCode()
  ok(/^\d{8}$/.test(code), 'code is not 8 digits')
  r = await req(P, { method: 'POST', p: '/pair', headers: { 'content-type': 'application/json' }, body: { code } })
  ok(r.status === 403, 'pairing without an Origin accepted')
  r = await req(P, { method: 'POST', p: '/pair', headers: JSONH, body: { code: '00000000' } })
  ok(r.status === 401, 'wrong code accepted')
  r = await req(P, { method: 'POST', p: '/pair', headers: JSONH, body: { code } })
  ok(r.status === 200 && /HttpOnly/.test(r.headers['set-cookie'][0]) && /SameSite=Strict/.test(r.headers['set-cookie'][0]), 'pairing cookie missing or weak')
  const cookie = r.headers['set-cookie'][0].split(';')[0]
  ok(web.currentCode() !== code, 'code still valid after use')
  r = await req(P, { method: 'POST', p: '/pair', headers: JSONH, body: { code } })
  ok(r.status === 401, 'a used code works twice')
  ok(!fs.readFileSync(path.join(dir, 'web-sessions.json'), 'utf8').includes(cookie.split('=')[1]), 'session token stored in clear')
  // Unix permission bits (Windows has none: AppData is per-user by its own ACLs)
  if (process.platform !== 'win32') ok((fs.statSync(path.join(dir, 'web-sessions.json')).mode & 0o077) === 0, 'sessions file readable by others')

  // lockout
  for (let i = 0; i < 5; i++) await req(P, { method: 'POST', p: '/pair', headers: JSONH, body: { code: '11111111' } })
  r = await req(P, { method: 'POST', p: '/pair', headers: JSONH, body: { code: web.currentCode() } })
  ok(r.status === 429, 'no lockout after 5 wrong codes: ' + r.status)
  web.lockedUntil = 0

  // the app page for a paired browser
  r = await req(P, { headers: { cookie } })
  ok(r.text.includes('window.EMBER_WEB = true') && r.text.includes("connect-src 'self'") && !r.text.includes("connect-src 'none'"), 'app page not prepared for the browser')
  ok(r.text.indexOf('window.EMBER_WEB') < r.text.indexOf('const $ = s =>'), 'shim does not run before the page script')

  // calls
  r = await req(P, { method: 'POST', p: '/api/call/me', headers: JSONH, body: null })
  ok(r.status === 401, 'call without a session')
  r = await req(P, { method: 'POST', p: '/api/call/me', headers: { ...JSONH, cookie }, body: null })
  ok(r.status === 200 && r.json.ok && r.json.value.key === 'k', 'call failed: ' + r.text)
  ok(calls.at(-1).ctx.web === true && calls.at(-1).args === undefined, 'call context wrong')
  r = await req(P, { method: 'POST', p: '/api/call/post', headers: { 'content-type': 'application/json', cookie }, body: { text: 'x' } })
  ok(r.status === 403, 'call without Origin accepted')
  r = await req(P, { method: 'POST', p: '/api/call/post', headers: { origin: 'http://evil.example', 'content-type': 'application/json', cookie }, body: { text: 'x' } })
  ok(r.status === 403, 'call from another origin accepted')
  r = await req(P, { method: 'POST', p: '/api/call/post', headers: { ...ORIGIN, 'content-type': 'text/plain', cookie }, raw: '{"text":"x"}' })
  ok(r.status === 415, 'non-JSON body accepted (form CSRF)')
  for (const ch of DENY) {
    r = await req(P, { method: 'POST', p: '/api/call/' + ch, headers: { ...JSONH, cookie }, body: {} })
    ok(r.status === 403 && !calls.some(c => c.ch === ch), ch + ' reachable from a browser')
  }
  r = await req(P, { method: 'POST', p: '/api/call/boom', headers: { ...JSONH, cookie }, body: {} })
  ok(r.status === 500 && r.json.error === 'kaboom', 'errors not passed through')
  r = await req(P, { method: 'POST', p: '/api/call/nope', headers: { ...JSONH, cookie }, body: {} })
  ok(r.status === 404, 'unknown channel')
  r = await req(P, { method: 'POST', p: '/api/call/../../etc', headers: { ...JSONH, cookie }, body: {} })
  ok(r.status === 404, 'odd channel name')

  // uploads
  r = await req(P, { method: 'POST', p: '/api/upload', headers: { ...ORIGIN, cookie, 'content-type': 'application/octet-stream' }, raw: Buffer.alloc(1000, 7) })
  ok(r.status === 200 && /^[0-9a-f]{32}$/.test(r.json.id) && fs.statSync(web.uploadPath(r.json.id)).size === 1000, 'upload failed')
  ok(web.uploadPath('../../etc/passwd') === null && web.uploadPath('0'.repeat(32)) === null, 'upload path escapes')

  // events
  const got = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: P, path: '/api/events', headers: { host: `127.0.0.1:${P}`, cookie, 'sec-fetch-site': 'same-origin' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; if (t.includes('hello')) { rq.destroy(); resolve(t) } })
      setTimeout(() => web.broadcast('feed-updated', { hello: 1 }), 100)
    }); rq.end(); setTimeout(() => resolve(''), 2000)
  })
  ok(/data: \{"ch":"feed-updated","data":\{"hello":1\}\}/.test(got), 'event not streamed')
  r = await req(P, { p: '/api/events', headers: { cookie, 'sec-fetch-site': 'cross-site' } })
  ok(r.status === 403, 'cross-site event stream accepted')

  // sessions: list + revoke
  const st = web.state()
  ok(st.devices.length === 1 && st.devices[0].label === 'a browser on unknown system' && !('hash' in st.devices[0]), 'device list wrong: ' + JSON.stringify(st.devices))
  web.revoke(st.devices[0].id)
  r = await req(P, { method: 'POST', p: '/api/call/me', headers: { ...JSONH, cookie }, body: null })
  ok(r.status === 401, 'revoked session still works')
  ok(events.includes('device') && events.includes('code'), 'changes not announced')

  // a session survives a restart, the code expires on desktop
  await web.stop()
  const w2 = new Web({ dataDir: dir, srcDir: SRC, call: async () => 1, codeTtl: 50 })
  await w2.start({ port: 7899 })
  const c1 = w2.currentCode(); await new Promise(r => setTimeout(r, 80))
  ok(w2.currentCode() !== c1, 'code does not expire')
  await w2.stop()
  // take exactly 127.0.0.1:7898 (Windows lets a second program bind 127.0.0.1 next to a wildcard listener)
  const busy = http.createServer(); await new Promise(r => busy.listen(7898, '127.0.0.1', r))
  const w3 = new Web({ dataDir: dir, srcDir: SRC, call: async () => 1 })
  ok(!(await w3.start({ port: 7898 })) && /in use/.test(w3.error), 'port in use not reported')
  busy.close()

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
})()
