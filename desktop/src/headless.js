// EMBER headless — what main.js gets instead of Electron when it runs under
// plain Node (`npm run serve`): no window, no tray, no dialogs. The node is the
// same; people use it through the web interface (web.js).
//
//   node src/main.js [--port 7777] [--host 127.0.0.1] [--allow-host name]…
//                    [--data DIR] [--restore PRIMARY_KEY] [--export-identity]
const path = require('path')
const os = require('os')
const { EventEmitter } = require('events')

function argv (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
function argvAll (name) {
  const out = []
  process.argv.forEach((a, i) => { if (a === '--' + name && process.argv[i + 1]) out.push(...process.argv[i + 1].split(',')) })
  return out.map(s => s.trim()).filter(Boolean)
}
const flag = (name) => process.argv.includes('--' + name)

const app = new EventEmitter()
const root = path.resolve(argv('data', process.env.EMBER_DATA || path.join(os.homedir(), '.ember')))
app.getPath = () => root
app.whenReady = () => Promise.resolve()
app.setLoginItemSettings = () => {}
app.relaunch = () => {}
let quitting = false
app.quit = () => {
  if (quitting) return
  quitting = true
  app.emit('before-quit')
  app.emit('quit')
  setTimeout(() => process.exit(0), 1500) // let swarms say goodbye
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit())

const ipcMain = { handle () {} } // main.js keeps its own handler table; the web server calls it
const Menu = { setApplicationMenu () {}, buildFromTemplate () { return {} } }
const Notification = { isSupported: () => false }
const nativeImage = { createFromBuffer: () => ({}) }
class Tray { setToolTip () {} setContextMenu () {} on () {} }
class BrowserWindow {}
const dialog = {
  showErrorBox: (title, body) => { console.error(`\n${title}\n${body}\n`); process.exit(1) },
  showSaveDialog: async () => ({ canceled: true })
}
const shell = { openExternal () {} }

module.exports = {
  headless: true, app, ipcMain, Menu, Notification, nativeImage, Tray, BrowserWindow, dialog, shell,
  options: {
    port: +argv('port', process.env.EMBER_PORT || 7777),
    host: argv('host', process.env.EMBER_HOST || '127.0.0.1'),
    allowHosts: [...argvAll('allow-host'), ...(process.env.EMBER_ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)],
    restoreKey: argv('restore', null),
    exportIdentity: flag('export-identity')
  }
}
