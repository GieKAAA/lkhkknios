// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// react-native-fast-tflite loads mobilefacenet.tflite via require(), so Metro
// has to treat it as a bundled asset instead of parsing it as source.
config.resolver.assetExts.push("tflite");

module.exports = config;
