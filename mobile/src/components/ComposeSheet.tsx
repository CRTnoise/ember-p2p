// Compose sheet — keyboard-safe. POST lives in the HEADER so it can never be
// pushed under the keyboard, which was the "post sinks to the bottom" bug.
import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, Image, Modal, StyleSheet, Alert,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator
} from 'react-native'
import { launchImageLibrary } from './imagepick'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { Chip } from './Card'
import { MONO } from '../theme'

export default function ComposeSheet ({ onClose, story }: any) {
  const { t } = useEmber()
  const [text, setText] = useState('')
  const [img, setImg] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [asStory, setAsStory] = useState(!!story)

  const pick = async () => {
    const r = await launchImageLibrary()
    if (r) setImg(r)
    else Alert.alert('No image', 'Nothing was selected, or the picker is unavailable.')
  }

  const post = async () => {
    if (busy) return
    if (!text.trim() && !img) { Alert.alert('Nothing to post', 'Write something or attach an image.'); return }
    setBusy(true)
    try {
      if (asStory) {
        if (!img) { Alert.alert('Stories need an image'); setBusy(false); return }
        await api.postStory(img.image, text.trim().slice(0, 140))
      } else {
        await api.post(text.trim(), img?.image || null, img?.thumb || null)
      }
      onClose(true)
    } catch (e: any) {
      Alert.alert('Post failed', String(e?.message || e))
    }
    setBusy(false)
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => onClose(false)}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => onClose(false)} />
        <View style={[s.box, { backgroundColor: t.paper, borderColor: t.line }]}>

          {/* header: close · title · POST (always visible, never under keyboard) */}
          <View style={[s.head, { borderColor: t.line }]}>
            <TouchableOpacity onPress={() => onClose(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ fontFamily: MONO, fontSize: 18, color: t.muted }}>×</Text>
            </TouchableOpacity>
            <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: t.ink, fontWeight: '700' }}>
              {asStory ? 'NEW STORY · 24H' : 'NEW POST'}
            </Text>
            <TouchableOpacity
              onPress={post}
              disabled={busy}
              style={[s.postBtn, { backgroundColor: busy ? t.panel : t.ink, borderColor: t.line }]}>
              {busy
                ? <ActivityIndicator size="small" color={t.ink} />
                : <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: t.inv }}>POST</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 300 }}>
            <TextInput
              multiline
              value={text}
              onChangeText={setText}
              maxLength={560}
              autoFocus
              placeholder={asStory ? 'caption (optional)…' : 'say something to the swarm…'}
              placeholderTextColor={t.soft}
              style={[s.input, { borderColor: t.line, color: t.ink }]} />
            {img && (
              <View style={{ marginTop: 12 }}>
                <Image source={{ uri: img.image }} style={{ width: '100%', height: 200, borderWidth: 1, borderColor: t.line }} resizeMode="cover" />
                <TouchableOpacity onPress={() => setImg(null)} style={{ paddingVertical: 8 }}>
                  <Text style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: t.accent }}>× REMOVE IMAGE</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>

          <View style={s.row}>
            <Chip t={t} label="◲ IMAGE" onPress={pick} />
            <Chip t={t} label={asStory ? '▤ AS POST' : '◈ AS STORY'} onPress={() => setAsStory(!asStory)} />
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: MONO, fontSize: 10, color: text.length > 520 ? t.accent : t.soft }}>
              {text.length}/560
            </Text>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  box: { borderTopWidth: 1, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 16 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottomWidth: 1 },
  postBtn: { borderWidth: 1, paddingHorizontal: 14, height: 30, alignItems: 'center', justifyContent: 'center', minWidth: 62 },
  input: { borderWidth: 1, minHeight: 100, padding: 10, marginTop: 12, fontFamily: MONO, fontSize: 13, textAlignVertical: 'top' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }
})
