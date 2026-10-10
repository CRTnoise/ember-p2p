#!/usr/bin/env node
// Applies every Android fix Ember Mobile needs to a fresh `react-native init`
// (RN 0.74.5) project. Idempotent: safe to run again. Fails loudly instead of
// guessing when a file doesn't look like a stock template.
//
// Why each fix exists (each one cost real debugging time):
//  - newArchEnabled=true   react-native-bare-kit is a pure C++ TurboModule; with
//                          the old architecture nothing ever registers 'BareKit'.
//  - minSdkVersion 29      bare-kit's own Gradle module requires API 29.
//  - Gradle 8.5            Gradle 8.6 (RN 0.74's default) has a Windows bug:
//                          "Could not move temporary workspace" on every build.
//  - permissions           INTERNET / network state for the swarm, notifications.
//  - metro .mjs            the bundled engine (src/engine.bundle.mjs) is ESM.
//  - patch-package         bare-kit's BareKitPackage isn't detected by CLI 13's
//                          autolinking regex, so its C++ module is silently dropped.
const fs = require('fs')
const path = require('path')
const root = process.argv[2] || process.cwd()
const p = (...x) => path.join(root, ...x)
let changed = 0

function edit (file, label, fn) {
  if (!fs.existsSync(file)) { console.error(`✗ ${label}: missing ${path.relative(root, file)} — run this from your RN project root`); process.exit(1) }
  const before = fs.readFileSync(file, 'utf8')
  const after = fn(before)
  if (after === null) { console.error(`✗ ${label}: unexpected file contents in ${path.relative(root, file)}, edit by hand (see TROUBLESHOOTING.md)`); process.exit(1) }
  if (after !== before) { fs.writeFileSync(file, after); changed++; console.log(`✓ ${label}`) } else console.log(`· ${label} (already set)`)
}

edit(p('android', 'gradle.properties'), 'newArchEnabled=true', s =>
  /newArchEnabled=/.test(s) ? s.replace(/newArchEnabled=\w+/, 'newArchEnabled=true') : s + '\nnewArchEnabled=true\n')

edit(p('android', 'build.gradle'), 'minSdkVersion 29 + NDK 26.1', s => {
  if (!/minSdkVersion\s*=\s*\d+/.test(s)) return null
  s = s.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 29')
  if (/ndkVersion\s*=/.test(s)) s = s.replace(/ndkVersion\s*=\s*"[^"]*"/, 'ndkVersion = "26.1.10909125"')
  else s = s.replace(/(minSdkVersion = 29)/, '$1\n        ndkVersion = "26.1.10909125"')
  return s
})

edit(p('android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'Gradle 8.5 wrapper', s =>
  /distributionUrl=/.test(s) ? s.replace(/distributionUrl=.*/, 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-all.zip') : null)

edit(p('android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'network + notification permissions', s => {
  if (!/<manifest[^>]*>/.test(s)) return null
  for (const perm of ['INTERNET', 'ACCESS_NETWORK_STATE', 'POST_NOTIFICATIONS']) {
    if (!s.includes(`android.permission.${perm}"`)) s = s.replace(/(<manifest[^>]*>)/, `$1\n    <uses-permission android:name="android.permission.${perm}" />`)
  }
  return s
})

edit(p('metro.config.js'), 'metro resolves .mjs', s => {
  if (s.includes("'mjs'")) return s
  if (!/const config = \{\s*\};?/.test(s)) return null
  return s.replace(/const config = \{\s*\};?/, "const config = {\n  resolver: { sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'mjs'] }\n};")
})

edit(p('package.json'), 'postinstall patch-package + engine script', s => {
  const j = JSON.parse(s)
  j.scripts = j.scripts || {}
  j.scripts.postinstall = 'patch-package'
  j.scripts['bundle:engine'] = 'bare-pack --preset android --out src/engine.bundle.mjs worklet/backend.mjs'
  return JSON.stringify(j, null, 2) + '\n'
})

const appGradle = fs.readFileSync(p('android', 'app', 'build.gradle'), 'utf8')
const appId = (appGradle.match(/applicationId\s+"([^"]+)"/) || [])[1]
if (appId && appId !== 'com.embermobile') console.warn(`! applicationId is ${appId}: update the path in src/fsdir.ts to /data/data/${appId}/files`)

console.log(changed ? `\n${changed} file(s) updated.` : '\nNothing to change.')
console.log('Next: npm install && npm run bundle:engine && npx react-native run-android')
