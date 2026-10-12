// Fictional demo data with the same shape as the real engine (window.ember).
// Used by the UI test suite and to render README screenshots. Never shipped.
// Demo stand-in for window.ember: same API shape as preload.js, fictional data.
// Used only to render README screenshots of the real UI. Never shipped.
(function () {
  const Q = new URLSearchParams(location.search)
  const THEME = Q.get('theme') || 'paper'
  const now = Date.now(), m = 60e3, h = 60 * m, d = 24 * h
  const K = (c) => c.repeat(64).slice(0, 64)
  const ME_KEY = K('a1f3'), MIRA = K('3b8e'), TOVAR = K('7c21'), OLAND = K('d40a'), ADA = K('5e9f'), NOOR = K('b6c3'), PAV = K('9a17')
  const S1 = K('e2d4'), S2 = K('41fb'), S3 = K('c09e'), STRANGER = K('8d2c'), LANP = K('6f0b')

  // ---------- procedural images ----------
  function canvas (w, hh, draw, type = 'image/jpeg', q = 0.88) {
    const c = document.createElement('canvas'); c.width = w; c.height = hh
    const g = c.getContext('2d'); draw(g, w, hh)
    return c.toDataURL(type, q)
  }
  function rnd (seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647 }

  function hatchAvatar (angle, bg, fg, gap = 7) {
    return canvas(160, 160, (g, w) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, w)
      g.save(); g.translate(w / 2, w / 2); g.rotate(angle * Math.PI / 180)
      g.strokeStyle = fg; g.lineWidth = 3
      for (let x = -w; x < w; x += gap) { g.beginPath(); g.moveTo(x, -w); g.lineTo(x, w); g.stroke() }
      g.restore()
    }, 'image/png')
  }
  // two-pass risograph halftone with deliberate register drift
  const riso = canvas(1200, 540, (g, w, hh) => {
    g.fillStyle = '#f1ebe0'; g.fillRect(0, 0, w, hh)
    const pass = (color, dx, dy, fn) => {
      g.fillStyle = color; g.globalCompositeOperation = 'multiply'
      for (let y = 0; y < hh; y += 14) for (let x = 0; x < w; x += 14) {
        const r = fn(x, y); if (r > 0.3) { g.beginPath(); g.arc(x + dx, y + dy, r, 0, 7); g.fill() }
      }
    }
    pass('#ff4f8b', 0, 0, (x, y) => 6.5 * (0.5 + 0.5 * Math.sin(x / 140) * Math.cos(y / 110)) * (1 - Math.hypot(x - 420, y - 260) / 760))
    pass('#1f5bd8', 9, 6, (x, y) => 6.5 * Math.max(0, 1 - Math.hypot(x - 780, y - 290) / 380))
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = '#1b1b1b'; g.font = '700 54px monospace'; g.fillText('REGISTER / DRIFT', 60, 500)
  })
  // pixel-art night market (40 rows of 15px)
  const pixel = canvas(1200, 600, (g, w, hh) => {
    const P = 15, r = rnd(42), cols = w / P, rows = hh / P
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const t = y / rows; g.fillStyle = `rgb(${18 + t * 46},${16 + t * 24},${48 + t * 34})`; g.fillRect(x * P, y * P, P, P)
    }
    for (let i = 0; i < 70; i++) { g.fillStyle = r() > 0.5 ? '#fff6c8' : '#9fb7ff'; g.fillRect(Math.floor(r() * cols) * P, Math.floor(r() * 13) * P, P, P) }
    g.fillStyle = '#f3e9d2'; g.fillRect(64 * P, 3 * P, 4 * P, 4 * P); g.fillRect(63 * P, 4 * P, 6 * P, 2 * P)   // moon
    for (let i = 0; i < 25; i++) { const x = 3 + i * 3; g.fillStyle = '#3a2f4a'; g.fillRect(x * P, 16 * P, P, P); g.fillStyle = i % 3 ? '#ffd15c' : '#ff7a5c'; g.fillRect(x * P, (17 + (i % 2)) * P, P, 2 * P) }
    const stall = (x0, wid, roof, glow) => {
      for (let i = 0; i < wid; i++) { g.fillStyle = i % 2 ? roof : '#f3e9d2'; g.fillRect((x0 + i) * P, 21 * P, P, 3 * P) }
      g.fillStyle = '#2b1d33'; g.fillRect(x0 * P, 24 * P, wid * P, 10 * P)
      g.fillStyle = glow; g.fillRect((x0 + 2) * P, 26 * P, (wid - 4) * P, 4 * P)
      g.fillStyle = '#1a1222'; for (let i = 0; i < wid; i += 3) g.fillRect((x0 + i + 1) * P, 30 * P, P, 4 * P)
    }
    stall(4, 16, '#e0414f', '#ffb347'); stall(26, 22, '#2fa36b', '#ffd27a'); stall(54, 18, '#3f6fe0', '#ff9d6e')
    g.fillStyle = '#0d0b14'; g.fillRect(0, 34 * P, w, hh)
    for (let x = 0; x < cols; x += 2) { g.fillStyle = '#1d1828'; g.fillRect(x * P, 36 * P, P, P) }
  })
  // video thumbnail: studio + waveform
  const vthumb = canvas(1200, 675, (g, w, hh) => {
    const gr = g.createLinearGradient(0, 0, w, hh); gr.addColorStop(0, '#1c1e26'); gr.addColorStop(1, '#3a2c22')
    g.fillStyle = gr; g.fillRect(0, 0, w, hh)
    const rg = g.createRadialGradient(w * 0.5, -40, 20, w * 0.5, -40, 620); rg.addColorStop(0, 'rgba(255,200,130,.34)'); rg.addColorStop(1, 'rgba(255,200,130,0)')
    g.fillStyle = rg; g.fillRect(0, 0, w, hh)
    const r = rnd(7); g.fillStyle = '#f2b66b'
    for (let x = 80; x < w - 80; x += 14) { const a = 20 + r() * 150 * Math.abs(Math.sin(x / 90)); g.fillRect(x, hh * 0.62 - a / 2, 8, a) }
  })
  const story = (c1, c2) => canvas(540, 960, (g, w, hh) => {
    const gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, w, hh)
  })
  const testSheet = canvas(800, 600, (g, w, hh) => {
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, w, hh)
    const sw = ['#ff4f8b', '#1f5bd8', '#f7c948', '#16a085', '#1b1b1b']
    sw.forEach((c, i) => { g.fillStyle = c; g.globalAlpha = 0.9; g.fillRect(60 + i * 140, 80, 110, 300) })
    g.globalAlpha = 1; g.fillStyle = '#1b1b1b'; g.font = '700 30px monospace'; g.fillText('TEST SHEET · PASS 2', 60, 470)
  })

  const avatars = {
    [ME_KEY]: hatchAvatar(45, '#ffffff', '#111', 9),
    [MIRA]: hatchAvatar(-45, '#ffe3ec', '#c2185b', 8),
    [TOVAR]: hatchAvatar(0, '#e7eefc', '#1f3f8f', 8),
    [OLAND]: hatchAvatar(60, '#efe8ff', '#4a2a8c', 6),
    [ADA]: hatchAvatar(-20, '#e5f5ec', '#16714a', 7),
    [NOOR]: hatchAvatar(90, '#fff1df', '#a4561a', 7),
    [PAV]: hatchAvatar(30, '#f0f0f0', '#555', 10)
  }
  const prof = (k, name, status, bio) => ({ name, status, bio, avatar: avatars[k], dmKey: K('ee') })
  const profiles = {
    [ME_KEY]: prof(ME_KEY, 'Wren', 'building', 'Making small things on the open network.'),
    [MIRA]: prof(MIRA, 'Mira Kovač', 'studio', 'Printmaker. Two colours maximum.'),
    [TOVAR]: prof(TOVAR, 'Tovar', 'away', 'Writes long posts about short feeds.'),
    [OLAND]: prof(OLAND, 'J. Oland', 'pixels', '16 colours, no anti-aliasing.'),
    [ADA]: prof(ADA, 'Ada Fenn', 'online', 'Process, not results.'),
    [NOOR]: prof(NOOR, 'noor', 'rehearsing', 'Sound, mostly.'),
    [PAV]: prof(PAV, 'pav', '', ''),
    [S1]: { name: 'kestrel', status: '' }, [S2]: { name: 'linocut.lou', status: '' }, [S3]: { name: 'hana', status: '' }
  }

  const items = [
    { author: MIRA, seq: 41, ts: now - 22 * m, type: 'post', text: 'Finished the risograph run this morning. Two passes, pink then blue, and the **register drift** is the whole point.', mediaSeq: 40, thumb: riso },
    { author: TOVAR, seq: 88, ts: now - 1 * h - 4 * m, type: 'post', text: 'Unpopular: a feed should be *boring*. Boring means I can read it.\n\nNo ranking, no "for you". Just the people I chose, in the order they spoke.' },
    { author: OLAND, seq: 12, ts: now - 3 * h, type: 'post', text: 'Pixel set for the night-market zine. 16 colours, every lantern hand-placed.', mediaSeq: 11, thumb: pixel },
    { author: ADA, seq: 7, ts: now - 5 * h, type: 'quote', text: "Agree. The calmest timeline I've used is the one with nobody optimising it.", ref: { author: TOVAR, seq: 88 } },
    { author: NOOR, seq: 23, ts: now - 1 * d - 2 * h, type: 'post', text: 'Rehearsal take, studio B. Watching = seeding, so if you watch it you keep it alive.', thumb: vthumb, videoMeta: { start: 3, count: 19, mime: 'video/mp4', size: 18_400_000 } },
    { author: ME_KEY, seq: 31, ts: now - 1 * d - 6 * h, type: 'post', text: 'Tip: save a post with ◇ and you keep re-broadcasting it, even after the author goes offline. That\'s the "keep it warm" part.' },
    { author: OLAND, seq: 9, ts: now - 2 * d - 3 * h, type: 'post', text: 'Reminder that `npm start` is the whole install. No account, no email, just a key.' }
  ]
  const replyCounts = { [`${TOVAR}:88`]: 14, [`${MIRA}:41`]: 6, [`${NOOR}:23`]: 3 }

  const discoverItems = [
    { author: S1, seq: 5, ts: now - 40 * m, text: 'Anyone else doing two-colour riso zines? Looking for people to trade prints with.', kind: 'post', score: 0.91, trust: 'verified' },
    { author: MIRA, seq: 41, ts: now - 22 * m, text: 'Finished the risograph run this morning. The register drift is the whole point.', kind: 'post', score: 0.86, trust: 'verified' },
    { author: S2, seq: 14, ts: now - 6 * h, text: 'Carved a new linocut for the cover, printing the zine on the riso next week.', kind: 'post', score: 0.74, trust: 'verified' },
    { author: S3, seq: 2, ts: now - 1 * d, text: 'Small press fair this weekend — bringing the riso prints and the pixel zines.', kind: 'post', score: 0.63, trust: 'tofu' }
  ]

  const env = (k, dd) => JSON.stringify({ k, d: dd })
  const threads = {
    [MIRA]: [
      { from: MIRA, to: ME_KEY, ts: now - 50 * m, text: env('t', 'did the second pass line up on yours?') },
      { from: ME_KEY, to: MIRA, ts: now - 47 * m, text: env('t', 'drifted about 2mm. honestly looks better that way') },
      { from: MIRA, to: ME_KEY, ts: now - 31 * m, text: env('i', testSheet) },
      { from: MIRA, to: ME_KEY, ts: now - 30 * m, text: env('t', 'ok sending the register test now') },
      { from: ME_KEY, to: MIRA, ts: now - 12 * m, text: env('t', 'perfect. bring it saturday?'), delivered: true }
    ],
    [TOVAR]: [{ from: TOVAR, to: ME_KEY, ts: now - 2 * h, text: env('t', 'the boring feed post did numbers, ironically') }],
    [PAV]: [{ from: PAV, to: ME_KEY, ts: now - 3 * d, text: env('t', 'hey! saw your post in the riso bucket') }]
  }
  // a stranger: not followed, so the timeline never carries their profile
  const strangerProfile = { name: 'altena', status: '' }
  const strangerPosts = [{ author: STRANGER, seq: 0, ts: now - 41 * m, type: 'post', text: 'Hello World!' }]
  let near = {
    hidden: false,
    saved: { lan: true, area: { place: 'Évry, FR', lat: 48.63, lon: 2.44, radius: 25, source: 'located' } },
    lan: { on: true, error: null },
    area: { on: true, place: 'Évry, FR', lat: 48.63, lon: 2.44, radius: 25, connections: 3 },
    radii: [10, 25, 50, 150],
    people: [
      { key: LANP, name: 'room-404', edpk: K('11'), verified: false, lan: { seen: now - 4000 }, firstSeen: now - 60e3 },
      { key: S2, name: 'linocut.lou', edpk: K('22'), verified: true, area: { seen: now - 9000, place: 'Paris, FR', km: 25 }, firstSeen: now - 9e5 }
    ]
  }
  const places = [
    { place: 'Évry, FR', lat: 48.63, lon: 2.44, pop: 51900 }, { place: 'Évreux, FR', lat: 49.02, lon: 1.15, pop: 51198 }
  ]
  const stories = [
    { author: ME_KEY, self: true, stories: [{ author: ME_KEY, seq: 30, caption: 'studio', ts: now - 1 * h }] },
    { author: MIRA, self: false, stories: [{ author: MIRA, seq: 50, caption: 'drying rack', ts: now - 2 * h }] },
    { author: OLAND, self: false, stories: [{ author: OLAND, seq: 20, caption: '', ts: now - 5 * h }] },
    { author: TOVAR, self: false, stories: [{ author: TOVAR, seq: 90, caption: '', ts: now - 9 * h }] }
  ]
  const notifs = [
    { id: 'n1', type: 'reply', from: TOVAR, ts: now - 18 * m, text: 'boring is a feature', read: false, ref: { author: ME_KEY, seq: 31 } },
    { id: 'n2', type: 'dm', from: MIRA, ts: now - 30 * m, text: 'ok sending the register test now', read: false },
    { id: 'n3', type: 'post', from: OLAND, ts: now - 3 * h, text: 'Pixel set for the night-market zine.', read: true }
  ]

  // v2.8: topics, compass, circle moderation, campfires
  const catalog = [
    { id: 'music', label: { en: 'Music', fr: 'Musique', zh: '音乐', ar: 'موسيقى' } },
    { id: 'art', label: { en: 'Art & print', fr: 'Art & estampe', zh: '艺术与版画', ar: 'فن وطباعة' } },
    { id: 'pixel', label: { en: 'Pixel art', fr: 'Pixel art', zh: '像素艺术', ar: 'فن البكسل' } },
    { id: 'code', label: { en: 'Code', fr: 'Code', zh: '编程', ar: 'برمجة' } },
    { id: 'privacy', label: { en: 'Privacy', fr: 'Vie privée', zh: '隐私', ar: 'الخصوصية' } }
  ]
  let taste = { catalog, langs: ['en', 'fr', 'zh', 'ar'], topics: ['art', 'pixel'], topicText: 'risograph zines', dial: 1, onlyMyLangs: false, uiLang: 'en', readLangs: ['en', 'fr'],
    onboarded: Q.get('onboarded') !== '0', campfires: true, terms: [{ term: 'riso', w: 2.1 }, { term: 'zine', w: 1.6 }, { term: 'linocut', w: 0.9 }], avoid: [{ term: 'crypto', w: -0.8 }], suggest: [] }
  let mod = { publishBlocklist: false, circleSignals: true, subs: [{ key: K('c1'), name: 'tovar-lists', count: 37, ts: now - d }], blocked: 0, listHidden: 37, circleHidden: 2, circleSoft: 5 }
  const fireMsgs = [
    { fire: 'art', author: S2, name: 'linocut.lou', ts: now - 4 * m, text: 'anyone printing this weekend?', verified: true },
    { fire: 'art', author: S1, name: 'kestrel', ts: now - 3 * m, text: 'riso on saturday, two colours', verified: false }
  ]
  const why = [{ k: 'topic', topic: 'art' }, { k: 'follow' }, { k: 'compass', terms: ['riso', 'zine'] }, { k: 'wide' }]
  const ok = (v) => Promise.resolve(v)
  let webst = { on: true, headless: false, saved: { on: true, lan: false, port: 7777 }, urls: ['http://127.0.0.1:7777'], code: '12345678', codeExpires: now + 9 * m, locked: false, error: null, current: null,
    devices: [{ id: 'd1', label: 'Firefox on Android', created: now - 2 * d, lastSeen: now - 5 * m }, { id: 'd2', label: 'Chrome on Windows', created: now - d, lastSeen: now - h }] }

  const noop = () => {}
  const emit = (fn, v, delay = 300) => setTimeout(() => fn(v), delay)
  window.DEMO = { ME_KEY, MIRA, TOVAR, STRANGER, LANP }
  // listeners the page registers, so tests can play engine events: __emit('onFeedUpdated', {...})
  window.__on = {}
  window.__emit = (n, v) => (window.__on[n] || []).forEach(cb => cb(v))
  window.ember = {
    me: () => ok({ key: ME_KEY, length: 32, profile: profiles[ME_KEY] }),
    timeline: () => ok({ items, profiles, follows: [MIRA, TOVAR, OLAND, ADA, NOOR], peers: 6, seeders: 4, replyCounts }),
    discover: (q) => ok({ items: (q ? discoverItems : discoverItems.slice().sort((a, b) => b.ts - a.ts)).map((it, i) => ({ ...it, why: q ? { k: 'search' } : why[i % why.length], flagged: !q && i === 3 })), profiles, buckets: 24, gossipPeers: 9, dial: taste.dial, quiet: !!Q.get('quiet'), topics: taste.topics.length, commons: true }),
    tasteState: () => ok(taste),
    webState: () => ok(webst),
    webSet: (p) => { webst = { ...webst, saved: { ...webst.saved, ...p }, on: p.on === undefined ? webst.on : p.on }; return ok(webst) },
    webNewCode: () => { webst = { ...webst, code: '87654321' }; return ok(webst) },
    webRevoke: (id) => { webst = { ...webst, devices: webst.devices.filter(x => x.id !== id) }; return ok(webst) },
    webOpen: () => ok(true),
    tasteSet: (p) => { taste = { ...taste, ...p }; return ok(taste) },
    tasteForget: (t) => { taste = { ...taste, terms: taste.terms.filter(x => x.term !== t), avoid: taste.avoid.filter(x => x.term !== t) }; return ok(taste) },
    tasteReset: () => { taste = { ...taste, terms: [], avoid: [] }; return ok(taste) },
    i18n: (l) => ok(window.__I18N ? window.__I18N[l] || null : null),
    modState: () => ok(mod),
    modSet: (p) => { mod = { ...mod, ...p }; return ok(mod) },
    modSub: (k) => { mod = { ...mod, subs: [...mod.subs, { key: k, name: '', count: 0, ts: 0 }] }; return ok(mod) },
    modUnsub: (k) => { mod = { ...mod, subs: mod.subs.filter(x => x.key !== k) }; return ok(mod) },
    firesList: () => ok({ on: taste.campfires, fires: [
      { fire: 'art', lit: true, people: 3, names: [{ key: S2, name: 'linocut.lou' }, { key: S1, name: 'kestrel' }], terms: [], last: fireMsgs[1], count: 2 },
      { fire: 'pixel', lit: false, people: 2, names: [{ key: S3, name: 'hana' }], terms: [], last: null, count: 0 }] }),
    fireMessages: () => ok(fireMsgs),
    fireSend: (f, t) => { fireMsgs.push({ fire: f, author: ME_KEY, name: 'Wren', ts: Date.now(), text: t, mine: true, verified: true }); return ok({ ok: true }) },
    resolveBlock: (a, s) => ok(items.find(i => i.author === a && i.seq === s) || null),
    getMedia: (a, s) => ok(s === 40 ? riso : s === 11 ? pixel : null),
    getReplies: () => ok([]), stories: () => ok(stories),
    getStory: (a) => ok({ data: a === MIRA ? story('#ffd6e3', '#7aa2ff') : story('#2c2350', '#ffb347'), caption: '', ts: now }),
    profilePage: (k) => ok({ key: k, self: k === ME_KEY, profile: profiles[k] || (k === STRANGER ? strangerProfile : null), joined: now - 90 * d, stats: { posts: 41, following: 5, blocks: 120 }, posts: k === STRANGER ? strangerPosts : items.filter(i => i.author === k), isFollowed: k !== STRANGER }),
    nearState: () => ok(near),
    nearSetLan: (on) => { near = { ...near, lan: { on, error: null }, saved: { ...near.saved, lan: on } }; return ok(near) },
    nearSetArea: (c) => { near = { ...near, area: c ? { on: true, connections: 0, ...c } : { on: false }, saved: { ...near.saved, area: c } }; return ok(near) },
    nearSetHidden: (h) => { near = { ...near, hidden: h, people: h ? [] : near.people }; return ok(near) },
    nearLocate: (r) => window.__locateFails ? ok({ error: 'denied', state: near }) : (near = { ...near, saved: { ...near.saved, area: { place: 'Évry, FR', lat: 48.63, lon: 2.44, radius: r, source: 'located' } } }, ok({ town: { place: 'Évry, FR', km: 1 }, state: near })),
    nearSearch: (q) => ok(q ? places : []),
    dmList: () => ok([
      { key: MIRA, last: threads[MIRA][4], count: 5, request: false },
      { key: TOVAR, last: threads[TOVAR][0], count: 1, request: false },
      { key: PAV, last: threads[PAV][0], count: 1, request: true }
    ]),
    dmOpen: (k) => ok(threads[k] || []),
    notifsList: () => ok(notifs), notifsUnread: () => ok({ reply: 1, dm: 1, post: 0, total: 2 }), notifsMarkRead: () => ok(true),
    savedList: () => ok([{ author: OLAND, seq: 12 }]),
    getSettings: () => ok({ theme: THEME, tailWindow: 150, commons: true, keepDmHistory: true, autostart: true, storageBytes: 48_200_000, savedCount: 1, cacheCount: 212 }),
    setSettings: (p) => ok({ theme: THEME, ...p }), moderation: () => ok({ blocked: [], muted: [] }),
    warmCacheStats: () => ok({ bytes: 18_400_000, count: 1 }),
    onPeers: (fn) => emit(fn, 6), onGossipPeers: (fn) => emit(fn, 9), onBuckets: (fn) => emit(fn, 24),
    pathForFile: () => ''
  }
  // everything else the preload exposes: harmless no-ops / empty results
  for (const n of ['post', 'reply', 'setProfile', 'follow', 'unfollow', 'repost', 'postVideo', 'getVideo', 'deletePost', 'postStory',
    'block', 'mute', 'unblock', 'unmute', 'notInterested', 'restoreSkip', 'exportIdentity', 'restoreIdentity', 'dmAccept', 'dmIgnore', 'dmSend', 'savePost', 'unsavePost', 'clearCache',
    'winMin', 'winMax', 'winClose']) if (!window.ember[n]) window.ember[n] = () => ok(true)
  for (const n of ['onTranscodeProgress', 'onVideoProgress', 'onNotif', 'onEngineReady', 'onDmReceived', 'onDmPeers', 'onFeedUpdated', 'onDiscoverUpdated', 'onRepliesUpdated', 'onNearUpdated', 'onRestoreState', 'onModUpdated', 'onFiresUpdated', 'onCommonsState'])
    if (!window.ember[n]) window.ember[n] = (cb) => { (window.__on[n] = window.__on[n] || []).push(cb) }
})()
