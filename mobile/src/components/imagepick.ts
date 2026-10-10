// image pick + resize helper.
// V1: expects react-native-image-picker to be installed by you:
//   npm install react-native-image-picker
// includeBase64 gives us the data; we cap dimensions via the picker options
// (on-device canvas-style resizing can come later with react-native-image-resizer).
export async function launchImageLibrary (): Promise<{ image: string, thumb: string } | null> {
  try {
    const { launchImageLibrary: pick } = require('react-native-image-picker')
    const res = await pick({ mediaType: 'photo', includeBase64: true, maxWidth: 900, maxHeight: 900, quality: 0.7 })
    const a = res?.assets?.[0]
    if (!a?.base64) return null
    const image = `data:${a.type || 'image/jpeg'};base64,${a.base64}`
    // thumb: re-pick small — picker can't double-process; ship the same image
    // as thumb if small enough, else skip thumb (gossip cap 20KB)
    const thumb = image.length <= 19000 ? image : ''
    return { image, thumb }
  } catch { return null }
}
