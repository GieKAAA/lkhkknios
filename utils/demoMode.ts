import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Toggle to test attendance/camera/location features outside the real KKN
 * period and outside the posko geofence (see the "Demo" button in
 * ProfileScreen). Bypasses the KKN period + geofence gates in LKHScreen -
 * face verification itself stays real (not loosened), so the actual
 * detection/matching pipeline is still genuinely exercised. Attendance
 * records created while this is active are tagged `isDemo` (LKHScreen's
 * LKHRecord) and are never sent to the real /api/simpan-lkh endpoint.
 */
const DEMO_MODE_KEY = "@demo_mode";

export async function isDemoModeActive(): Promise<boolean> {
  return (await AsyncStorage.getItem(DEMO_MODE_KEY)) === "1";
}

export async function setDemoMode(active: boolean): Promise<void> {
  if (active) {
    await AsyncStorage.setItem(DEMO_MODE_KEY, "1");
  } else {
    await AsyncStorage.removeItem(DEMO_MODE_KEY);
  }
}
