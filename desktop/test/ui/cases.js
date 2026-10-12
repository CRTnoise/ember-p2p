// each test runs in a freshly loaded page. Helpers: q, qa, click, wait, called, until
module.exports = [
  // ---------- inbox rail ----------
  ['rail: ACCEPT a message request', `click(qa('#irlist .acc')[0]); await until(() => called('dmAccept')); return called('dmAccept') && q('#irthread').classList.contains('open')`],
  ['rail: IGNORE a message request', `click(qa('#irlist .ign')[0]); await until(() => called('dmIgnore')); return called('dmIgnore')`],
  ['rail: open a conversation', `click([...qa('#irlist .dmrow')].find(r => r.textContent.includes('Mira'))); await until(() => called('dmOpen')); return q('#irthread').classList.contains('open')`],
  ['rail: opened conversation focuses the message box', `await openDmInRail(DEMO.MIRA); await wait(300); return document.activeElement === q('#irText')`],
  ['rail: send a message', `await openDmInRail(DEMO.MIRA); q('#irText').value = 'hi'; click(q('#irSend')); await until(() => called('dmSend')); return called('dmSend')`],
  ['rail: back button closes thread', `await openDmInRail(DEMO.MIRA); click(q('#irBack')); await wait(200); return !q('#irthread').classList.contains('open')`],
  ['rail: new DM accepts a messy pasted key', `q('#irNewKey').value = 'publicKey: ' + DEMO.TOVAR.toUpperCase() + '\\n'; click(q('#irNewBtn')); await wait(400); return q('#irthread').classList.contains('open')`],
  ['rail: DM image opens the image viewer', `await openDmInRail(DEMO.MIRA); await wait(300); click(q('#irmsgs img')); await wait(300); const lb = q('#lightbox'); return !!lb && lb.classList.contains('open')`],
  // ---------- full DM view ----------
  ['dm view: ACCEPT a message request', `await openDm(null).catch(()=>{}); go('inbox'); await renderDmList(); click(qa('#dmlist .acc')[0]); await until(() => called('dmAccept')); return called('dmAccept')`],
  ['dm view: IGNORE a message request', `go('inbox'); await renderDmList(); click(qa('#dmlist .ign')[0]); await until(() => called('dmIgnore')); return called('dmIgnore')`],
  ['dm view: ACCEPT + FOLLOW', `go('inbox'); await renderDmList(); click(qa('#dmlist .accfl')[0]); await until(() => called('follow')); return called('dmAccept') && called('follow')`],
  ['dm view: request preview is text, not protocol JSON', `go('inbox'); await renderDmList(); return !q('#dmlist').textContent.includes('{"k"')`],
  // ---------- cards ----------
  ['card: reply opens thread', `click(q('.card .th')); await until(() => called('getReplies')); return called('getReplies')`],
  ['card: quote shows quote bar', `click(q('.card .qt')); await wait(200); return q('.quotebar') && q('.quotebar').classList.contains('show')`],
  ['card: repost', `click(q('.card .rp')); await until(() => called('repost')); return called('repost')`],
  ['card: save', `const b = [...qa('.card .sv')].find(x => !x.classList.contains('on')); click(b); await until(() => called('savePost')); return called('savePost')`],
  ['card: ··· menu → DM opens rail thread', `const c = qa('.card')[0]; click(c.querySelector('.more')); await wait(100); click(c.querySelector('[data-m=dm]')); await wait(500); return q('#irthread').classList.contains('open') || called('dmOpen')`],
  ['card: ··· menu → profile', `const c = qa('.card')[0]; click(c.querySelector('.more')); click(c.querySelector('[data-m=prof]')); await until(() => called('profilePage')); return called('profilePage')`],
  ['card: ··· menu → mute', `const c = qa('.card')[0]; click(c.querySelector('.more')); click(c.querySelector('[data-m=mute]')); await until(() => called('mute')); return called('mute')`],
  ['card: ··· menu → block', `const c = qa('.card')[0]; click(c.querySelector('.more')); click(c.querySelector('[data-m=block]')); await until(() => called('block')); return called('block')`],
  ['card: ··· menu → delete own post', `const c = [...qa('.card')].find(x => x.dataset.author === DEMO.ME_KEY); click(c.querySelector('.more')); click(c.querySelector('[data-m=del]')); await until(() => called('deletePost')); return called('deletePost')`],
  ['card: post image opens the image viewer', `click(q('.card .postimg[data-media]')); await wait(500); const lb = q('#lightbox'); return !!lb && lb.classList.contains('open') && called('getMedia')`],
  ['card: video opens the player', `click(q('.vidwrap')); await until(() => called('getVideo')); await wait(300); return q('#vplayer').classList.contains('open')`],
  ['card: author name opens profile', `click(q('.card .who')); await until(() => called('profilePage')); return called('profilePage')`],
  // ---------- compose / top bar ----------
  ['compose: post text', `q('#text').value = 'hello swarm'; q('#text').dispatchEvent(new Event('input')); click(q('#postBtn')); await until(() => called('post')); return called('post')`],
  ['top: follow a messy pasted key', `const i = q('#followKey'); if (!i) return 'no #followKey'; i.value = ' ' + DEMO.TOVAR + ' '; const b = q('#followBtn') || q('#followGo') || [...qa('button')].find(x => /^FOLLOW$/.test(x.textContent.trim()) && x.offsetParent); click(b); await until(() => called('follow')); return called('follow')`],
  // ---------- navigation ----------
  // ---------- profile names / story menu (v2.7 fixes) ----------
  ['profile: a stranger\'s posts show their name, not their key', `await openProfile(DEMO.STRANGER); await wait(400); const w = q('#pposts .card .who'); return !!w && w.textContent === 'altena'`],
  ['stories: own story menu is fully visible beside the rail', `const t = q('.story.self'); if (!t) return 'no own story tile'; t.dispatchEvent(new MouseEvent('mouseenter')); const m = t.querySelector('.storymenu'); m.style.display = 'flex'; const r = m.getBoundingClientRect(); const rail = q('#storiesRail').getBoundingClientRect(); const outside = document.elementFromPoint(rail.right + 20, r.top + r.height / 2); return getComputedStyle(m).position === 'fixed' && r.right > rail.right + 40 && m.contains(outside)`],
  // ---------- nearby ----------
  ['nearby: page lists people from both channels', `go('nearby'); await until(() => q('#n-people .nprow')); const rows = qa('#n-people .nprow'); return rows.length === 2 && rows[0].textContent.includes('SAME NETWORK') && rows[1].textContent.includes('PARIS, FR')`],
  ['nearby: unconfirmed cards are marked', `go('nearby'); await until(() => q('#n-people .nprow')); return qa('#n-people .ntag.warn').length === 1`],
  ['nearby: same-network switch reaches the engine', `go('nearby'); await until(() => q('#n-lan')); click(q('#n-lan')); await until(() => called('nearSetLan')); return __calls.find(c => c.k === 'nearSetLan').a[0] === false`],
  ['nearby: search a town and share it', `go('nearby'); await until(() => q('#n-place')); const i = q('#n-place'); i.value = 'evry'; i.dispatchEvent(new Event('input')); await until(() => qa('#n-places button').length); qa('#n-places button')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await until(() => called('nearSetArea')); const a = __calls.find(c => c.k === 'nearSetArea').a[0]; return a.place === 'Évry, FR' && a.radius === 25 && a.source === 'typed'`],
  ['nearby: LOCATE ME shares the PC\'s town', `go('nearby'); await until(() => q('#n-locate')); click(q('#n-locate')); await until(() => called('nearLocate')); await wait(300); return q('#n-areastat').textContent.includes('from this PC')`],
  ['nearby: LOCATE ME failure explains what to do', `window.__locateFails = true; go('nearby'); await until(() => q('#n-locate')); click(q('#n-locate')); await until(() => q('#n-locerr') && q('#n-locerr').textContent); return q('#n-locerr').textContent.includes('Privacy') && !!q('#n-place')`],
  ['nearby: hide me from Nearby', `go('nearby'); await until(() => q('#n-hide')); click(q('#n-hide')); await until(() => called('nearSetHidden')); await wait(300); return __calls.find(c => c.k === 'nearSetHidden').a[0] === true && q('#n-head').textContent === 'HIDDEN' && !q('#n-people .nprow')`],
  ['nearby: radius chip re-shares with the new radius', `go('nearby'); await until(() => q('.rchip')); click([...qa('.rchip')].find(b => b.dataset.r === '50')); await until(() => called('nearSetArea')); return __calls.find(c => c.k === 'nearSetArea').a[0].radius === 50`],
  ['nearby: stop sharing area', `go('nearby'); await until(() => q('#n-areaoff')); click(q('#n-areaoff')); await until(() => called('nearSetArea')); return __calls.find(c => c.k === 'nearSetArea').a[0] === null`],
  ['nearby: follow someone nearby', `go('nearby'); await until(() => q('#n-people [data-a=follow]')); click(q('#n-people [data-a=follow]')); await until(() => called('follow')); return called('follow')`],
  ['nearby: name opens their profile', `go('nearby'); await until(() => q('#n-people .who')); click(q('#n-people .who')); await until(() => called('profilePage')); return called('profilePage')`],
  ['nav: every view opens without errors', `for (const v of ['discover','nearby','notifs','saved','settings','feed']) { go(v); await wait(250) } return __errs.length === 0 || __errs.join(' | ')`],
  // ---------- notifications ----------
  ['notifs: DM notification opens that conversation', `go('notifs'); await wait(400); const r = [...qa('.nrow, .notif, .notifrow')].find(x => x.textContent.includes('encrypted message')); if (!r) return 'no dm notif row'; click(r); await wait(600); return (IR_ACTIVE === DEMO.MIRA || DM_ACTIVE === DEMO.MIRA)`],
  ['notifs: reply notification focuses the post', `go('notifs'); await wait(400); const r = [...qa('.nrow, .notif, .notifrow')].find(x => x.textContent.includes('replied')); if (!r) return 'no reply notif row'; click(r); await wait(1500); const f = q('.card.focus'); return !!f && f.dataset.seq === '31' && f.querySelector('.thread').classList.contains('open')`],
  // ---------- stories / settings ----------
  ['stories: open a story', `const s = [...qa('.story')].find(x => x.textContent.includes('Mira')); click(s); await until(() => called('getStory')); return called('getStory')`],
  ['settings: toggling a setting saves it', `go('settings'); await wait(500); const sw = q('.switch, .sw, [id^=s-]'); if (!sw) return 'no switch'; click(sw); await until(() => called('setSettings')); return called('setSettings')`],
  ['dm view: opening a conversation focuses the message box', `await openDm(DEMO.MIRA); await wait(300); return document.activeElement === q('#dmtext')`],
  ['image viewer: Esc closes it', `click(q('.card .postimg[data-media]')); await wait(400); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(100); return !q('#lightbox').classList.contains('open')`],
  ['image viewer: clicking outside closes it', `click(q('.card .postimg[data-media]')); await wait(400); q('#lightbox').dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(100); return !q('#lightbox').classList.contains('open')`],
  ['image viewer: shows the full image the engine returned', `const t = q('.card .postimg[data-media]'); const [a, sq] = t.dataset.media.split(':'); click(t); await until(() => called('getMedia')); await wait(400); const full = await window.ember.getMedia(a, +sq); return q('#lbImg').getAttribute('src') === full && !q('#lbImg').classList.contains('loading') && q('#lbImg').naturalWidth > 0`],
  ['image viewer: click toggles zoom', `click(q('.card .postimg[data-media]')); await wait(400); click(q('#lbImg')); return q('#lbStage').classList.contains('zoom')`],
  ['image viewer: second open is instant (cached)', `const t = q('.card .postimg[data-media]'); click(t); await wait(400); q('#lbClose').click(); const n = __calls.filter(c => c.k === 'getMedia').length; click(t); await wait(200); return __calls.filter(c => c.k === 'getMedia').length === n`],
  ['image viewer: thumb-only image (no full media) still opens', `const p = [...qa('.card .postimg')].find(i => !i.dataset.media && !i.closest('.vidwrap')); if (!p) return true; click(p); await wait(200); return q('#lightbox').classList.contains('open')`],
  ['video thumbnail opens the player, not the image viewer', `click(q('.vidwrap .postimg')); await wait(500); return !q('#lightbox').classList.contains('open')`],
]
