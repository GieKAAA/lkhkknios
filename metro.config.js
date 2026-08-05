// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// @tensorflow/tfjs-react-native loads model weight shards (.bin) via
// require(), so Metro needs to treat them as a bundled asset instead of
// trying to parse them as source.
config.resolver.assetExts.push("bin");

// react-native-fast-tflite loads the .tflite model via require() too.
config.resolver.assetExts.push("tflite");

// @tensorflow/tfjs-react-native statically require()s "react-native-fs" as a
// fallback for reading bundled models off the filesystem in standalone
// builds. We never hit that path in Expo Go (assets load over Metro's dev
// HTTP server instead), but Metro still needs to resolve the require() at
// bundle time. Point it at a no-op stub instead of installing the real
// (native-module) package - see stubs/react-native-fs.js.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "react-native-fs": path.resolve(__dirname, "stubs/react-native-fs.js"),
};

module.exports = config;
