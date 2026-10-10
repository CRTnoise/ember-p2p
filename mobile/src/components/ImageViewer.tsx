// Full-screen image viewer: shows the whole image (contain, never cropped).
// Opens instantly with the preview, then swaps in the full image if one exists.
import React, { useEffect, useState } from 'react'
import { Modal, View, Text, Image, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native'
import { api } from '../rpc'
import { MONO } from '../theme'

const FULL = new Map<string, string>()   // 'author:seq' -> full image, so reopening is instant

export default function ImageViewer ({ visible, onClose, src, title, media }: {
  visible: boolean, onClose: () => void, src?: string | null, title?: string, media?: { author: string, seq: number } | null
}) {
  const { width, height } = useWindowDimensions()
  const key = media ? media.author + ':' + media.seq : ''
  const [uri, setUri] = useState<string | null | undefined>(src)
  const [state, setState] = useState<'idle' | 'loading' | 'full' | 'none'>('idle')

  useEffect(() => {
    if (!visible) return
    if (!media) { setUri(src); setState('idle'); return }
    if (FULL.has(key)) { setUri(FULL.get(key)); setState('full'); return }
    setUri(src); setState('loading')
    let alive = true
    api.getMedia(media.author, media.seq)
      .then((full: string | null) => { if (!alive) return; if (full) { FULL.set(key, full); setUri(full); setState('full') } else setState('none') })
      .catch(() => alive && setState('none'))
    return () => { alive = false }
  }, [visible, key, src])

  const foot = state === 'loading' ? 'PULLING THE FULL IMAGE FROM WHOEVER HOLDS IT…'
    : state === 'full' ? 'FULL IMAGE · YOU SEED IT NOW · TAP TO CLOSE'
    : state === 'none' ? 'NO HOLDER ONLINE · SHOWING THE PREVIEW'
    : 'TAP TO CLOSE'

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.head}>
          <Text style={s.title} numberOfLines={1}>{(title || 'IMAGE').toUpperCase()}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={s.close}>×</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity activeOpacity={1} onPress={onClose} style={s.stage}>
          {uri ? <Image source={{ uri }} style={{ width, height: height - 140, opacity: state === 'loading' ? 0.6 : 1 }} resizeMode="contain" /> : null}
          {state === 'loading' && <ActivityIndicator style={StyleSheet.absoluteFill} size="large" color="#fff" />}
        </TouchableOpacity>
        <Text style={s.foot}>{foot}</Text>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  head: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderColor: '#333' },
  title: { fontFamily: MONO, fontSize: 11, letterSpacing: 2.5, color: '#fff', fontWeight: '700', flex: 1, marginRight: 12 },
  close: { fontFamily: MONO, fontSize: 24, color: '#fff' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  foot: { fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: '#aaa', textAlign: 'center', paddingVertical: 14, borderTopWidth: 1, borderColor: '#333' }
})
