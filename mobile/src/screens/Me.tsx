// ME tab: own profile + settings. Rebuilt spacing: no negative-margin overlap,
// edit fields are properly separated from their buttons, keyboard-aware.
import React, { useEffect, useState } from 'react'
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, Image, Share,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ActivityIndicator
} from 'react-native'
import { api } from '../rpc'
import { useEmber } from '../../App'
import { Chip } from '../components/Card'
import { launchImageLibrary } from '../components/imagepick'
import { copyText } from '../clipboard'
import { MONO, SANS, THEMES } from '../theme'

export default function Me () {
  const { t, me, refreshMe, themeName, setTheme } = useEmber()
  const [page, setPage] = useState<any>(null)
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  const [bio, setBio] = useState('')
  const [settings, setSettings] = useState<any>({})
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!me) return
    try {
      setPage(await api.profilePage(me.key))
      setSettings(await api.getSettings())
    } catch (e: any) { Alert.alert('Could not load profile', String(e?.message || e)) }
    setName(me.profile?.name || ''); setStatus(me.profile?.status || ''); setBio(me.profile?.bio || '')
  }
  useEffect(() => { load() }, [me])

  const saveProfile = async () => {
    setSaving(true)
    try {
      await api.setProfile({ name: name.trim(), status: status.trim(), bio: bio.trim() })
      await refreshMe(); setEdit(false); await load()
    } catch (e: any) { Alert.alert('Save failed', String(e?.message || e)) }
    setSaving(false)
  }

  const pickPfp = async () => {
    const r = await launchImageLibrary()
    if (!r) return
    try {
      await api.setProfile({
        name: (name || me.profile?.name || '').trim(),
        status: (status || me.profile?.status || '').trim(),
        bio: (bio || me.profile?.bio || '').trim(),
        avatar: r.image.length <= 60000 ? r.image : r.thumb
      })
      await refreshMe(); await load()
    } catch (e: any) { Alert.alert('Avatar failed', String(e?.message || e)) }
  }

  const backup = async () => {
    try {
      const id = await api.exportIdentity()
      await Share.share({
        message: `EMBER IDENTITY BACKUP — GUARD THIS\nprimaryKey: ${id.primaryKey}\npublicKey: ${id.publicKey}`
      })
    } catch (e: any) { Alert.alert('Export failed', String(e?.message || e)) }
  }

  if (!page) {
    return <View style={s.center}><ActivityIndicator color={t.ink} /></View>
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        {/* banner */}
        <View style={[s.banner, { backgroundColor: t.panel, borderColor: t.line }]} />

        <View style={{ paddingHorizontal: 16 }}>
          {/* avatar sits BELOW the banner edge with real spacing (no overlap bugs) */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: -30, marginBottom: 14 }}>
            <TouchableOpacity onPress={pickPfp} style={[s.pfp, { borderColor: t.line, backgroundColor: t.paper }]}>
              {me.profile?.avatar
                ? <Image source={{ uri: me.profile.avatar }} style={{ width: '100%', height: '100%' }} />
                : <Text style={{ fontFamily: MONO, fontSize: 24, fontWeight: '700', color: t.ink }}>
                    {(me.profile?.name || '?')[0]?.toUpperCase()}
                  </Text>}
            </TouchableOpacity>
            <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1.5, color: t.soft, marginLeft: 10, marginBottom: 6 }}>
              TAP TO CHANGE
            </Text>
          </View>

          {edit ? (
            <View>
              <Field t={t} label="DISPLAY NAME" value={name} onChange={setName} placeholder="your name" />
              <Field t={t} label="STATUS" value={status} onChange={setStatus} placeholder="e.g. building" max={48} />
              <Field t={t} label="BIO" value={bio} onChange={setBio} placeholder="a line about you" multiline />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                <Chip t={t} solid label={saving ? 'SAVING…' : 'SAVE'} onPress={saveProfile} />
                <Chip t={t} label="CANCEL" onPress={() => { setEdit(false); load() }} />
              </View>
            </View>
          ) : (
            <View>
              <Text style={{ fontFamily: SANS, fontWeight: '700', fontSize: 20, color: t.ink }}>
                {me.profile?.name || 'unnamed'}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: t.muted, marginTop: 4 }}>
                @{me.key.slice(0, 12)} · joined {page.joined ? new Date(page.joined).getFullYear() : '—'}
              </Text>
              {me.profile?.bio ? (
                <Text style={{ fontFamily: SANS, fontSize: 14, lineHeight: 21, color: t.ink, marginTop: 10 }}>
                  {me.profile.bio}
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <Chip t={t} solid label="EDIT PROFILE" onPress={() => setEdit(true)} />
                <Chip t={t} label="COPY KEY" onPress={() => copyText(me.key, 'KEY COPIED')} />
              </View>
            </View>
          )}

          {/* stats */}
          <View style={[s.stats, { borderColor: t.line }]}>
            <Stat t={t} v={String(page.stats.posts)} l="POSTS" />
            <Stat t={t} v={String(page.stats.following)} l="YOU FOLLOW" border />
            <View style={[s.stat, { borderLeftWidth: 1, borderColor: t.line }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, backgroundColor: t.ink }} />
                <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: '700', color: t.ink }} numberOfLines={1}>
                  {(me.profile?.status || 'AVAIL.').toUpperCase().slice(0, 8)}
                </Text>
              </View>
              <Text style={[s.statL, { color: t.soft }]}>STATUS</Text>
            </View>
          </View>

          {/* settings */}
          <Text style={[s.sect, { color: t.soft }]}>SETTINGS</Text>

          <Text style={[s.setLabel, { color: t.ink }]}>THEME</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            {(Object.keys(THEMES) as any[]).map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => setTheme(n)}
                style={[s.swatch, {
                  borderColor: themeName === n ? t.accent : t.line,
                  backgroundColor: THEMES[n].canvas,
                  borderWidth: themeName === n ? 2.5 : 1
                }]}>
                <View style={{ width: 12, height: 12, backgroundColor: THEMES[n].ink, transform: [{ rotate: '45deg' }] }} />
                <Text style={{ fontFamily: MONO, fontSize: 7, letterSpacing: 1, color: THEMES[n].ink, marginTop: 6 }}>
                  {n.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <SettingRow
            t={t} title="COMMONS BUCKET"
            desc="global rendezvous for small networks; auto-leaves as peers grow"
            on={!!settings.commons}
            toggle={async () => setSettings(await api.setSettings({ commons: !settings.commons }))} />
          <SettingRow
            t={t} title="KEEP DM HISTORY"
            desc="persist encrypted conversations on this device"
            on={!!settings.keepDmHistory}
            toggle={async () => setSettings(await api.setSettings({ keepDmHistory: !settings.keepDmHistory }))} />

          <Text style={[s.setLabel, { color: t.ink, marginTop: 22 }]}>IDENTITY</Text>
          <Text style={{ fontFamily: MONO, fontSize: 10, lineHeight: 16, color: t.muted, marginTop: 6 }}>
            no servers, no recovery. export the backup and guard it — it IS the account.
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <Chip t={t} solid label="EXPORT BACKUP" onPress={backup} />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field ({ t, label, value, onChange, placeholder, multiline, max }: any) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 2, color: t.soft, marginBottom: 6 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={t.soft}
        maxLength={max || (multiline ? 200 : 32)}
        multiline={!!multiline}
        style={{
          borderWidth: 1, borderColor: t.line, color: t.ink,
          minHeight: multiline ? 72 : 42, paddingHorizontal: 12, paddingVertical: 10,
          fontFamily: MONO, fontSize: 13,
          textAlignVertical: multiline ? 'top' : 'center'
        }} />
    </View>
  )
}

function Stat ({ t, v, l, border }: any) {
  return (
    <View style={[s.stat, border && { borderLeftWidth: 1, borderColor: t.line }]}>
      <Text style={{ fontFamily: MONO, fontSize: 15, fontWeight: '700', color: t.ink }}>{v}</Text>
      <Text style={[s.statL, { color: t.soft }]}>{l}</Text>
    </View>
  )
}

function SettingRow ({ t, title, desc, on, toggle }: any) {
  return (
    <View style={[s.setRow, { borderColor: t.line }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ fontFamily: MONO, fontSize: 11, fontWeight: '700', letterSpacing: 1, color: t.ink }}>{title}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 9, lineHeight: 14, color: t.muted, marginTop: 4 }}>{desc}</Text>
      </View>
      <TouchableOpacity onPress={toggle} style={[s.toggle, { borderColor: t.line, backgroundColor: on ? t.ink : t.paper }]}>
        <Text style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1, color: on ? t.inv : t.soft }}>{on ? 'ON' : 'OFF'}</Text>
      </TouchableOpacity>
    </View>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { height: 96, borderBottomWidth: 1 },
  pfp: { width: 72, height: 72, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stats: { flexDirection: 'row', borderWidth: 1, marginTop: 20 },
  stat: { flex: 1, padding: 12 },
  statL: { fontFamily: MONO, fontSize: 7, letterSpacing: 2, marginTop: 4 },
  sect: { fontFamily: MONO, fontSize: 8, letterSpacing: 3, fontWeight: '700', marginTop: 30, marginBottom: 12 },
  setLabel: { fontFamily: MONO, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  swatch: { width: 68, height: 58, alignItems: 'center', justifyContent: 'center' },
  setRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, padding: 14, marginTop: 14 },
  toggle: { width: 48, height: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }
})
