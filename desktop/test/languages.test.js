// Interface languages: shipped translations, and ones dropped into the data folder.
// Run: node test/languages.test.js
const fs = require('fs'); const os = require('os'); const path = require('path')
const languages = require('../src/languages')
let pass = 0, fail = 0
function ok (c, msg) { if (c) pass++; else { fail++; console.log('  ✗', msg) } }

const SHIPPED = path.join(__dirname, '..', 'src', 'i18n')
const shipped = languages.load([SHIPPED])
const by = c => shipped.find(l => l.code === c)
ok(shipped[0].code === 'en' && shipped[0].file === null, 'English is not first')
for (const c of ['fr', 'zh', 'ar', 'ru']) ok(by(c), `${c} not found`)
ok(by('ru').label === 'РУССКИЙ' && by('ru').name === 'Русский' && by('ru').script === 'cyrillic', 'Russian meta')
ok(by('ar').dir === 'rtl' && by('fr').dir === 'ltr' && by('ru').dir === 'ltr', 'text direction')
ok(by('ru').words['CONTINUE →'] !== 'CONTINUE →' && by('zh').words.LANGUAGE === '语言', 'first-run words not taken from the dictionary')

// every shipped translation covers the same strings and patterns as French
const fr = languages.readDict(by('fr').file)
for (const l of shipped.filter(l => l.file)) {
  const d = languages.readDict(l.file)
  const missing = Object.keys(fr.strings).filter(k => !(k in d.strings))
  const extra = Object.keys(d.strings).filter(k => !(k in fr.strings))
  ok(!missing.length && !extra.length, `${l.code}: ${missing.length} missing, ${extra.length} unknown strings ${[...missing, ...extra].slice(0, 3).join(' | ')}`)
  ok(JSON.stringify((d.patterns || []).map(p => p[0])) === JSON.stringify(fr.patterns.map(p => p[0])), `${l.code}: patterns differ from fr`)
  for (const [re, rep] of d.patterns || []) {
    let groups = -1
    try { groups = new RegExp(re + '|').exec('').length - 1 } catch {}
    ok(groups >= 0, `${l.code}: bad pattern ${re}`)
    for (let i = 1; i <= groups; i++) ok(rep.includes('$' + i), `${l.code}: ${re} drops $${i}`)
  }
}

// a language dropped into the data folder; a fix to a shipped one wins
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-i18n-'))
fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ _meta: { language: 'Español' }, strings: { LANGUAGE: 'IDIOMA' } }))
fs.writeFileSync(path.join(dir, 'fr.json'), JSON.stringify({ _meta: { language: 'Français (corrigé)' }, strings: {} }))
fs.writeFileSync(path.join(dir, 'he.json'), JSON.stringify({ _meta: { language: 'עברית', dir: 'rtl', script: 'hebrew' }, strings: {} }))
fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify({ strings: { FEED: 'nope' } }))
fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
fs.writeFileSync(path.join(dir, 'evil name.json'), JSON.stringify({ strings: {} }))
const warn = console.warn; console.warn = () => {}
const all = languages.load([SHIPPED, dir, null, path.join(dir, 'does-not-exist')])
console.warn = warn
const es = all.find(l => l.code === 'es')
ok(es && es.label === 'ESPAÑOL' && es.dir === 'ltr' && es.script === 'latin' && es.words.LANGUAGE === 'IDIOMA' && es.words['I ALSO READ'] === 'I ALSO READ', 'user language not loaded with defaults')
ok(all.find(l => l.code === 'fr').name === 'Français (corrigé)', 'user file does not override a shipped one')
ok(all.find(l => l.code === 'he').dir === 'rtl' && all.find(l => l.code === 'he').script === 'latin', 'he: dir kept, unknown script falls back')
ok(all.filter(l => l.code === 'en').length === 1 && all[0].file === null, 'en.json replaced the built-in English')
ok(!all.some(l => l.code === 'broken' || l.code === 'notes' || l.code === 'evil name'), 'invalid files were listed')
ok(languages.CODE.test('pt-br') && !languages.CODE.test('../x') && !languages.CODE.test('english'), 'language code check')

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
