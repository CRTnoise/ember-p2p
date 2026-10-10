// UI interaction tests: loads the real src/index.html in Electron with a demo
// engine (fixtures.js), clicks through it like a user, and checks each action
// reaches the engine. Run from desktop/:  npx electron test/ui/run.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path'); const os = require('os')
app.on('window-all-closed', () => {})
const cases = require('./cases.js')
const NL = String.fromCharCode(10)

function buildPage () {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8')
  const demo = fs.readFileSync(path.join(__dirname, 'fixtures.js'), 'utf8')
  const inst = fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8')
  // ';' between the two IIFEs, or JS parses them as one call expression
  const page = html.replace('<script>', '<script>' + NL + demo + NL + ';' + NL + inst + NL + '</script>' + NL + '<script>')
  const out = path.join(os.tmpdir(), 'ember-ui-test.html'); fs.writeFileSync(out, page); return out
}
const helpers = `const q=s=>document.querySelector(s), qa=s=>document.querySelectorAll(s), wait=ms=>new Promise(r=>setTimeout(r,ms));
  const click=el=>{ if(!el) throw new Error('element not found'); el.click() };
  const called=k=>__calls.some(c=>c.k===k);
  const until=async(fn,ms=2500)=>{ const t=Date.now(); while(!fn() && Date.now()-t<ms) await wait(50) };`

app.whenReady().then(async () => {
  const page = buildPage(); let pass = 0, fail = 0
  for (const [name, body] of cases) {
    const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { contextIsolation: false } })
    await win.loadFile(page); await new Promise(r => setTimeout(r, 1300))
    let res
    try {
      res = await Promise.race([
        new Promise(r => setTimeout(() => r('timed out (>8s)'), 8000)),
        win.webContents.executeJavaScript(`(async()=>{ ${helpers}\n try { return await (async()=>{ ${body} })() } catch(e) { return 'threw: ' + e.message } })()`)
      ])
    } catch (e) { res = 'harness: ' + e.message }
    if (res === true) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, res === false ? '' : '→ ' + res) }
    win.destroy()
  }
  console.log(NL + pass + ' passed, ' + fail + ' failed'); app.exit(fail ? 1 : 0)
})
