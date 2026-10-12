// Lists every interface string the translation dictionaries don't cover yet.
// Loads the real page with the demo engine, walks through every view, and
// records each English string that src/i18n/<lang>.json can't translate.
// Run from desktop/:  npx electron test/ui/i18n-collect.js [fr|zh|ar|empty]   (default: fr)
// Writes the list to <tmp>/ember-i18n-missing-<lang>.json
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path'); const os = require('os')
app.on('window-all-closed', () => {})
const NL = String.fromCharCode(10)
const lang = process.argv.find(a => /^(fr|zh|ar|empty)$/.test(a)) || 'fr'
const dict = lang === 'empty' ? { strings: {}, patterns: [] } : JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'i18n', lang + '.json'), 'utf8'))

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8')
const demo = fs.readFileSync(path.join(__dirname, 'fixtures.js'), 'utf8')
const page = html.replace('<script>', '<script>' + NL + 'window.__I18N = { fr: ' + JSON.stringify(dict) + ' }; window.__i18nMiss = new Set();' + NL + demo + NL + '</script>' + NL + '<script>')
const out = path.join(os.tmpdir(), 'ember-i18n-collect.html'); fs.writeFileSync(out, page)

// strings that only appear in toasts, dialogs and rare states: pulled from the source
function sourceStrings () {
  const found = new Set()
  for (const m of html.matchAll(/(?:toast|tr)\(\s*'((?:[^'\\]|\\.)+)'/g)) found.add(m[1].replace(/\\'/g, "'"))
  for (const m of html.matchAll(/(?:toast|tr)\(\s*"((?:[^"\\]|\\.)+)"/g)) found.add(m[1])
  // fixed sentences shown in empty states
  for (const m of html.matchAll(/class="empty"[^>]*>([^<$`]+)</g)) found.add(m[1].replace(/\\'/g, "'"))
  return [...found].map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /[A-Za-z]{2}/.test(s) && !/\$\{/.test(s))
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { contextIsolation: false } })
  await win.loadFile(out, { query: { onboarded: '0' } })
  await new Promise(r => setTimeout(r, 1500))
  const steps = `
    const wait = ms => new Promise(r => setTimeout(r, ms))
    await setLanguage('fr')
    for (const v of ['feed','discover','nearby','fires','notifs','saved','settings','inbox']) { go(v); await wait(500) }
    $('#search').value = 'riso'; go('discover'); await wait(500); $('#search').value = ''
    FIRE_ACTIVE = 'art'; go('fires'); await wait(500); FIRE_ACTIVE = null
    await openProfile(DEMO.STRANGER); await wait(400); await openProfile(DEMO.ME_KEY); await wait(400)
    document.querySelector('#pedit') && document.querySelector('#pedit').click(); await wait(200)
    window.__locateFails = true; go('nearby'); await wait(300); document.querySelector('#n-locate').click(); await wait(500)
    await window.ember.nearSetHidden(true); go('nearby'); await wait(400)
    for (const n of [0, 1, 2, 'T', 3, 4]) { obGo(n); await wait(100) }
    // rarer states
    const real = { discover: window.ember.discover, firesList: window.ember.firesList, nearState: window.ember.nearState }
    window.ember.discover = () => Promise.resolve({ items: [], buckets: 3, gossipPeers: 0, quiet: true, topics: 2, dial: 1, commons: true }); go('discover'); await wait(300)
    window.ember.discover = () => Promise.resolve({ items: [], buckets: 1, gossipPeers: 0, quiet: true, topics: 0, dial: 1, commons: true }); go('discover'); await wait(300)
    window.ember.firesList = () => Promise.resolve({ on: false, fires: [] }); go('fires'); await wait(300)
    window.ember.firesList = () => Promise.resolve({ on: true, fires: [] }); go('fires'); await wait(300)
    window.ember.firesList = () => Promise.resolve({ on: true, fires: [{ fire: 'art', lit: true, people: 3, names: [{ key: 'a', name: 'x' }], last: null, count: 0 }, { fire: 'code', lit: false, people: 1, names: [], last: null }] })
    window.ember.fireMessages = () => Promise.resolve([]); go('fires'); await wait(300); FIRE_ACTIVE = 'art'; renderFires(); await wait(300); FIRE_ACTIVE = null
    await window.ember.nearSetHidden(false); window.ember.nearSetLan(false); window.ember.nearSetArea(null); go('nearby'); await wait(300)
    for (const k of Object.keys(LOCATE_ERR)) { renderNearby({ error: LOCATE_ERR[k] }); await wait(150) }
    Object.assign(window.ember, real)
    document.querySelectorAll('.card .more').forEach(b => b.click())
    return [...window.__i18nMiss]`
  const seen = await win.webContents.executeJavaScript(`(async () => { ${steps} })()`)
  const tr = await win.webContents.executeJavaScript(`(${JSON.stringify(sourceStrings())}).filter(s => tr(s) === s)`)
  const all = [...new Set([...seen, ...tr.map(s => s.replace(/\s+/g, ' ').trim())])].sort()
  const file = path.join(os.tmpdir(), 'ember-i18n-missing-' + lang + '.json')
  fs.writeFileSync(file, JSON.stringify(all, null, 1) + NL)
  console.log(NL + all.length + ' strings missing for ' + lang + ' → ' + file)
  app.exit(0)
})
