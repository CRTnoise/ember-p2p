# Third-party notices

Ember's own source code is licensed GPL-3.0-or-later (see [LICENSE](LICENSE)). Its
dependencies are MIT or Apache-2.0, with one exception that matters when you
**distribute built binaries**:

## FFmpeg (desktop builds only)
The desktop app depends on [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static),
which ships a prebuilt FFmpeg executable licensed **GPL-3.0-or-later** (it
includes libx264). Desktop builds bundle that executable, unpacked from the
asar archive, and run it as a separate process to transcode videos you post.

Ember runs FFmpeg as a separate program and is itself GPL. Anyone
distributing a desktop build (an `.exe`, an AppImage, a download on any
store) is distributing a GPL program alongside it, and must:
- ship FFmpeg's license text with the build (`ffmpeg-static` includes it next
  to the binary, which the build config keeps unpacked), and
- make the corresponding FFmpeg source available, e.g. by linking the exact
  source release for the bundled build in the release notes.

Running Ember from source (`npm start`) involves no distribution and no
obligations. Mobile builds don't include FFmpeg.

## Everything else
Holepunch stack (`hypercore`, `corestore`, `hyperswarm`): MIT ·
`sodium-universal`: MIT · `b4a`, `react-native-bare-kit`, `bare-*`: Apache-2.0 ·
Electron, React Native: MIT.
