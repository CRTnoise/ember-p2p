// mockup 2: message list rows (avatar · name · preview · time/unread), thread view
import React, { useEffect, useState, useRef } from 'react'
import { View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, Image, KeyboardAvoidingView, Platform, Alert } from 'react-native'
import { api, engine } from '../rpc'
import { useEmber } from '../../App'
import { Avatar, Chip } from '../components/Card'
import ImageViewer from '../components/ImageViewer'
import { MONO, SANS } from '../theme'

const ago = (ts: number) => {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

export default function Inbox () {
  const { t, me, dmThread, setDmThread } = useEmber()
  const [convos, setConvos] = useState<any[]>([])
  const [msgs, setMsgs] = useState<any[]>([])
  const [text, setText] = useState('')
  const [view, setView] = useState<string | null>(null)
  const listRef = useRef<any>(null)

  const load = async () => setConvos(await api.dmList())
  const openThread = async (k: string) => { setDmThread(k); setMsgs(await api.dmOpen(k)) }

  useEffect(() => {
    load()
    const off = engine.on('dm-received', async (k: string) => { load(); if (k === dmThread) setMsgs(await api.dmOpen(k)) })
    return off
  }, [dmThread])
  useEffect(() => { if (dmThread) openThread(dmThread) }, [])

  const send = async () => {
    if (!text.trim() || !dmThread) return
    const body = text.trim()
    setText('')
    try {
      const r = await api.dmSend(dmThread, body)
      setMsgs(await api.dmOpen(dmThread))
      if (r && r.sent === false && r.reason === 'no-key') {
        Alert.alert('No key yet', "Their profile hasn't reached you, so there's nothing to encrypt to. It'll send once their feed syncs.")
      }
    } catch (e: any) {
      setText(body)
      Alert.alert('Send failed', String(e?.message || e))
    }
  }

  const peer = (() => { const c = convos.find(x => x.key === dmThread); return { name: c ? c.name : '', avatar: c ? c.avatar : undefined } })()

  if (dmThread) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.threadHead, { borderColor: t.line, backgroundColor: t.paper }]}>
          <TouchableOpacity onPress={() => setDmThread(null)}><Text style={{ fontFamily: MONO, fontSize: 14, color: t.ink }}>←</Text></TouchableOpacity>
          <Avatar k={dmThread} profiles={{ [dmThread]: peer }} size={30} />
          <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 13, color: t.ink }}>{peer.name || '@' + dmThread.slice(0, 12)}</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1, color: t.soft }}>E2E · crypto_box</Text>
        </View>
        <FlatList
          ref={listRef} data={msgs} keyExtractor={(_, i) => String(i)}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            const mine = item.from === me.key
            return (
              <View style={[s.bubble, { borderColor: t.line, backgroundColor: mine ? t.ink : t.paper, alignSelf: mine ? 'flex-end' : 'flex-start' }]}>
                {item.kind === 'i'
                  ? <TouchableOpacity onPress={() => setView(item.text)}><Image source={{ uri: item.text }} style={{ width: 200, height: 200 }} resizeMode="cover" /></TouchableOpacity>
                  : item.kind === 'v'
                    ? <Text style={{ fontFamily: MONO, fontSize: 12, color: mine ? t.inv : t.ink }}>♪ voice message (desktop only for now)</Text>
                    : <Text style={{ fontFamily: SANS, fontSize: 14, color: mine ? t.inv : t.ink }}>{item.text}</Text>}
                <Text style={{ fontFamily: MONO, fontSize: 8, color: mine ? t.inv : t.soft, opacity: 0.7, marginTop: 4 }}>
                  {ago(item.ts)}{item.delivered === false ? ' · QUEUED — DELIVERS WHEN THEY APPEAR' : ''}
                </Text>
              </View>
            )
          }}
          contentContainerStyle={{ padding: 14, gap: 8 }}
        />
        <View style={[s.composer, { borderColor: t.line, backgroundColor: t.paper }]}>
          <TextInput value={text} onChangeText={setText} placeholder="encrypted message…" placeholderTextColor={t.soft} autoFocus
            style={[s.input, { borderColor: t.line, color: t.ink }]} onSubmitEditing={send} />
          <Chip t={t} solid label="SEND" onPress={send} />
        </View>
        <ImageViewer visible={!!view} onClose={() => setView(null)} src={view} title={peer.name || 'image'} />
      </KeyboardAvoidingView>
    )
  }

  const requests = convos.filter(c => c.request)
  const normal = convos.filter(c => !c.request)
  return (
    <FlatList
      data={normal}
      keyExtractor={c => c.key}
      ListHeaderComponent={<>
        <Text style={[s.header, { color: t.soft, backgroundColor: t.paper, borderColor: t.line }]}>MESSAGES</Text>
        {requests.map(c => (
          <View key={c.key} style={[s.row, { borderColor: t.line, backgroundColor: t.panel }]}>
            <Avatar k={c.key} profiles={{ [c.key]: { name: c.name, avatar: c.avatar } }} size={38} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 13, color: t.ink }}>{c.name || '@' + c.key.slice(0, 10)}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginTop: 2 }}>request · wants to message you</Text>
            </View>
            <Chip t={t} solid label="ACCEPT" onPress={async () => { await api.dmAccept(c.key); load() }} />
            <Chip t={t} label="IGNORE" onPress={async () => { await api.dmIgnore(c.key); load() }} />
          </View>
        ))}
      </>}
      renderItem={({ item: c }) => (
        <TouchableOpacity style={[s.row, { borderColor: t.line, backgroundColor: t.paper }]} onPress={() => openThread(c.key)}>
          <Avatar k={c.key} profiles={{ [c.key]: { name: c.name, avatar: c.avatar } }} size={38} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 13, color: t.ink }}>{c.name || '@' + c.key.slice(0, 10)}</Text>
            <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginTop: 2 }} numberOfLines={1}>
              {c.last ? (c.last.from === me.key ? 'you: ' : '') + (c.last.kind === 'i' ? '[image]' : c.last.kind === 'v' ? '[voice]' : c.last.text) : ''}
            </Text>
          </View>
          <Text style={{ fontFamily: MONO, fontSize: 9, color: t.soft }}>{c.last ? ago(c.last.ts) : ''}</Text>
        </TouchableOpacity>
      )}
      ListEmptyComponent={requests.length === 0 ? <Text style={{ fontFamily: MONO, fontSize: 11, lineHeight: 18, padding: 30, color: t.muted }}>
        no conversations — DM someone from their post's ··· menu</Text> : null}
    />
  )
}
const s = StyleSheet.create({
  header: { fontFamily: MONO, fontSize: 8, letterSpacing: 3, paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderBottomWidth: 1 },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: 1 },
  bubble: { borderWidth: 1, padding: 10, maxWidth: '82%' },
  composer: { flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, height: 34, paddingHorizontal: 10, fontFamily: MONO, fontSize: 12 }
})
