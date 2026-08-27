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

/**
 * Placeholder auth token written by startDemoSession() so the app's
 * "logged in?" check (@user_token exists) passes without ever contacting
 * the server. Any request sent with it simply gets a 401 from the server,
 * which every caller already treats as "keep local data" - and records
 * captured during the session are tagged `isDemo` anyway, so they are
 * never synced.
 */
export const DEMO_TOKEN = "demo-token-lokal";

/**
 * Dummy profile shown on LKH/Profile screens during a demo session. Fields
 * mirror the shape LoginScreen stores after a real /api/peserta response.
 */
const DEMO_PROFILE = {
  nim: "DEMO",
  nama: "Peserta Demo",
  foto: "",
  tglLahir: "",
  prodi: "[Mode Demo] Prodi",
  fakultas: "[Mode Demo] Fakultas",
  tahunMasuk: "",
  angkatan: "",
  kecamatan: "",
  kabupaten: "",
  poskoKoordinat: null,
  angkatanTanggalMulai: null,
  angkatanTanggalSelesai: null,
  settingTanggalMulai: null,
  settingTanggalSelesai: null,
};

/**
 * Full demo login, for when the student no longer has an active account on
 * the LKH server (account is tied to the KKN period - once their angkatan's
 * term ends the login endpoint permanently returns "invalid credentials").
 * Sets a local-only token + dummy profile and turns demo mode ON, so all
 * period/geofence gates open and nothing can reach the real API. Ended by
 * logging out (ProfileScreen clears @demo_mode along with the session).
 */
export async function startDemoSession(): Promise<void> {
  await AsyncStorage.setItem("@user_token", DEMO_TOKEN);
  await AsyncStorage.setItem("@user_nim", DEMO_PROFILE.nim);
  await AsyncStorage.setItem("@user_profile", JSON.stringify(DEMO_PROFILE));
  await setDemoMode(true);
}
