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
import {
    clearAllFaceData,
    getRemainingFaceResets,
    MAX_FACE_RESETS,
    resetReferenceFace,
} from "../utils/faceAuthNative";
import { getDeviceInfoStr } from "../utils/deviceInfo";
import { isDemoModeActive, setDemoMode } from "../utils/demoMode";

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
  const [remainingResets, setRemainingResets] = useState<number>(MAX_FACE_RESETS);
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
    setRemainingResets(await getRemainingFaceResets());
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
        const dbFotoUrl = `https://lkh-kkn.uin-alauddin.ac.id/api/profil-peserta?profil=${fotoName}&device_info=${getDeviceInfoStr()}&version=1.1.1`;

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
          "User-Agent": "Dart/3.8 (dart:io)",
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

  const handleResetReferenceFace = () => {
    if (remainingResets <= 0) {
      Alert.alert(
        "Batas Reset Tercapai",
        `Wajah patokan sudah direset ${MAX_FACE_RESETS}x, batas maksimal sudah tercapai. Hubungi panitia KKN jika masih butuh reset.`,
      );
      return;
    }

    Alert.alert(
      "Reset Wajah Patokan?",
      `Wajah patokan saat ini akan dihapus. Foto absensi berikutnya akan dijadikan patokan wajah baru. Sisa kesempatan reset: ${remainingResets} dari ${MAX_FACE_RESETS}. Lanjutkan?`,
      [
        { text: "Batal", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            const success = await resetReferenceFace();
            if (!success) {
              Alert.alert("Gagal", "Batas reset sudah tercapai.");
              return;
            }
            await loadReferenceFaceState();
            Alert.alert(
              "Berhasil",
              "Wajah patokan dihapus. Foto absensi berikutnya di halaman utama akan dijadikan patokan wajah baru.",
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
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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
                remainingResets <= 0 && styles.resetFaceButtonDisabled,
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
                Reset Wajah Patokan ({remainingResets}/{MAX_FACE_RESETS})
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
                  await clearAllFaceData();
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
  demoButtonText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: "700",
  },
  demoButtonTextActive: {
    color: "#FFF",
  },
});
