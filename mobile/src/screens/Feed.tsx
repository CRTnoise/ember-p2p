import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, RefreshControl, TouchableOpacity, StyleSheet } from 'react-native'
import { api, engine } from '../rpc'
import { useEmber } from '../../App'
import Card from '../components/Card'
import StoryRail from '../components/StoryRail'
import ComposeSheet from '../components/ComposeSheet'
import ProfileSheet from './Profile'
import { MONO } from '../theme'

const dayLabel = (ts: number) => {
  const d = new Date(ts), now = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, now)) return 'TODAY'
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (same(d, y)) return 'YESTERDAY'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toUpperCase()
}

export default function Feed () {
  const { t } = useEmber()
  const [data, setData] = useState<any>({ items: [], profiles: {}, replyCounts: {} })
  const [savedIds, setSavedIds] = useState(new Set<string>())
  const [pending, setPending] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [storyCompose, setStoryCompose] = useState(false)
  const [profileKey, setProfileKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const tl = await api.timeline()
      const sl = await api.savedList()
      setSavedIds(new Set(sl.map((a: any) => a.author + ':' + a.seq)))
      setData(tl); setPending(0)
    } catch (e: any) { console.warn('timeline failed', e?.message) }
  }, [])

  useEffect(() => {
    load()
    // Blocks stream in from peers after the first paint: refresh quietly while
    // still syncing, and only show the pill once the feed is settled.
    // While syncing, blocks arrive in bursts. Refresh at MOST every 4s, and
    // never more than once per burst, otherwise the list rebuilds constantly.
    let t: any = null
    let lastLoad = Date.now()
    const off = engine.on('feed-updated', () => {
      clearTimeout(t)
      t = setTimeout(() => {
        setData((d: any) => {
          if (d?.sync?.syncing) {
            if (Date.now() - lastLoad > 4000) { lastLoad = Date.now(); load() }
          } else setPending(p => p + 1)
          return d
        })
      }, 1200)
    })
    return () => { clearTimeout(t); off() }
  }, [])

  // day-grouped rows
  const rows: any[] = []
  let last: string | null = null
  for (const it of data.items) {
    const d = dayLabel(it.ts)
    if (d !== last) { rows.push({ sep: d, key: 'sep-' + d }); last = d }
    rows.push({ it, key: it.author + ':' + it.seq })
  }

  return (
    <View style={{ flex: 1 }}>
      {pending > 0 && (
        <TouchableOpacity style={[s.pill, { backgroundColor: t.ink }]} onPress={load}>
          <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: t.inv }}>↻ {pending} NEW — RELOAD</Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={rows}
        keyExtractor={r => r.key}
        ListHeaderComponent={<>
          <StoryRail onAdd={() => setStoryCompose(true)} />
          {data?.sync?.syncing && (
            <View style={[s.syncbar, { borderColor: t.line, backgroundColor: t.panel }]}>
              <Text style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: t.muted }}>
                ◈ SYNCING {data.sync.held}/{data.sync.known} BLOCKS · {data.peers || 0} PEER{(data.peers || 0) === 1 ? '' : 'S'} · {data.seeders || 0} SEEDING YOU
              </Text>
            </View>
          )}
        </>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor={t.ink} />}
        renderItem={({ item }) => item.sep
          ? <View style={s.sep}><View style={[s.sepLine, { backgroundColor: t.line }]} />
              <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 3, color: t.soft }}>{item.sep}</Text>
              <View style={[s.sepLine, { backgroundColor: t.line }]} /></View>
          : <Card it={item.it} profiles={data.profiles} replyCounts={data.replyCounts}
              savedIds={savedIds} onChanged={load} onProfile={setProfileKey} />}
        ListEmptyComponent={<Text style={[s.empty, { color: t.muted }]}>nothing yet — post something, follow a key, or check DISCOVER</Text>}
        contentContainerStyle={{ paddingBottom: 20 }}
      />
      {storyCompose && <ComposeSheet story onClose={() => setStoryCompose(false)} />}
      {profileKey && <ProfileSheet k={profileKey} onClose={() => setProfileKey(null)} />}
    </View>
  )
}
const s = StyleSheet.create({
  pill: { position: 'absolute', top: 10, alignSelf: 'center', zIndex: 10, paddingHorizontal: 14, paddingVertical: 8, elevation: 4 },
  sep: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  sepLine: { flex: 1, height: 1, opacity: 0.3 },
  empty: { fontFamily: MONO, fontSize: 11, lineHeight: 18, padding: 30 },
  syncbar: { borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 9 }
})
