// Copy helper: uses the community clipboard if installed, falls back to RN's
// deprecated Clipboard, then to the share sheet. Never throws.
import { Share, Alert } from 'react-native'

export async function copyText (value: string, label = 'Copied') {
  try {
    const mod = require('@react-native-clipboard/clipboard')
    const Clipboard = mod.default || mod
    Clipboard.setString(value)
    Alert.alert(label)
    return true
  } catch {}
  try {
    const { Clipboard } = require('react-native')
    if (Clipboard && Clipboard.setString) { Clipboard.setString(value); Alert.alert(label); return true }
  } catch {}
  try { await Share.share({ message: value }); return true } catch {}
  Alert.alert('Copy failed', value)
  return false
}
