// documents dir shim — bare worklet needs a writable path.
// RN doesn't expose one without a lib; use the app's files dir via
// react-native's built-in — simplest zero-dep approach: hardcode Android path
// pattern resolved at runtime by the worklet arg. If you add react-native-fs
// later, replace this with RNFS.DocumentDirectoryPath.
import { Platform } from 'react-native'
export default {
  documents: Platform.OS === 'android'
    ? '/data/data/com.embermobile/files'   // adjust to your applicationId
    : '/tmp/ember'
}
