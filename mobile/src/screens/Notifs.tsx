// notification center modal (opened from the top-bar ◈)
import React, { useEffect, useState } from 'react'
import { View, Text, FlatList, TouchableOpacity, Modal, StyleSheet } from 'react-native'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { MONO, SANS } from '../theme'

const ago = (ts: number) => {
  const s = (Date.now() - ts) / 1000
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
const glyph: any = { reply: '◈', dm: '✉', post: '▤' }
const label: any = { reply: 'REPLIED', dm: 'MESSAGED YOU', post: 'POSTED' }

export default function Notifs ({ onClose }: any) {
  const { t, openDm } = useEmber()
  const [list, setList] = useState<any[]>([])
  useEffect(() => { api.notifsList().then(setList) }, [])
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[s.wrap, { backgroundColor: t.canvas }]}>
        <View style={[s.head, { borderColor: t.line, backgroundColor: t.paper }]}>
          <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, fontWeight: '700', color: t.ink }}>◈ NOTIFICATIONS</Text>
          <TouchableOpacity onPress={onClose}><Text style={{ fontFamily: MONO, fontSize: 16, color: t.muted }}>×</Text></TouchableOpacity>
        </View>
        <FlatList
          data={list}
          keyExtractor={n => n.id}
          renderItem={({ item: n }) => (
            <TouchableOpacity style={[s.row, { borderColor: t.line, backgroundColor: n.read ? t.paper : t.panel }]}
              onPress={() => { if (n.type === 'dm') { onClose(); openDm(n.from) } }}>
              <Text style={{ fontFamily: MONO, fontSize: 14, color: t.ink }}>{glyph[n.type] || '◇'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: MONO, fontSize: 10, color: t.ink }}>
                  @{(n.from || '').slice(0, 8)} <Text style={{ color: t.muted }}>{label[n.type] || n.type}</Text>
                </Text>
                {n.text ? <Text style={{ fontFamily: SANS, fontSize: 12, color: t.muted, marginTop: 3 }} numberOfLines={2}>{n.text}</Text> : null}
              </View>
              <Text style={{ fontFamily: MONO, fontSize: 9, color: t.soft }}>{ago(n.ts)}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={{ fontFamily: MONO, fontSize: 11, padding: 30, color: t.muted }}>silence — for now.</Text>}
        />
      </View>
    </Modal>
  )
}
const s = StyleSheet.create({
  wrap: { flex: 1, marginTop: 60, borderTopWidth: 1 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1 },
  row: { flexDirection: 'row', gap: 11, padding: 13, borderBottomWidth: 1, alignItems: 'flex-start' }
})
