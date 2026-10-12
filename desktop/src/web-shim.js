// EMBER web shim — window.ember for a browser. The same API as preload.js, but
// every call is an HTTP request to the node serving this page and events
// arrive over a server-sent event stream. Injected into index.html by web.js.
;(function () {
  'use strict'
  window.EMBER_WEB = true
  const call = async (ch, args) => {
    const r = await fetch('/api/call/' + ch, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args === undefined ? null : args)
    })
    if (r.status === 401) { location.reload(); throw new Error('this browser is no longer paired') }
    const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }))
    if (!j.ok) throw new Error(j.error || 'failed')
    return j.value
  }
  // events
  const listeners = {}
  const on = (ch) => (cb) => { (listeners[ch] = listeners[ch] || []).push(cb) }
  let es = null, wasDown = false
  const connect = () => {
    es = new EventSource('/api/events')
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      for (const cb of listeners[m.ch] || []) { try { cb(m.data) } catch {} }
    }
    es.onopen = () => {
      document.documentElement.classList.remove('offline')
      // back after a drop: things happened while we couldn't hear them
      if (wasDown) { wasDown = false; for (const cb of listeners['feed-updated'] || []) { try { cb({ own: true }) } catch {} } }
    }
    es.onerror = () => { wasDown = true; document.documentElement.classList.add('offline') }
  }
  connect()

  // a file picked in the browser has no path on the node: upload it first
  async function upload (file) {
    const r = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) throw new Error(j.error || 'upload failed')
    return j.id
  }

  // clipboard needs HTTPS or localhost; on a plain-HTTP LAN address fall back
  if (!navigator.clipboard || !window.isSecureContext) {
    const writeText = (t) => new Promise((resolve) => {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove(); resolve()
    })
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true }) } catch {}
  }

  window.ember = {
    me: () => call('me'),
    post: (text, image, thumb, quoteRef) => call('post', { text, image, thumb, quoteRef }),
    getMedia: (author, seq) => call('get-media', { author, seq }),
    resolveBlock: (author, seq) => call('resolve-block', { author, seq }),
    reply: (author, seq, text) => call('reply', { author, seq, text }),
    getReplies: (author, seq) => call('get-replies', { author, seq }),
    setProfile: (p) => call('set-profile', p),
    follow: (key) => call('follow', { key }),
    unfollow: (key) => call('unfollow', { key }),
    repost: (author, seq) => call('repost', { author, seq }),
    timeline: () => call('timeline'),
    discover: (query) => call('discover', { query }),
    profilePage: (key) => call('profile-page', { key }),
    postVideo: async (file, text, thumb) => call('post-video', { upload: await upload(file), text, thumb }),
    pathForFile: (file) => file,
    onTranscodeProgress: on('transcode-progress'),
    getVideo: (author, meta) => call('get-video', { author, meta }),
    warmCacheStats: () => call('warm-cache-stats'),
    onVideoProgress: on('video-progress'),
    deletePost: (seq) => call('delete-post', { seq }),
    postStory: (image, caption) => call('post-story', { image, caption }),
    stories: () => call('stories'),
    getStory: (author, seq) => call('get-story', { author, seq }),
    block: (key) => call('block', { key }),
    mute: (key) => call('mute', { key }),
    unblock: (key) => call('unblock', { key }),
    unmute: (key) => call('unmute', { key }),
    moderation: () => call('moderation'),
    exportIdentity: () => call('export-identity'),
    restoreIdentity: (primaryKey) => call('restore-identity', { primaryKey }),
    dmAccept: (key) => call('dm-accept', { key }),
    dmIgnore: (key) => call('dm-ignore', { key }),
    notifsList: () => call('notifs-list'),
    notifsUnread: () => call('notifs-unread'),
    notifsMarkRead: (type) => call('notifs-mark-read', { type }),
    onNotif: on('notif'),
    winMin: async () => {},
    winMax: async () => {},
    winClose: async () => {},
    reloadUi: async () => location.reload(),
    onEngineReady: on('engine-ready'),
    dmSend: (to, text) => call('dm-send', { to, text }),
    dmOpen: (key) => call('dm-open', { key }),
    dmList: () => call('dm-list'),
    savePost: (author, seq) => call('save-post', { author, seq }),
    unsavePost: (author, seq) => call('unsave-post', { author, seq }),
    savedList: () => call('saved-list'),
    getSettings: () => call('get-settings'),
    setSettings: (p) => call('set-settings', p),
    clearCache: () => call('clear-cache'),
    onDmReceived: on('dm-received'),
    onDmPeers: on('dm-peers'),
    onFeedUpdated: on('feed-updated'),
    onDiscoverUpdated: on('discover-updated'),
    onRepliesUpdated: on('replies-updated'),
    onPeers: on('peers'),
    onGossipPeers: on('gossip-peers'),
    onBuckets: on('buckets'),
    nearState: () => call('near-state'),
    nearSetLan: (on_) => call('near-set-lan', { on: on_ }),
    nearSetArea: (cfg) => call('near-set-area', cfg),
    nearSearch: (q) => call('near-search', { q }),
    nearLocate: (radius) => call('near-locate', { radius }),
    nearSetHidden: (hidden) => call('near-set-hidden', { hidden }),
    onNearUpdated: on('near-updated'),
    restoreSkip: () => call('restore-skip'),
    onRestoreState: on('restore-state'),
    tasteState: () => call('taste-state'),
    tasteSet: (patch) => call('taste-set', patch),
    tasteForget: (term) => call('taste-forget', { term }),
    tasteReset: () => call('taste-reset'),
    notInterested: (author, seq) => call('not-interested', { author, seq }),
    i18n: (lang) => call('i18n', { lang }),
    modState: () => call('mod-state'),
    modSet: (patch) => call('mod-set', patch),
    modSub: (key) => call('mod-sub', { key }),
    modUnsub: (key) => call('mod-unsub', { key }),
    onModUpdated: on('mod-updated'),
    firesList: () => call('fires-list'),
    fireMessages: (fire) => call('fire-messages', { fire }),
    fireSend: (fire, text) => call('fire-send', { fire, text }),
    onFiresUpdated: on('fires-updated'),
    onCommonsState: on('commons-state'),
    webState: () => call('web-state'),
    webSet: (patch) => call('web-set', patch),
    webNewCode: () => call('web-new-code'),
    webRevoke: (id) => call('web-revoke', { id }),
    webOpen: () => call('web-open'),
    webLogout: () => fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(() => location.reload()),
    onWebUpdated: on('web-updated')
  }
})()
