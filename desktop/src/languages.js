// EMBER interface languages.
//
// English is the source text, built into index.html. Every other language is
// one file, <code>.json, with the English strings as keys (see src/i18n/fr.json).
// Files are looked up in each folder given, in order: the ones shipped in
// src/i18n/, then the i18n folder in the data directory, where anyone can drop a
// new language without rebuilding Ember. A later file with the same code wins,
// so a shipped translation can also be fixed in place.
//
// _meta in each file (all optional):
//   language  the language's own name ("Русский")
//   label     what its button says ("РУССКИЙ"; default: language in capitals)
//   dir       "rtl" for right-to-left scripts
//   script    latin | cyrillic | zh | ar, for ONLY POSTS I CAN READ (default latin)
const fs = require('fs')
const path = require('path')
const taste = require('./taste')

const CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/
const SCRIPTS = new Set(['latin', 'cyrillic', 'zh', 'ar'])
// shown on the first-run language step before any dictionary is loaded
const WORDS = ['LANGUAGE', 'I ALSO READ', 'CONTINUE →']

function readDict (file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    return d && typeof d === 'object' && d.strings && typeof d.strings === 'object' ? d : null
  } catch { return null }
}

function load (dirs) {
  const files = new Map()
  for (const dir of dirs) {
    if (!dir) continue
    let names = []
    try { names = fs.readdirSync(dir) } catch {}
    for (const f of names) {
      if (!/\.json$/i.test(f)) continue
      const code = f.slice(0, -5).toLowerCase()
      if (code !== 'en' && CODE.test(code)) files.set(code, path.join(dir, f))
    }
  }
  const list = [{ code: 'en', name: 'English', label: 'ENGLISH', dir: 'ltr', script: 'latin', file: null, words: Object.fromEntries(WORDS.map(w => [w, w])) }]
  for (const [code, file] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = readDict(file)
    if (!d) { console.warn(`[i18n] skipping ${file}: not a translation file`); continue }
    const m = d._meta && typeof d._meta === 'object' ? d._meta : {}
    const str = (v, max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
    const name = str(m.language, 40) || code
    list.push({
      code, name, label: str(m.label, 40) || name.toUpperCase(), file,
      dir: m.dir === 'rtl' ? 'rtl' : 'ltr',
      script: SCRIPTS.has(m.script) ? m.script : (taste.SCRIPTS[code] || 'latin'),
      words: Object.fromEntries(WORDS.map(w => [w, str(d.strings[w], 60) || w]))
    })
  }
  return list
}

module.exports = { load, readDict, CODE }
