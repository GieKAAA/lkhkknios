// Stub for the "react-native-fs" native module.
//
// @tensorflow/tfjs-react-native's bundleResourceIO statically requires this
// package as a fallback for reading bundled model files straight off the
// filesystem. That fallback only runs in standalone/release builds; when
// running through Expo Go or `expo start` (dev mode), Metro serves bundled
// assets over HTTP instead, so this code path is never actually reached.
//
// react-native-fs is a native module that would require a custom dev
// client/EAS build to install for real, which defeats the point of staying
// on Expo Go. This stub exists only so Metro's static bundler can resolve
// the require() call; see metro.config.js for the alias that points here.
function unsupported() {
  throw new Error(
    "react-native-fs is stubbed out in this project (see stubs/react-native-fs.js) " +
      "and does not support reading files. This should only be reachable from a " +
      "standalone/release build, not Expo Go.",
  );
}

module.exports = {
  readFile: unsupported,
  readFileRes: unsupported,
};
