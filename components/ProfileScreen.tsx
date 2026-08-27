import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { BlurView } from "expo-blur";
import React, { useEffect, useState } from "react";
import {
    Alert,
    Image,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { getCalibrationLog } from "../utils/faceAuthNative";
import {
    describeFaceStorage,
    getResetQuota,
    MAX_FACE_RESETS,
    resetEnrollment,
    type ResetQuota,
} from "../utils/faceEnrollment";
import { getDeviceInfoStr, APP_VERSION, API_USER_AGENT } from "../utils/deviceInfo";
import { isDemoModeActive, setDemoMode } from "../utils/demoMode";
import Constants from "expo-constants";

interface ProfileScreenProps {
  onLogout: () => void;
}

interface ProfileData {
  nim: string;
  nama: string;
  tglLahir: string;
  prodi: string;
  fakultas: string;
  tahunMasuk: string;
  angkatan: string;
  kecamatan: string;
  kabupaten: string;
  serverFotoUrl: string;
}

export default function ProfileScreen({ onLogout }: ProfileScreenProps) {
  const [profileData, setProfileData] = useState<ProfileData>({
    nim: "",
    nama: "Memuat...",
    tglLahir: "",
    prodi: "",
    fakultas: "",
    tahunMasuk: "",
    angkatan: "",
    kecamatan: "",
    kabupaten: "",
    serverFotoUrl:
      "https://uin-alauddin.ac.id/assets/img/logo-uin-alauddin.png",
  });

  const [token, setToken] = useState<string>("");
  // Jatah reset otoritasnya di server (app Android memakai /api/jumlah-reset
  // & /api/max-reset) - nilai awal di bawah cuma penampil sementara sebelum
  // jawaban server masuk, dan jadi cadangan kalau server tak terjangkau.
  const [resetQuota, setResetQuota] = useState<ResetQuota>({
    remaining: MAX_FACE_RESETS,
    max: MAX_FACE_RESETS,
    fromServer: false,
  });
  const [demoModeActive, setDemoModeActive] = useState(false);

  // Sengaja cuma jalan sekali saat mount - lihat catatan yang sama di
  // LKHScreen.tsx.
  useEffect(() => {
    loadReferenceFaceState();
    loadUserData();
    isDemoModeActive().then(setDemoModeActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadReferenceFaceState = async () => {
    setResetQuota(await getResetQuota());
  };

  const handleToggleDemoMode = () => {
    const next = !demoModeActive;
    Alert.alert(
      next ? "Aktifkan Mode Demo?" : "Matikan Mode Demo?",
      next
        ? "Cek periode DAN jarak posko KKN di halaman LKH akan dilewati sementara, supaya kamera & verifikasi wajah tetap bisa diuji dari luar periode/lokasi KKN asli. Verifikasi wajah sendiri tetap berjalan apa adanya (tidak dilonggarkan) - absen yang berhasil lewat mode ini ditandai \"Demo\" di kalender dan TIDAK PERNAH dikirim ke server, jadi aman dipakai untuk uji coba."
        : "Cek periode & jarak posko akan berlaku normal lagi sesuai data server.",
      [
        { text: "Batal", style: "cancel" },
        {
          text: next ? "Aktifkan" : "Matikan",
          onPress: async () => {
            await setDemoMode(next);
            setDemoModeActive(next);
          },
        },
      ],
    );
  };

  const loadUserData = async () => {
    try {
      const profileJson = await AsyncStorage.getItem("@user_profile");
      const savedToken = await AsyncStorage.getItem("@user_token");

      if (savedToken) setToken(savedToken);

      if (profileJson) {
        const data = JSON.parse(profileJson);
        const fotoName = data.foto || "274131.jpg";

        // PERBAIKAN: Menambahkan device_info
        const dbFotoUrl = `https://lkh-kkn.uin-alauddin.ac.id/api/profil-peserta?profil=${fotoName}&device_info=${getDeviceInfoStr()}&version=${APP_VERSION}`;

        setProfileData({
          nim: data.nim,
          nama: data.nama,
          tglLahir: data.tglLahir,
          prodi: data.prodi,
          fakultas: data.fakultas,
          tahunMasuk: data.tahunMasuk,
          angkatan: data.angkatan,
          kecamatan: data.kecamatan,
          kabupaten: data.kabupaten,
          serverFotoUrl: dbFotoUrl,
        });

        if (savedToken) {
          downloadProfileFromDB(dbFotoUrl, savedToken);
        }
      }
    } catch (e) {
      console.error("Gagal load biodata", e);
    }
  };

  const downloadProfileFromDB = async (url: string, authToken: string) => {
    try {
      const localUri = FileSystem.documentDirectory + "profile_db.jpg";
      const { uri, status } = await FileSystem.downloadAsync(url, localUri, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "User-Agent": API_USER_AGENT,
          "Accept-Encoding": "gzip",
        },
      });

      if (status === 200) {
        setProfileData((prev) => ({
          ...prev,
          serverFotoUrl: uri,
        }));
      }
    } catch (error) {
      console.error("Gagal mengunduh foto dari database", error);
    }
  };

  const handleViewCalibrationLog = async () => {
    const log = await getCalibrationLog();
    if (log.length === 0) {
      Alert.alert(
        "Log Kemiripan Kosong",
        "Belum ada data kemiripan wajah yang tercatat dari absensi.",
      );
      return;
    }
    // 10 terbaru dulu (paling relevan buat lihat kejadian baru-baru ini) -
    // log bisa sampai 200 entri, ditampilkan semua lewat Alert bakal
    // kepotong/susah dibaca.
    const recent = log.slice(-10).reverse();
    const lines = recent.map((entry) => {
      const time = new Date(entry.t).toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${time}  ${(entry.s * 100).toFixed(1)}%  (${entry.label})`;
    });
    Alert.alert(
      `Log Kemiripan Wajah (${log.length} total, 10 terbaru)`,
      lines.join("\n"),
    );
  };

  // Diagnostik: build sideload tidak punya console, jadi state penyimpanan
  // wajah hanya bisa diperiksa lewat layar. Menampilkan kedua namespace
  // (asli + demo) supaya ketahuan apakah data hilang, tersimpan di tempat
  // yang keliru, atau terbaca rusak.
  const handleViewFaceState = async () => {
    Alert.alert("Status Data Wajah", await describeFaceStorage());
  };

  const handleResetReferenceFace = () => {
    if (resetQuota.remaining <= 0) {
      Alert.alert(
        "Batas Reset Tercapai",
        `Wajah terdaftar sudah direset ${resetQuota.max}x, batas maksimal sudah tercapai. Hubungi panitia KKN jika masih butuh reset.`,
      );
      return;
    }

    Alert.alert(
      "Reset Wajah Terdaftar?",
      `Seluruh set wajah terdaftar akan dihapus dari server dan perangkat ini. Anda harus mendaftar ulang (3-5 foto selfie di halaman LKH) sebelum bisa absen lagi. Sisa kesempatan reset: ${resetQuota.remaining} dari ${resetQuota.max}. Lanjutkan?`,
      [
        { text: "Batal", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            const success = await resetEnrollment();
            if (!success) {
              Alert.alert("Gagal", "Batas reset sudah tercapai.");
              return;
            }
            await loadReferenceFaceState();
            Alert.alert(
              "Berhasil",
              "Wajah terdaftar dihapus. Buka halaman LKH dan tekan tombol absen untuk mendaftar ulang lewat 3-5 foto selfie.",
            );
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.glassShadow}>
          <BlurView intensity={45} tint="light" style={styles.avatarContainer}>
            <Image
              source={{
                uri: profileData.serverFotoUrl,
                // Sebelum ter-download lokal, URL ini masih endpoint yang
                // butuh Bearer token - tanpa header ini request-nya gagal
                // diam-diam dan foto jatuh ke placeholder abu-abu.
                // User-Agent wajib: Cloudflare WAF memblokir request
                // non-Dart (lihat utils/deviceInfo.ts).
                headers: token
                  ? {
                      Authorization: `Bearer ${token}`,
                      "User-Agent": API_USER_AGENT,
                    }
                  : { "User-Agent": API_USER_AGENT },
              }}
              style={styles.avatarImage}
              defaultSource={{
                uri: "https://uin-alauddin.ac.id/assets/img/logo-uin-alauddin.png",
              }}
            />
            <Text style={styles.nameText}>{profileData.nama}</Text>
            <Text style={styles.nimText}>{profileData.nim}</Text>

            <TouchableOpacity
              style={[
                styles.resetFaceButton,
                resetQuota.remaining <= 0 && styles.resetFaceButtonDisabled,
              ]}
              onPress={handleResetReferenceFace}
              activeOpacity={0.8}
            >
              <Ionicons
                name="refresh"
                size={16}
                color="#FFF"
                style={{ marginRight: 6 }}
              />
              <Text style={styles.resetFaceText}>
                Reset Wajah Terdaftar ({resetQuota.remaining}/{resetQuota.max})
              </Text>
            </TouchableOpacity>
          </BlurView>
        </View>

        <View style={styles.glassShadow}>
          <BlurView intensity={45} tint="light" style={styles.tableCard}>
            <View style={styles.rowItem}>
              <Text style={styles.rowLabel}>Tanggal Lahir</Text>
              <Text style={styles.rowValue}>{profileData.tglLahir}</Text>
            </View>
            <View style={styles.rowItem}>
              <Text style={styles.rowLabel}>Program Studi</Text>
              <Text style={styles.rowValue}>{profileData.prodi}</Text>
            </View>
            <View style={styles.rowItem}>
              <Text style={styles.rowLabel}>Fakultas</Text>
              <Text style={styles.rowValue}>{profileData.fakultas}</Text>
            </View>
            <View style={styles.rowItem}>
              <Text style={styles.rowLabel}>Tahun Masuk</Text>
              <Text style={styles.rowValue}>{profileData.tahunMasuk}</Text>
            </View>
            <View style={styles.rowItem}>
              <Text style={styles.rowLabel}>Angkatan KKN</Text>
              <Text style={styles.rowValue}>{profileData.angkatan}</Text>
            </View>
            <View style={[styles.rowItem, styles.rowItemLast]}>
              <Text style={styles.rowLabel}>Lokasi KKN</Text>
              <Text style={styles.rowValue}>
                {profileData.kecamatan}, {profileData.kabupaten}
              </Text>
            </View>
          </BlurView>
        </View>

        <TouchableOpacity
          style={styles.logoutButton}
          onPress={() => {
            Alert.alert("Konfirmasi", "Yakin ingin keluar akun?", [
              { text: "Batal", style: "cancel" },
              {
                text: "Logout",
                style: "destructive",
                onPress: async () => {
                  await AsyncStorage.removeItem("@user_token");
                  await AsyncStorage.removeItem("@user_nim");
                  await AsyncStorage.removeItem("@user_profile");
                  // Sesi demo (Masuk Mode Demo di LoginScreen) menyalakan
                  // @demo_mode - matikan ikut di sini supaya sesi demo benar-
                  // benar berakhir saat logout dan login asli berikutnya tidak
                  // diam-diam masih membypass gerbang periode/geofence.
                  await AsyncStorage.removeItem("@demo_mode");
                  // BUGFIX: used to also call clearAllFaceData() here,
                  // wiping the reference face on every logout - this app is
                  // used on the student's own personal device (see
                  // PANDUAN-BUILD-IPA.md / KSign sideload flow), not shared
                  // between accounts, so there was no real "account switch"
                  // this was protecting against - it just forced a
                  // re-enroll on every login, which is worse for
                  // anti-titip-absen than keeping the original reference.
                  onLogout();
                },
              },
            ]);
          }}
          activeOpacity={0.85}
        >
          <Ionicons
            name="log-out-outline"
            size={20}
            color="#FFF"
            style={{ marginRight: 8 }}
          />
          <Text style={styles.logoutText}>LOGOUT</Text>
        </TouchableOpacity>

        {/* Tombol uji fitur: sengaja diletakkan terpisah di bawah Logout,
            bukan dekat tombol lain, supaya tidak tersenggol tidak sengaja -
            ini cuma buat menguji kamera/lokasi/wajah kapan saja, bukan
            bagian alur absensi normal. */}
        <TouchableOpacity
          style={[
            styles.demoButton,
            demoModeActive && styles.demoButtonActive,
          ]}
          onPress={handleToggleDemoMode}
          activeOpacity={0.85}
        >
          <Ionicons
            name={demoModeActive ? "flask" : "flask-outline"}
            size={18}
            color={demoModeActive ? "#FFF" : "#6E6E73"}
            style={{ marginRight: 8 }}
          />
          <Text
            style={[
              styles.demoButtonText,
              demoModeActive && styles.demoButtonTextActive,
            ]}
          >
            {demoModeActive
              ? "Mode Demo Aktif - Ketuk untuk Matikan"
              : "Mode Demo (Uji Fitur Tanpa Periode KKN)"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.demoButton}
          onPress={handleViewCalibrationLog}
          activeOpacity={0.85}
        >
          <Ionicons
            name="stats-chart-outline"
            size={18}
            color={TEXT_SECONDARY}
            style={{ marginRight: 8 }}
          />
          <Text style={styles.demoButtonText}>Lihat Log Kemiripan Wajah</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.demoButton}
          onPress={handleViewFaceState}
          activeOpacity={0.85}
        >
          <Ionicons
            name="bug-outline"
            size={18}
            color="#6E6E73"
            style={{ marginRight: 8 }}
          />
          <Text style={styles.demoButtonText}>Status Data Wajah</Text>
        </TouchableOpacity>

        {/* Aplikasi ini dipasang lewat sideload, sering beberapa build
            berturut-turut dalam sehari - tanpa ini tidak ada cara memastikan
            build mana yang benar-benar terpasang saat menguji perbaikan.
            Nomor build diisi otomatis dari nomor run GitHub Actions (lihat
            .github/workflows/build-ios.yml), jadi angka lebih besar = lebih
            baru. Ini versi APLIKASI, bukan APP_VERSION yang dikirim ke server
            di utils/deviceInfo.ts. */}
        <Text style={styles.versionText}>
          Versi {Constants.expoConfig?.version ?? "?"} (build{" "}
          {Constants.expoConfig?.ios?.buildNumber ?? "?"})
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const ACCENT = "#0E783D";
const TEXT_PRIMARY = "#1C1C1E";
const TEXT_SECONDARY = "#6E6E73";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#EEF1F6",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    alignItems: "center",
  },
  glassShadow: {
    width: "100%",
    borderRadius: 28,
    marginBottom: 16,
    shadowColor: "#3A4B5C",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  avatarContainer: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.45)",
    width: "100%",
    padding: 22,
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.65)",
  },
  avatarImage: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 3,
    borderColor: ACCENT,
    marginBottom: 12,
    backgroundColor: "#EEE",
  },
  nameText: {
    fontSize: 18,
    fontWeight: "700",
    color: TEXT_PRIMARY,
  },
  nimText: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    marginTop: 2,
    marginBottom: 16,
  },
  resetFaceButton: {
    flexDirection: "row",
    backgroundColor: "#3C7A57",
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 16,
    alignItems: "center",
  },
  resetFaceButtonDisabled: {
    backgroundColor: "#9AA5A0",
  },
  resetFaceText: {
    color: "#FFF",
    fontWeight: "700",
    fontSize: 13,
  },
  tableCard: {
    backgroundColor: "rgba(255,255,255,0.45)",
    width: "100%",
    borderRadius: 28,
    paddingHorizontal: 18,
    paddingVertical: 6,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.65)",
  },
  rowItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(120,130,150,0.15)",
  },
  rowItemLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    fontWeight: "500",
  },
  rowValue: {
    fontSize: 14,
    color: TEXT_PRIMARY,
    fontWeight: "600",
    textAlign: "right",
  },
  logoutButton: {
    flexDirection: "row",
    backgroundColor: "#D32F2F",
    width: "100%",
    paddingVertical: 15,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#D32F2F",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  logoutText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  demoButton: {
    flexDirection: "row",
    backgroundColor: "rgba(120,130,150,0.12)",
    width: "100%",
    paddingVertical: 13,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 12,
    borderWidth: 1,
    borderColor: "rgba(120,130,150,0.2)",
  },
  demoButtonActive: {
    backgroundColor: "#B8860B",
    borderColor: "#B8860B",
  },
  versionText: {
    textAlign: "center",
    color: "#8E8E93",
    fontSize: 12,
    marginTop: 18,
  },
  demoButtonText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: "700",
  },
  demoButtonTextActive: {
    color: "#FFF",
  },
});
