// horizontal story rail: + YOURS first (or your story w/ long-press ADD), then others
import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, Image, Modal, StyleSheet } from 'react-native'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { Avatar } from './Card'
import { MONO } from '../theme'

export default function StoryRail ({ onAdd }: any) {
  const { t, me } = useEmber()
  const [groups, setGroups] = useState<any[]>([])
  const [viewer, setViewer] = useState<any>(null)
  const [idx, setIdx] = useState(0)
  const [img, setImg] = useState<any>(null)

  const load = () => api.stories().then(setGroups)
  useEffect(() => { load(); const iv = setInterval(load, 60000); return () => clearInterval(iv) }, [])

  const open = async (g: any, i = 0) => {
    setViewer(g); setIdx(i); setImg(null)
    const st = g.stories[i]
    setImg(await api.getStory(st.author, st.seq))
  }
  const next = () => {
    if (!viewer) return
    if (idx + 1 >= viewer.stories.length) { setViewer(null); return }
    open(viewer, idx + 1)
  }

  const mine = groups.find(g => g.self)
  return (
    <View style={{ borderBottomWidth: 1, borderColor: t.line, backgroundColor: t.paper }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12, gap: 14 }}>
        <TouchableOpacity style={s.tile} onPress={() => mine ? open(mine) : onAdd()} onLongPress={onAdd}>
          {mine
            ? <View style={[s.ring, { borderColor: t.accent }]}><Avatar k={me.key} profiles={{}} size={48} onPress={() => open(mine)} /></View>
            : <View style={[s.ring, s.dashed, { borderColor: t.soft }]}><Text style={{ fontFamily: MONO, fontSize: 20, color: t.soft }}>+</Text></View>}
          <Text style={[s.name, { color: t.muted }]}>{mine ? 'you · hold to add' : 'yours'}</Text>
        </TouchableOpacity>
        {groups.filter(g => !g.self).map(g => (
          <TouchableOpacity key={g.author} style={s.tile} onPress={() => open(g)}>
            <View style={[s.ring, { borderColor: t.accent }]}><Avatar k={g.author} profiles={{ [g.author]: { name: g.name, avatar: g.avatar } }} size={48} /></View>
            <Text style={[s.name, { color: t.muted }]} numberOfLines={1}>{g.name || g.author.slice(0, 8)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={next}>
          <View style={[s.frame, { backgroundColor: t.paper, borderColor: t.line }]}>
            <View style={{ flexDirection: 'row', gap: 4, padding: 10 }}>
              {viewer?.stories.map((_: any, i: number) => (
                <View key={i} style={{ flex: 1, height: 3, backgroundColor: i <= idx ? t.ink : t.panel }} />
              ))}
            </View>
            {img
              ? <Image source={{ uri: img.data }} style={{ width: '100%', height: 420 }} resizeMode="contain" />
              : <View style={{ height: 420, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontFamily: MONO, color: t.soft }}>loading from holders…</Text>
                </View>}
            {img?.caption ? <Text style={{ fontFamily: MONO, fontSize: 12, color: t.ink, padding: 12 }}>{img.caption}</Text> : null}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  )
}

const s = StyleSheet.create({
  tile: { alignItems: 'center', width: 60 },
  ring: { width: 54, height: 54, borderRadius: 27, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dashed: { borderStyle: 'dashed' },
  name: { fontFamily: MONO, fontSize: 8, letterSpacing: 0.5, marginTop: 5 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  frame: { width: '100%', borderWidth: 1 }
})
