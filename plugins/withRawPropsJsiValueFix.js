const { withDangerousMod, withXcodeProject, withAppDelegate } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const HEADER_NAME = "RNRawPropsJsiValueFix.h";
const IMPL_NAME = "RNRawPropsJsiValueFix.mm";

// react-native-vision-camera's PreviewView passes props through as raw
// jsi::Value under Fabric, but the `useRawPropsJsiValue` native feature flag
// defaults to false, so RN tries to cast them as folly::dynamic instead and
// crashes with: "Exception in HostFunction: PreviewView.previewOutput:
// Cannot cast dynamic to a jsi::Value type." This flag can only be flipped
// from native code (no JS/Info.plist override exists), so we call
// ReactNativeFeatureFlags::override(...) before RN starts up.
const HEADER_CONTENT = `#ifndef RNRawPropsJsiValueFix_h
#define RNRawPropsJsiValueFix_h

#ifdef __cplusplus
extern "C" {
#endif

void RNEnableRawPropsJsiValueFlag(void);

#ifdef __cplusplus
}
#endif

#endif /* RNRawPropsJsiValueFix_h */
`;

// RCTReactNativeFactory's own init already calls
// ReactNativeFeatureFlags::override(...) once (to turn on bridgeless/Fabric/
// TurboModules), and override() throws ("cannot be overridden more than
// once") if called a second time - so we can't just call override()
// ourselves before/after it. dangerouslyForceOverride() replaces the whole
// flag set instead of layering on top, so our provider must also carry the
// same 5 flags RN's own OSS "Stable" override sets, or Fabric/bridgeless
// would silently turn back off.
const IMPL_CONTENT = `#import "RNRawPropsJsiValueFix.h"
#import <react/featureflags/ReactNativeFeatureFlags.h>
#import <react/featureflags/ReactNativeFeatureFlagsDefaults.h>
#import <memory>

namespace {
class RNRawPropsJsiValueFlags : public facebook::react::ReactNativeFeatureFlagsDefaults {
 public:
  bool enableBridgelessArchitecture() override {
    return true;
  }
  bool enableFabricRenderer() override {
    return true;
  }
  bool useTurboModules() override {
    return true;
  }
  bool useNativeViewConfigsInBridgelessMode() override {
    return true;
  }
  bool useShadowNodeStateOnClone() override {
    return true;
  }
  bool useRawPropsJsiValue() override {
    return true;
  }
};
} // namespace

void RNEnableRawPropsJsiValueFlag(void) {
  facebook::react::ReactNativeFeatureFlags::dangerouslyForceOverride(
      std::make_unique<RNRawPropsJsiValueFlags>());
}
`;

function withRawPropsJsiValueFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const projectName = config.modRequest.projectName;
      const iosDir = path.join(projectRoot, "ios", projectName);
      fs.writeFileSync(path.join(iosDir, HEADER_NAME), HEADER_CONTENT);
      fs.writeFileSync(path.join(iosDir, IMPL_NAME), IMPL_CONTENT);
      return config;
    },
  ]);
}

function withRawPropsJsiValueXcodeProject(config) {
  return withXcodeProject(config, (config) => {
    const xcodeProject = config.modResults;
    const projectName = config.modRequest.projectName;
    const group = xcodeProject.pbxGroupByName(projectName);
    const groupKey = xcodeProject.findPBXGroupKey({
      name: group.name,
      path: group.path,
    });

    xcodeProject.addHeaderFile(`${projectName}/${HEADER_NAME}`, null, groupKey);
    xcodeProject.addSourceFile(`${projectName}/${IMPL_NAME}`, null, groupKey);

    xcodeProject.addBuildProperty(
      "SWIFT_OBJC_BRIDGING_HEADER",
      `"${projectName}/${HEADER_NAME}"`
    );

    return config;
  });
}

function withRawPropsJsiValueAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    const contents = config.modResults.contents;
    if (!contents.includes("RNEnableRawPropsJsiValueFlag()")) {
      // Must run AFTER `...ReactNativeFactory(delegate: ...)` is
      // constructed (that's what triggers RN's own one-time feature-flag
      // override), not before it - see the comment above IMPL_CONTENT.
      config.modResults.contents = contents.replace(
        /(.*ReactNativeFactory\(delegate:.*\n)/,
        `$1    RNEnableRawPropsJsiValueFlag()\n`
      );
    }
    return config;
  });
}

module.exports = function withRawPropsJsiValueFix(config) {
  config = withRawPropsJsiValueFiles(config);
  config = withRawPropsJsiValueXcodeProject(config);
  config = withRawPropsJsiValueAppDelegate(config);
  return config;
};
