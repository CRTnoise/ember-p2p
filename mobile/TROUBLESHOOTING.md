# Troubleshooting — every wall we actually hit

| Symptom | Real cause | Fix |
|---|---|---|
| `Unsupported class file major version 70` (or 66, 67…) | Gradle 8.x can't run on a JDK newer than 21; 70 = Java 26 | Install JDK 17. Set `org.gradle.java.home=C:\\Program Files\\...\\jdk-17...` in `android/gradle.properties` (double backslashes). Then `gradlew --stop`. |
| `Could not move temporary workspace … dependencies-accessors` on every build (Windows) | Gradle 8.6 bug on Windows; cache wipes don't help | Use the Gradle **8.5** wrapper (`configure-android.js` does this). |
| `bare-pack: UNKNOWN_FLAG: target` | bare-pack 2.x has no `--target` | `bare-pack --preset android --out src/engine.bundle.mjs worklet/backend.mjs` (`npm run bundle:engine`). Keep the `.bundle.mjs` extension: it selects the ESM output format. |
| `TurboModuleRegistry.getEnforcing(...): 'BareKit' could not be found`, with `Bridgeless mode: false` | bare-kit is a C++ TurboModule; the old architecture never registers it | `newArchEnabled=true` |
| Same error with `Bridgeless mode: true`, and `npx react-native config` shows `"android": null` for react-native-bare-kit | RN CLI 13's autolinking only recognises a package class that says `implements ReactPackage`; bare-kit's `extends BaseReactPackage` is skipped, so its C++ module is dropped and the generated `rncli.cpp` is empty | The included patch (`patches/react-native-bare-kit+0.15.0.patch`, applied by `patch-package`). Then delete `android/app/build` and rebuild. |
| `Property 'Buffer' doesn't exist` | React Native has no Node globals | `index.js` installs the `buffer` polyfill before importing the app. |
| Stuck on "JOINING THE SWARM", no error | Engine can't create its data directory | `src/fsdir.ts` path must match your `applicationId`. |
| `rpc timeout: timeline` / feed shows only a few posts | (fixed) reads used to wait on blocks not yet replicated | Engine reads local blocks only; the rest stream in. A `SYNCING n/m` bar shows progress. |
| Engine change "did nothing" | The worklet runs the bundled snapshot | `npm run bundle:engine`, then reload. |

Windows tip: exclude the project folder and `%USERPROFILE%\.gradle` from
Defender real-time scanning. It roughly halves build times.
