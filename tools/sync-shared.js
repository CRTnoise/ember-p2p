#!/usr/bin/env node
// Desktop and mobile MUST run byte-identical protocol code, or they compute
// different discovery buckets / signatures and silently stop seeing each other.
// Source of truth: desktop/src/{discovery,dm,protocol}.js (CommonJS).
// This generates mobile/worklet/*.mjs (ESM for the Bare runtime) from them.
//
//   node tools/sync-shared.js          regenerate the mobile copies
//   node tools/sync-shared.js --check  exit 1 if they are out of date (CI)
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const MODULES = ['discovery', 'dm', 'protocol']
const IMPORTS = {
  "const crypto = require('crypto')": "import crypto from 'bare-crypto'",
  "const sodium = require('sodium-universal')": "import sodium from 'sodium-universal'",
  "const b4a = require('b4a')": "import b4a from 'b4a'"
}
function toEsm (src, name) {
  let out = src.replace(/^'use strict'\n/m, '')
  for (const [cjs, esm] of Object.entries(IMPORTS)) out = out.split(cjs).join(esm)
  out = out.replace(/^module\.exports = \{([^}]*)\}\s*$/m, (_, names) => {
    // `open` collides with nothing in Bare but reads badly at call sites; mobile calls it openBox
    const list = names.split(',').map(s => s.trim()).filter(Boolean).map(n => (name === 'dm' && n === 'open') ? 'open as openBox' : n)
    return `export { ${list.join(', ')} }\n`
  })
  if (/require\(/.test(out)) throw new Error(`${name}: unhandled require() — add it to IMPORTS`)
  return out
}
const check = process.argv.includes('--check')
let stale = 0
for (const m of MODULES) {
  const src = fs.readFileSync(path.join(root, 'desktop', 'src', `${m}.js`), 'utf8')
  const dest = path.join(root, 'mobile', 'worklet', `${m}.mjs`)
  const want = toEsm(src, m)
  const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : ''
  if (want === have) { console.log(`· ${m}.mjs up to date`); continue }
  if (check) { console.error(`✗ mobile/worklet/${m}.mjs is out of sync with desktop/src/${m}.js`); stale++ }
  else { fs.writeFileSync(dest, want); console.log(`✓ regenerated mobile/worklet/${m}.mjs`) }
}
if (stale) { console.error('Run: node tools/sync-shared.js'); process.exit(1) }
