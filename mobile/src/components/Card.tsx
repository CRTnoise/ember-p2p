// src/components/Card.tsx — the sectioned post card, mobile edition
import React, { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, Image, TextInput, StyleSheet, Alert, ActivityIndicator } from 'react-native'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { MONO, SANS } from '../theme'
import { copyText } from '../clipboard'
import ImageViewer from './ImageViewer'

const ago = (ts: number) => {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

// markdown subset render → array of styled Text spans
export function md (text: string, base: any) {
  const parts: any[] = []
  let rest = text || ''
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/
  let key = 0
  while (rest.length) {
    const m = rest.match(re)
    if (!m || m.index === undefined) { parts.push(<Text key={key++}>{rest}</Text>); break }
    if (m.index > 0) parts.push(<Text key={key++}>{rest.slice(0, m.index)}</Text>)
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<Text key={key++} style={{ fontWeight: '700' }}>{tok.slice(2, -2)}</Text>)
    else if (tok.startsWith('~~')) parts.push(<Text key={key++} style={{ textDecorationLine: 'line-through', opacity: 0.65 }}>{tok.slice(2, -2)}</Text>)
    else if (tok.startsWith('`')) parts.push(<Text key={key++} style={{ fontFamily: MONO, fontSize: 13 }}>{tok.slice(1, -1)}</Text>)
    else parts.push(<Text key={key++} style={{ fontStyle: 'italic' }}>{tok.slice(1, -1)}</Text>)
    rest = rest.slice(m.index + tok.length)
  }
  return <Text style={base}>{parts}</Text>
}

export function Avatar ({ k, profiles, size = 34, onPress }: any) {
  const { t, me } = useEmber()
  const mine = me && k === me.key
  const p = mine ? me.profile : profiles?.[k]
  return (
    <TouchableOpacity onPress={onPress} style={{
      width: size, height: size, borderRadius: size / 2, borderWidth: 1.5,
      borderColor: t.line, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
      backgroundColor: mine ? t.ink : t.paper
    }}>
      {p?.avatar
        ? <Image source={{ uri: p.avatar }} style={{ width: '100%', height: '100%' }} />
        : <Text style={{ fontFamily: MONO, fontWeight: '700', color: mine ? t.inv : t.ink, fontSize: size * 0.4 }}>
            {((p?.name || k || '?')[0] || '?').toUpperCase()}
          </Text>}
    </TouchableOpacity>
  )
}

function CardBase ({ it, profiles, replyCounts, savedIds, discover, onProfile, onChanged }: any) {
  const { t, me, openDm } = useEmber()
  const mine = me && it.author === me.key
  const name = mine ? (me.profile?.name || 'you') : (profiles?.[it.author]?.name || it.author.slice(0, 8))
  const id = it.author + ':' + it.seq
  const rc = replyCounts?.[id] || 0
  const isSaved = savedIds?.has(id)
  const [menu, setMenu] = useState(false)
  const [thread, setThread] = useState(false)
  const [repliesList, setReplies] = useState<any[]>([])
  const [replyText, setReplyText] = useState('')
  const [viewer, setViewer] = useState(false)
  const [followed, setFollowed] = useState(false)
  const [quoted, setQuoted] = useState<any>(null)

  useEffect(() => {
    if ((it.type === 'quote' || it.kind === 'quote') && it.ref) api.resolveBlock(it.ref.author, it.ref.seq).then(setQuoted)
    if (it.type === 'repost' && it.ref) api.resolveBlock(it.ref.author, it.ref.seq).then(setQuoted)
  }, [])

  const loadThread = async () => {
    setThread(!thread)
    if (!thread) setReplies(await api.getReplies(it.author, it.seq))
  }
  const sendReply = async () => {
    if (!replyText.trim()) return
    await api.reply(it.author, it.seq, replyText.trim())
    setReplyText('')
    setReplies(await api.getReplies(it.author, it.seq))
  }
  const toggleSave = async () => {
    if (isSaved) { await api.unsavePost(it.author, it.seq); savedIds.delete(id) }
    else { try { await api.savePost(it.author, it.seq); savedIds.add(id) } catch { Alert.alert('Cannot resolve post') } }
    onChanged?.()
  }

  const status = (mine ? me.profile?.status : profiles?.[it.author]?.status) || ''

  return (
    <View style={[s.card, { backgroundColor: t.paper, borderColor: t.line, shadowColor: '#000' }]}>
      {/* head */}
      <View style={[s.head, { borderColor: t.line }]}>
        <Avatar k={it.author} profiles={profiles} onPress={() => onProfile?.(it.author)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 14, color: t.ink }} numberOfLines={1}>{name}</Text>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginTop: 2 }}>
            @{it.author.slice(0, 8)} · {ago(it.ts)}{it.trust === 'unsigned' || it.unverified ? ' · UNVERIFIED' : ''}
          </Text>
        </View>
        {discover && it.score != null
          ? <View style={{ backgroundColor: t.ink, paddingHorizontal: 6, paddingVertical: 4 }}>
              <Text style={{ fontFamily: MONO, fontSize: 8, color: t.inv, letterSpacing: 1 }}>PROX {(it.score * 100 | 0)}%</Text>
            </View>
          : status ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 7, height: 7, backgroundColor: t.ink }} />
              <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1.5, color: t.muted }}>{status.toUpperCase().slice(0, 10)}</Text>
            </View> : null}
        <TouchableOpacity onPress={() => setMenu(!menu)} style={{ padding: 4 }}>
          <Text style={{ fontFamily: MONO, fontWeight: '700', color: t.muted }}>···</Text>
        </TouchableOpacity>
      </View>

      {menu && (
        <View style={[s.menu, { backgroundColor: t.paper, borderColor: t.line }]}>
          {mine ? (
            <>
              <MenuBtn t={t} label="✕ DELETE" danger onPress={() => {
                setMenu(false)
                Alert.alert('Delete post?', 'It disappears from the network and your device. Only saved copies survive.', [
                  { text: 'Cancel' },
                  { text: 'Delete', style: 'destructive', onPress: async () => { await api.deletePost(it.seq); onChanged?.() } }
                ])
              }} />
            </>
          ) : (
            <>
              <MenuBtn t={t} label="✉ DM" onPress={() => { setMenu(false); openDm(it.author) }} />
              <MenuBtn t={t} label="◍ PROFILE" onPress={() => { setMenu(false); onProfile?.(it.author) }} />
              <MenuBtn t={t} label="COPY KEY" onPress={() => { setMenu(false); copyText(it.author, 'KEY COPIED') }} />
              <MenuBtn t={t} label="MUTE" onPress={async () => { setMenu(false); await api.mute(it.author); onChanged?.() }} />
              <MenuBtn t={t} label="BLOCK" danger onPress={async () => { setMenu(false); await api.block(it.author); onChanged?.() }} />
            </>
          )}
        </View>
      )}

      {/* body */}
      {it.type === 'repost'
        ? <View style={s.bodyWrap}><Text style={{ fontFamily: MONO, fontSize: 13, color: t.muted }}>↻ reposted</Text></View>
        : it.text ? <View style={s.bodyWrap}>{md(it.text, { fontFamily: SANS, fontSize: 15, lineHeight: 22, color: t.ink })}</View> : null}

      {quoted && (
        <View style={[s.quote, { borderColor: t.line }]}>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginBottom: 4 }}>
            @{(quoted.author || '').slice(0, 8)} · {ago(quoted.ts)}{quoted.unverified ? ' · UNVERIFIED' : ''}
          </Text>
          <Text style={{ fontFamily: SANS, fontSize: 13, color: t.ink }} numberOfLines={4}>{quoted.text}</Text>
        </View>
      )}

      {/* media */}
      {(it.mediaSeq != null || it.thumb) && (
        <>
        <TouchableOpacity activeOpacity={0.9} onPress={() => setViewer(true)}>
          {it.thumb
            ? <Image source={{ uri: it.thumb }} style={[s.media, { borderColor: t.line }]} resizeMode="cover" />
            : <View style={[s.media, s.mediaEmpty, { borderColor: t.line, backgroundColor: t.panel }]}>
                <Text style={{ fontFamily: MONO, fontSize: 9, color: t.soft }}>IMAGE · TAP TO VIEW</Text>
              </View>}
          <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1.5, color: t.soft, paddingHorizontal: 16, paddingTop: 6 }}>TAP TO VIEW</Text>
        </TouchableOpacity>
        <ImageViewer visible={viewer} onClose={() => setViewer(false)} src={it.thumb} title={name}
          media={it.mediaSeq != null ? { author: it.author, seq: it.mediaSeq } : null} />
        </>
      )}

      {/* actions */}
      <View style={[s.actions, { borderColor: t.line }]}>
        <Chip t={t} label={`◈ ${rc || 'REPLY'}`} onPress={loadThread} />
        {it.type !== 'repost' && !mine && (
          <Chip t={t} label="↻ REPOST" onPress={async () => {
            try { await api.repost(it.author, it.seq); onChanged?.() }
            catch (e: any) { Alert.alert('Repost failed', String(e?.message || e)) }
          }} />
        )}
        {discover && !mine && (
          <Chip
            t={t}
            solid={followed}
            label={followed ? '✓ FOLLOWING' : '+ FOLLOW'}
            onPress={async () => {
              try {
                await api.follow(it.author)
                setFollowed(true)
                onChanged?.()
              } catch (e: any) { Alert.alert('Follow failed', String(e?.message || e)) }
            }} />
        )}
        <View style={{ flex: 1 }} />
        {!mine && (
          <TouchableOpacity onPress={toggleSave} style={[s.save, { borderColor: t.line, backgroundColor: isSaved ? t.ink : t.paper }]}>
            <Text style={{ fontFamily: MONO, color: isSaved ? t.inv : t.ink }}>{isSaved ? '◆' : '◇'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* thread */}
      {thread && (
        <View style={[s.thread, { borderColor: t.line }]}>
          {repliesList.map((r, i) => (
            <View key={i} style={[s.reply, { borderColor: t.line }]}>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginBottom: 3 }}>@{r.author.slice(0, 8)} · {ago(r.ts)}</Text>
              <Text style={{ fontFamily: SANS, fontSize: 13, color: t.ink }}>{r.text}</Text>
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={replyText} onChangeText={setReplyText} placeholder="reply…" placeholderTextColor={t.soft}
              style={[s.replyInput, { borderColor: t.line, color: t.ink }]} onSubmitEditing={sendReply} />
            <Chip t={t} solid label="SEND" onPress={sendReply} />
          </View>
        </View>
      )}
    </View>
  )
}

// Memoized: without this every incoming block re-rendered the entire feed,
// which is a large part of what felt like lag on device.
const Card = React.memo(CardBase, (a, b) =>
  a.it.author === b.it.author &&
  a.it.seq === b.it.seq &&
  a.it.ts === b.it.ts &&
  a.profiles?.[a.it.author]?.name === b.profiles?.[b.it.author]?.name &&
  a.replyCounts?.[a.it.author + ':' + a.it.seq] === b.replyCounts?.[b.it.author + ':' + b.it.seq] &&
  a.savedIds?.has(a.it.author + ':' + a.it.seq) === b.savedIds?.has(b.it.author + ':' + b.it.seq)
)
export default Card

export function Chip ({ t, label, onPress, solid }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={{
      borderWidth: 1, borderColor: t.line, paddingHorizontal: 10, height: 28,
      justifyContent: 'center', backgroundColor: solid ? t.ink : t.paper
    }}>
      <Text style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: solid ? t.inv : t.ink }}>{label}</Text>
    </TouchableOpacity>
  )
}

function MenuBtn ({ t, label, onPress, danger }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={{ paddingHorizontal: 14, paddingVertical: 11 }}>
      <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.5, color: danger ? t.accent : t.ink }}>{label}</Text>
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  card: { borderWidth: 1, marginHorizontal: 14, marginBottom: 16, elevation: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: 1 },
  menu: { position: 'absolute', right: 8, top: 46, zIndex: 20, borderWidth: 1, elevation: 6, minWidth: 140 },
  bodyWrap: { padding: 14 },
  quote: { borderWidth: 1, marginHorizontal: 14, marginBottom: 12, padding: 10 },
  media: { width: '100%', height: 240, borderTopWidth: 1 },
  mediaEmpty: { alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, borderTopWidth: 1, marginTop: 10 },
  save: { width: 28, height: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  thread: { marginHorizontal: 14, marginBottom: 12, borderLeftWidth: 2, paddingLeft: 10, gap: 8 },
  reply: { borderWidth: 1, padding: 9 },
  replyInput: { flex: 1, borderWidth: 1, height: 32, paddingHorizontal: 9, fontFamily: MONO, fontSize: 12 }
})
