import React, { useEffect, useState } from 'react'
import { View, TextInput, FlatList, Text, StyleSheet } from 'react-native'
import { api, engine } from '../rpc'
import { useEmber } from '../../App'
import Card from '../components/Card'
import ProfileSheet from './Profile'
import { MONO } from '../theme'

export default function Discover () {
  const { t } = useEmber()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<any>({ items: [] })
  const [profileKey, setProfileKey] = useState<string | null>(null)
  const savedIds = new Set<string>()

  const search = async (query: string) => setRes(await api.discover(query))
  useEffect(() => {
    search('')
    const off = engine.on('discover-updated', () => { if (!q) search('') })
    return off
  }, [])
  useEffect(() => { const h = setTimeout(() => search(q), 350); return () => clearTimeout(h) }, [q])

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12, borderBottomWidth: 1, borderColor: t.line, backgroundColor: t.paper }}>
        <TextInput value={q} onChangeText={setQ}
          placeholder="search by meaning — enters matching buckets"
          placeholderTextColor={t.soft}
          style={{ borderWidth: 1, borderColor: t.line, height: 36, paddingHorizontal: 10, fontFamily: MONO, fontSize: 12, color: t.ink }} />
      </View>
      <FlatList
        data={res.items}
        keyExtractor={(it: any) => it.author + ':' + it.seq}
        ListHeaderComponent={<Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 3, color: t.soft, padding: 14 }}>
          {q ? `NEAREST TO “${q.toUpperCase().slice(0, 30)}”` : 'DRIFTING THROUGH YOUR BUCKETS'}</Text>}
        renderItem={({ item }) => <Card it={{ ...item, type: item.kind === 'quote' ? 'quote' : 'post' }} profiles={res.profiles || {}} replyCounts={{}}
          savedIds={savedIds} discover onChanged={() => search(q)} onProfile={setProfileKey} />}
        ListEmptyComponent={<Text style={{ fontFamily: MONO, fontSize: 11, lineHeight: 18, padding: 30, color: t.muted }}>
          no strangers in your buckets yet — the more you post, the more meaning-space you occupy.</Text>}
        contentContainerStyle={{ paddingBottom: 20 }}
      />
      {profileKey && <ProfileSheet k={profileKey} onClose={() => setProfileKey(null)} />}
    </View>
  )
}
