// other-user profile sheet — mockup 3: banner, avatar, FOLLOW/MESSAGE, stats, posts
import React, { useEffect, useState } from 'react'
import { View, Text, FlatList, TouchableOpacity, Modal, Image, StyleSheet, Alert } from 'react-native'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { Chip, Avatar } from '../components/Card'
import Card from '../components/Card'
import { MONO, SANS } from '../theme'

export default function ProfileSheet ({ k, onClose }: any) {
  const { t, me, openDm } = useEmber()
  const [page, setPage] = useState<any>(null)
  const load = () => api.profilePage(k).then(setPage)
  useEffect(() => { load() }, [k])
  const savedIds = new Set<string>()

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[s.wrap, { backgroundColor: t.canvas, borderColor: t.line }]}>
        <View style={[s.head, { borderColor: t.line, backgroundColor: t.paper }]}>
          <TouchableOpacity onPress={onClose}><Text style={{ fontFamily: MONO, fontSize: 14, color: t.ink }}>←</Text></TouchableOpacity>
          <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: t.soft }}>PROFILE</Text>
          <View style={{ width: 20 }} />
        </View>
        {!page ? <Text style={{ fontFamily: MONO, padding: 30, color: t.soft }}>resolving from the swarm…</Text> : (
          <FlatList
            data={page.posts}
            keyExtractor={(it: any) => it.author + ':' + it.seq}
            ListHeaderComponent={
              <View>
                <View style={[s.banner, { backgroundColor: t.panel, borderColor: t.line }]} />
                <View style={{ paddingHorizontal: 16, marginTop: -30 }}>
                  <Avatar k={k} profiles={{ [k]: page.profile }} size={62} />
                  <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 18, color: t.ink, marginTop: 8 }}>
                    {page.profile?.name || 'unnamed peer'}
                  </Text>
                  <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginTop: 3 }}>
                    @{k.slice(0, 12)} · joined {page.joined ? new Date(page.joined).getFullYear() : '—'}
                  </Text>
                  {page.profile?.bio ? <Text style={{ fontFamily: SANS, fontSize: 14, lineHeight: 20, color: t.ink, marginTop: 8 }}>{page.profile.bio}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <Chip t={t} solid={!page.isFollowed} label={page.isFollowed ? '✓ FOLLOWING' : 'FOLLOW'}
                      onPress={async () => {
                        try {
                          if (page.isFollowed) await api.unfollow(k); else await api.follow(k)
                          setPage({ ...page, isFollowed: !page.isFollowed })   // instant feedback
                          load()
                        } catch (e: any) { Alert.alert('Failed', String(e?.message || e)) }
                      }} />
                    <Chip t={t} label="MESSAGE" onPress={() => { onClose(); openDm(k) }} />
                  </View>
                  <View style={[s.stats, { borderColor: t.line }]}>
                    <View style={s.stat}><Text style={[s.statV, { color: t.ink }]}>{page.stats.posts}</Text><Text style={[s.statL, { color: t.soft }]}>POSTS</Text></View>
                    <View style={[s.stat, { borderLeftWidth: 1, borderColor: t.line }]}>
                      <Text style={[s.statV, { color: t.ink }]}>{page.stats.blocks}</Text><Text style={[s.statL, { color: t.soft }]}>BLOCKS IN LOG</Text>
                    </View>
                    <View style={[s.stat, { borderLeftWidth: 1, borderColor: t.line }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <View style={{ width: 7, height: 7, backgroundColor: t.ink }} />
                        <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: '700', color: t.ink }}>
                          {(page.profile?.status || '—').toUpperCase().slice(0, 8)}
                        </Text>
                      </View>
                      <Text style={[s.statL, { color: t.soft }]}>STATUS</Text>
                    </View>
                  </View>
                  <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 3, color: t.soft, marginTop: 18, marginBottom: 10 }}>POSTS</Text>
                </View>
              </View>
            }
            renderItem={({ item }) => <Card it={item} profiles={{ [k]: page.profile }} replyCounts={{}} savedIds={savedIds} onChanged={load} onProfile={() => {}} />}
            contentContainerStyle={{ paddingBottom: 24 }}
          />
        )}
      </View>
    </Modal>
  )
}
const s = StyleSheet.create({
  wrap: { flex: 1, marginTop: 46, borderTopWidth: 1 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderBottomWidth: 1 },
  banner: { height: 80, borderBottomWidth: 1 },
  stats: { flexDirection: 'row', borderWidth: 1, marginTop: 14 },
  stat: { flex: 1, padding: 10 },
  statV: { fontFamily: MONO, fontSize: 14, fontWeight: '700' },
  statL: { fontFamily: MONO, fontSize: 7, letterSpacing: 1.5, marginTop: 3 }
})
