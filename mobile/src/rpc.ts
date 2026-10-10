// src/rpc.ts — bridge to the bare-kit worklet engine
import { Worklet } from 'react-native-bare-kit'
// @ts-ignore  bundled engine source (bare-pack output)
import bundle from './engine.bundle.mjs'
import RNFS from './fsdir'

type Pending = { resolve: (v: any) => void, reject: (e: any) => void }
type Listener = (data: any) => void

class Engine {
  worklet: any
  ipc: any
  nextId = 1
  pending = new Map<number, Pending>()
  listeners = new Map<string, Set<Listener>>()
  buf = ''
  ready = false

  async start () {
    this.worklet = new Worklet()
    await this.worklet.start('/backend.bundle', bundle, [RNFS.documents])
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (chunk: Uint8Array) => {
      this.buf += Buffer.from(chunk).toString()
      let nl
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1)
        this.dispatch(line)
      }
    })
  }

  dispatch (line: string) {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (msg.ev) {
      if (msg.ev === 'engine-ready') this.ready = true
      if (msg.ev === 'engine-error') console.error('[ember engine]', msg.data)
      const set = this.listeners.get(msg.ev)
      if (set) for (const fn of set) fn(msg.data)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.err))
  }

  // Media/story fetches legitimately wait on the network; everything else must
  // answer from disk fast, so a long timeout there would only hide a bug.
  static SLOW = new Set(['get-media', 'get-story', 'resolve-block', 'dm-send', 'save-post', 'post', 'post-story'])

  call (cmd: string, args: any = {}): Promise<any> {
    const id = this.nextId++
    const ms = Engine.SLOW.has(cmd) ? 45_000 : 12_000
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ipc.write(Buffer.from(JSON.stringify({ id, cmd, args }) + '\n'))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('rpc timeout: ' + cmd)) }
      }, ms)
    })
  }

  on (ev: string, fn: Listener) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set())
    this.listeners.get(ev)!.add(fn)
    return () => this.listeners.get(ev)!.delete(fn)
  }
}

export const engine = new Engine()

// convenience mirrors of the desktop preload API
export const api = {
  me: () => engine.call('me'),
  post: (text: string, image?: string | null, thumb?: string | null, quoteRef?: any) => engine.call('post', { text, image, thumb, quoteRef }),
  reply: (author: string, seq: number, text: string) => engine.call('reply', { author, seq, text }),
  getReplies: (author: string, seq: number) => engine.call('get-replies', { author, seq }),
  setProfile: (p: any) => engine.call('set-profile', p),
  follow: (key: string) => engine.call('follow', { key }),
  unfollow: (key: string) => engine.call('unfollow', { key }),
  timeline: () => engine.call('timeline'),
  discover: (query: string) => engine.call('discover', { query }),
  profilePage: (key: string) => engine.call('profile-page', { key }),
  repost: (author: string, seq: number) => engine.call('repost', { author, seq }),
  resolveBlock: (author: string, seq: number) => engine.call('resolve-block', { author, seq }),
  getMedia: (author: string, seq: number) => engine.call('get-media', { author, seq }),
  deletePost: (seq: number) => engine.call('delete-post', { seq }),
  postStory: (image: string, caption: string) => engine.call('post-story', { image, caption }),
  stories: () => engine.call('stories'),
  getStory: (author: string, seq: number) => engine.call('get-story', { author, seq }),
  dmSend: (to: string, text: string) => engine.call('dm-send', { to, text }),
  dmOpen: (key: string) => engine.call('dm-open', { key }),
  dmList: () => engine.call('dm-list'),
  dmAccept: (key: string) => engine.call('dm-accept', { key }),
  dmIgnore: (key: string) => engine.call('dm-ignore', { key }),
  savePost: (author: string, seq: number) => engine.call('save-post', { author, seq }),
  unsavePost: (author: string, seq: number) => engine.call('unsave-post', { author, seq }),
  savedList: () => engine.call('saved-list'),
  notifsList: () => engine.call('notifs-list'),
  notifsUnread: () => engine.call('notifs-unread'),
  notifsMarkRead: (type: string | null) => engine.call('notifs-mark-read', { type }),
  block: (key: string) => engine.call('block', { key }),
  mute: (key: string) => engine.call('mute', { key }),
  moderation: () => engine.call('moderation'),
  getSettings: () => engine.call('get-settings'),
  setSettings: (p: any) => engine.call('set-settings', p),
  exportIdentity: () => engine.call('export-identity')
}
