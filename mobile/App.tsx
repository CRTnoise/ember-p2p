// App.tsx — Ember Mobile shell
// Top bar: ◇ EMBER | [+ post] [◈ notifs] [avatar] — per the mockups + desktop features.
// Bottom tabs: FEED · DISCOVER · INBOX · ME (settings live on ME).
import React, { useEffect, useState, createContext, useContext } from 'react'
import { View, Text, TouchableOpacity, StatusBar, StyleSheet, Image } from 'react-native'
import { engine, api } from './src/rpc'
import { THEMES, ThemeName, MONO } from './src/theme'
import FeedScreen from './src/screens/Feed'
import DiscoverScreen from './src/screens/Discover'
import InboxScreen from './src/screens/Inbox'
import MeScreen from './src/screens/Me'
import NotifsScreen from './src/screens/Notifs'
import ComposeSheet from './src/components/ComposeSheet'

export const Ctx = createContext<any>(null)
export const useEmber = () => useContext(Ctx)

export default function App () {
  const [booted, setBooted] = useState(false)
  const [themeName, setThemeName] = useState<ThemeName>('paper')
  const [tab, setTab] = useState('feed')
  const [me, setMe] = useState<any>(null)
  const [unread, setUnread] = useState({ total: 0, dm: 0, post: 0, reply: 0 })
  const [composeOpen, setComposeOpen] = useState(false)
  const [notifsOpen, setNotifsOpen] = useState(false)
  const [dmThread, setDmThread] = useState<string | null>(null)
  const [engineErr, setEngineErr] = useState<string | null>(null)
  const t = THEMES[themeName]

  useEffect(() => {
    (async () => {
      await engine.start()
      const off1 = engine.on('engine-ready', async () => {
        setBooted(true)
        setMe(await api.me())
        const s = await api.getSettings()
        if (s.theme && THEMES[s.theme as ThemeName]) setThemeName(s.theme)
      })
      const off2 = engine.on('notif', async () => setUnread(await api.notifsUnread()))
      const off3 = engine.on('engine-error', (msg: string) => setEngineErr(String(msg).slice(0, 300)))
      return () => { off1(); off2(); off3() }
    })()
  }, [])

  const refreshMe = async () => setMe(await api.me())
  const setTheme = async (n: ThemeName) => { setThemeName(n); await api.setSettings({ theme: n }) }

  const ctx = { t, themeName, setTheme, me, refreshMe, unread, setUnread, tab, setTab, openDm: (k: string) => { setTab('inbox'); setDmThread(k) }, dmThread, setDmThread }

  if (!booted) {
    return (
      <View style={[s.boot, { backgroundColor: THEMES.paper.canvas }]}>
        <View style={s.mark} />
        <Text style={s.bootTxt}>◆ JOINING THE SWARM…</Text>
      </View>
    )
  }

  return (
    <Ctx.Provider value={ctx}>
      <View style={{ flex: 1, backgroundColor: t.canvas }}>
        <StatusBar barStyle={themeName === 'paper' ? 'dark-content' : 'light-content'} backgroundColor={t.canvas} />
        {/* ---- top bar ---- */}
        <View style={[s.top, { backgroundColor: t.paper, borderColor: t.line }]}>
          <TouchableOpacity style={s.logo} onPress={() => setTab('feed')}>
            <View style={[s.logoMark, { borderColor: t.ink }]} />
            <Text style={[s.logoWord, { color: t.ink }]}>EMBER</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={[s.topBtn, { borderColor: t.line, backgroundColor: t.ink }]} onPress={() => setComposeOpen(true)}>
            <Text style={{ color: t.inv, fontFamily: MONO, fontSize: 15 }}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.topBtn, { borderColor: t.line }]} onPress={() => setNotifsOpen(true)}>
            <Text style={{ color: t.ink, fontFamily: MONO, fontSize: 13 }}>◈</Text>
            {unread.total > 0 && <View style={[s.dot, { backgroundColor: t.accent }]} />}
          </TouchableOpacity>
          <TouchableOpacity style={[s.avatar, { borderColor: t.line }]} onPress={() => setTab('me')}>
            {me?.profile?.avatar
              ? <Image source={{ uri: me.profile.avatar }} style={{ width: '100%', height: '100%' }} />
              : <Text style={{ color: t.ink, fontFamily: MONO, fontWeight: '700' }}>{(me?.profile?.name || '?')[0]?.toUpperCase()}</Text>}
          </TouchableOpacity>
        </View>

        {engineErr && (
          <TouchableOpacity onPress={() => setEngineErr(null)}
            style={{ backgroundColor: t.accent, paddingHorizontal: 14, paddingVertical: 8 }}>
            <Text style={{ fontFamily: MONO, fontSize: 9, color: t.inv }}>ENGINE: {engineErr} (tap to dismiss)</Text>
          </TouchableOpacity>
        )}

        {/* ---- active screen ---- */}
        <View style={{ flex: 1 }}>
          {tab === 'feed' && <FeedScreen />}
          {tab === 'discover' && <DiscoverScreen />}
          {tab === 'inbox' && <InboxScreen />}
          {tab === 'me' && <MeScreen />}
        </View>

        {/* ---- bottom tabs ---- */}
        <View style={[s.tabs, { backgroundColor: t.paper, borderColor: t.line }]}>
          {[
            { id: 'feed', ic: '☰', lb: 'FEED', badge: unread.post },
            { id: 'discover', ic: '◎', lb: 'DISCOVER', badge: 0 },
            { id: 'inbox', ic: '✉', lb: 'INBOX', badge: unread.dm },
            { id: 'me', ic: '◍', lb: 'ME', badge: 0 }
          ].map(x => (
            <TouchableOpacity key={x.id} style={s.tabBtn} onPress={() => { setTab(x.id); setDmThread(null) }}>
              <Text style={{ fontFamily: MONO, fontSize: 17, color: tab === x.id ? t.ink : t.soft }}>{x.ic}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 2, color: tab === x.id ? t.ink : t.soft, marginTop: 2 }}>{x.lb}</Text>
              {x.badge > 0 && <View style={[s.dot, { backgroundColor: t.accent, top: 2, right: '28%' }]} />}
            </TouchableOpacity>
          ))}
        </View>

        {composeOpen && <ComposeSheet onClose={() => setComposeOpen(false)} />}
        {notifsOpen && <NotifsScreen onClose={() => { setNotifsOpen(false); api.notifsMarkRead(null).then(async () => setUnread(await api.notifsUnread())) }} />}
      </View>
    </Ctx.Provider>
  )
}

const s = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 },
  mark: { width: 26, height: 26, borderWidth: 3, borderColor: '#000', transform: [{ rotate: '45deg' }] },
  bootTxt: { fontFamily: MONO, fontSize: 11, letterSpacing: 3, color: '#605c55' },
  top: { height: 52, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoMark: { width: 14, height: 14, borderWidth: 2, transform: [{ rotate: '45deg' }] },
  logoWord: { fontFamily: MONO, fontWeight: '700', fontSize: 14, letterSpacing: 4 },
  topBtn: { width: 32, height: 32, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 32, height: 32, borderWidth: 1.5, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: -3, right: -3, width: 8, height: 8 },
  tabs: { height: 58, borderTopWidth: 1, flexDirection: 'row' },
  tabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})
