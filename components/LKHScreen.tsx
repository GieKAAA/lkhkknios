import { FontAwesome5, Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { BlurView } from "expo-blur";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    Modal,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { CommonResolutions, useCameraDevice, useCameraPermission, usePhotoOutput } from "react-native-vision-camera";
import { Camera as FaceDetectorCamera } from "react-native-vision-camera-face-detector";
import {
    FACE_DETECTOR_OPTIONS,
    FACE_MATCH_THRESHOLD,
    getFaceEmbedding,
    logSimilaritySample,
    MultipleFacesDetectedError,
    NoFaceDetectedError,
    PoorQualityFaceError,
} from "../utils/faceAuthNative";
import {
    bestSimilarityToEnrollment,
    isEnrolled,
} from "../utils/faceEnrollment";
import FaceEnrollmentModal from "./FaceEnrollmentModal";
import { useFaceQualityGate } from "../hooks/useFaceQualityGate";
import { scheduleDailyAttendanceReminders } from "../utils/notifications";
import {
    checkAttendanceLocation,
    LocationPermissionDeniedError,
    LocationUnavailableError,
    MAX_DISTANCE_KM,
    resolvePoskoLocation,
} from "../utils/geofence";
import { getDeviceInfoStr, APP_VERSION, API_USER_AGENT } from "../utils/deviceInfo";
import { isDemoModeActive } from "../utils/demoMode";

type LKHStatus = "synced" | "unsynced" | "empty" | "today" | "none";

interface LKHRecord {
  date: string;
  status: LKHStatus;
  photoUri?: string;
  /** ID unik dibuat di device saat laporan diambil offline - dipakai supaya
   * retry sinkron ke /api/simpan-lkh tidak membuat duplikat di server. */
  kode?: string;
  /** "latitude,longitude" saat foto diambil, dikirim saat sinkron. */
  koordinat?: string;
  /** True kalau diambil selagi Mode Demo aktif - dikecualikan dari sinkron
   * ke server asli (lihat handleSync) supaya data uji coba tidak pernah
   * terkirim sebagai laporan KKN sungguhan. */
  isDemo?: boolean;
}

interface UserData {
  nama: string;
  nim: string;
  prodi: string;
  fotoUrl: string;
  kecamatan: string | null;
  kabupaten: string | null;
  poskoKoordinat: string | null;
  // Dua sumber periode KKN dari server - lihat kknPeriod di bawah untuk
  // urutan prioritasnya.
  angkatanTanggalMulai: string | null;
  angkatanTanggalSelesai: string | null;
  settingTanggalMulai: string | null;
  settingTanggalSelesai: string | null;
}

function generateLocalRecordCode(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function LKHScreen() {
  const [userData, setUserData] = useState<UserData>({
    nama: "Memuat...",
    nim: "",
    prodi: "",
    fotoUrl: "https://uin-alauddin.ac.id/assets/img/logo-uin-alauddin.png",
    kecamatan: null,
    kabupaten: null,
    poskoKoordinat: null,
    angkatanTanggalMulai: null,
    angkatanTanggalSelesai: null,
    settingTanggalMulai: null,
    settingTanggalSelesai: null,
  });

  const [token, setToken] = useState<string>("");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [records, setRecords] = useState<{ [key: string]: LKHRecord }>({});
  const [demoModeActive, setDemoModeActive] = useState(false);

  // Periode KKN dihitung dari data server, bukan tanggal hardcode. Server
  // punya dua sumber: per lokasi/kecamatan (wilayahKec.setting - lebih
  // akurat karena tiap posko bisa mulai beda tanggal, tapi field ini sering
  // kosong kalau admin belum isi) dan per angkatan (lebih umum, fallback).
  // Kalau keduanya kosong, cek periode fail-open (dianggap selalu dalam
  // periode) - lebih baik daripada memblokir absen mahasiswa yang datanya
  // memang belum lengkap di server.
  const kknPeriod = useMemo(() => {
    const parseServerDate = (value: string | null): Date | null => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    const start =
      parseServerDate(userData.settingTanggalMulai) ??
      parseServerDate(userData.angkatanTanggalMulai);
    const end =
      parseServerDate(userData.settingTanggalSelesai) ??
      parseServerDate(userData.angkatanTanggalSelesai);

    return { start, end };
  }, [
    userData.settingTanggalMulai,
    userData.settingTanggalSelesai,
    userData.angkatanTanggalMulai,
    userData.angkatanTanggalSelesai,
  ]);

  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice("front");
  // targetResolution default-nya usePhotoOutput() adalah UHD_4_3 (3024x4032,
  // rasio 3:4, ~12MP). Preview di layar full-screen (StyleSheet.absoluteFillObject,
  // rasio ramping ~9:19.5 di iPhone), jauh berbeda dari 4:3 - meminta resolusi
  // foto dengan rasio sejauh itu dari preview bisa membuat iOS memilih format
  // capture yang field-of-view-nya beda dari yang dipakai live preview (foto
  // hasil jepretan jadi "zoom" dibanding apa yang terlihat di preview, sampai-
  // sampai wajah tidak lagi utuh dalam frame dan MLKit gagal mendeteksinya).
  // FHD_16_9 dipakai karena rasio 9:16-nya jauh lebih dekat ke bentuk preview,
  // dan resolusinya (1080x1920) sudah jauh lebih dari cukup untuk model
  // MobileFaceNet yang inputnya cuma 112x112.
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.FHD_16_9,
  });
  const faceQualityGate = useFaceQualityGate();
  const [isCameraVisible, setIsCameraVisible] = useState(false);
  // Enrollment terpisah (FaceEnrollmentModal) - terbuka saat user mencoba
  // absen tanpa punya set wajah terdaftar. Menggantikan jalur lama di mana
  // foto absen pertama diam-diam menjadi wajah patokan.
  const [isEnrollmentVisible, setIsEnrollmentVisible] = useState(false);
  // Koordinat device saat lolos cek geofence terakhir kali kamera dibuka -
  // dipakai ulang saat foto benar-benar disimpan (persistAttendance) supaya
  // tidak perlu minta GPS dua kali dalam rentang beberapa detik yang sama.
  const pendingCoordinatesRef = useRef<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Wajah patokan (baseline) yang direkam pertama kali lewat tombol absensi,
  // dipakai untuk memverifikasi bahwa setiap absen berikutnya adalah orang
  // yang sama (mencegah titip absen). Verifikasi dijalankan sekali saat foto
  // benar-benar diambil (lihat takeSelfie) - bukan terus-menerus selama
  // kamera terbuka, karena menjalankan model AI berulang kali sambil live
  // preview kamera aktif terbukti bikin aplikasi force close di beberapa HP.
  const [hasEnrollment, setHasEnrollment] = useState(false);
  const [isProcessingFace, setIsProcessingFace] = useState(false);
  // DIAGNOSTIK SEMENTARA: menampilkan foto hasil jepretan apa adanya saat
  // deteksi wajah gagal, supaya bisa dilihat langsung (miring/gelap/
  // terpotong?) tanpa perlu Console.app. Hapus setelah root cause ketemu.
  const [debugPhotoUri, setDebugPhotoUri] = useState<string | null>(null);
  const [isCheckingLocation, setIsCheckingLocation] = useState(false);

  // Sengaja cuma jalan sekali saat mount (bukan menambahkan loadUserProfile
  // dkk ke dependency array) - fungsi-fungsi itu tidak dibungkus useCallback
  // dan referensinya berubah tiap render, jadi menurutinya malah membuat
  // efek ini jalan berulang.
  useEffect(() => {
    loadUserProfile().then(() => {
      fetchServerLKH();
    });
    isEnrolled().then(setHasEnrollment);
    isDemoModeActive().then(setDemoModeActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jadwalkan ulang notifikasi pengingat absen (10:00 & 20:00) setiap kali
  // data laporan berubah - otomatis dibatalkan begitu hari ini sudah absen.
  useEffect(() => {
    const today = new Date();
    const localToday = new Date(
      today.getTime() - today.getTimezoneOffset() * 60000,
    );
    const todayStr = localToday.toISOString().split("T")[0];
    scheduleDailyAttendanceReminders(!!records[todayStr]).catch(() => {});
  }, [records]);

  const loadUserProfile = async () => {
    try {
      const profileJson = await AsyncStorage.getItem("@user_profile");
      const savedToken = await AsyncStorage.getItem("@user_token");

      if (savedToken) setToken(savedToken);

      if (profileJson) {
        const data = JSON.parse(profileJson);
        const fotoName = data.foto || "274131.jpg";

        // PERBAIKAN: Menambahkan device_info pada URL Foto agar tidak ditolak server
        const dbFotoUrl = `https://lkh-kkn.uin-alauddin.ac.id/api/profil-peserta?profil=${fotoName}&device_info=${getDeviceInfoStr()}&version=${APP_VERSION}`;

        setUserData({
          nama: data.nama,
          nim: data.nim,
          prodi: data.prodi,
          fotoUrl: dbFotoUrl,
          kecamatan: data.kecamatan || null,
          kabupaten: data.kabupaten || null,
          poskoKoordinat: data.poskoKoordinat || null,
          angkatanTanggalMulai: data.angkatanTanggalMulai || null,
          angkatanTanggalSelesai: data.angkatanTanggalSelesai || null,
          settingTanggalMulai: data.settingTanggalMulai || null,
          settingTanggalSelesai: data.settingTanggalSelesai || null,
        });

        if (savedToken) {
          downloadProfileFromDB(dbFotoUrl, savedToken);
        }
      }
    } catch (e) {
      console.error("Gagal membaca data profil", e);
    }
  };

  const downloadProfileFromDB = async (url: string, authToken: string) => {
    try {
      const localUri = FileSystem.documentDirectory + "lkh_profile_db.jpg";
      const { uri, status } = await FileSystem.downloadAsync(url, localUri, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "User-Agent": API_USER_AGENT,
          "Accept-Encoding": "gzip",
        },
      });

      if (status === 200) {
        setUserData((prev) => ({
          ...prev,
          fotoUrl: uri,
        }));
      }
    } catch (error) {
      console.error("Gagal mengunduh foto database", error);
    }
  };

  const fetchServerLKH = async () => {
    try {
      const currentToken = await AsyncStorage.getItem("@user_token");
      const nim = await AsyncStorage.getItem("@user_nim");
      if (!currentToken || !nim) return;

      const url = `https://lkh-kkn.uin-alauddin.ac.id/api/lkh?nim=${nim}&device_info=${getDeviceInfoStr()}&version=${APP_VERSION}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${currentToken}`,
          "User-Agent": API_USER_AGENT,
          "Accept-Encoding": "gzip",
        },
      });

      const text = await response.text();

      // PERBAIKAN: Cek apakah response berupa HTML (Sesi Expired)
      if (text.trim().startsWith("<")) {
        console.log("Sesi expired atau server mengembalikan HTML.");
        // Ambil dari lokal saja
        const stored = await AsyncStorage.getItem("@lkh_records");
        if (stored) setRecords(JSON.parse(stored));
        return;
      }

      const result = JSON.parse(text);

      if (result.statusCode === 200 && Array.isArray(result.data)) {
        const stored = await AsyncStorage.getItem("@lkh_records");
        const previousLocal: { [key: string]: LKHRecord } = stored
          ? JSON.parse(stored)
          : {};

        // Server adalah sumber kebenaran: hasil akhir dibangun mulai dari
        // data server, bukan ditumpuk di atas cache lokal lama seperti
        // sebelumnya. Sebelumnya entri lokal yang sudah tidak ada di server
        // tidak pernah dibersihkan, jadi tanggal yang sebenarnya kosong bisa
        // tetap kelihatan "terabsen" selamanya (misal sisa dari testing).
        // Entri lokal cuma dipertahankan kalau statusnya masih "unsynced" -
        // laporan yang baru diambil offline dan server memang belum tahu
        // soal itu, bukan sisa data lama.
        const merged: { [key: string]: LKHRecord } = {};

        result.data.forEach((item: any) => {
          if (!item.waktu) return;
          const existing = previousLocal[item.waktu];
          merged[item.waktu] = {
            date: item.waktu,
            status: item.sinkron === 1 ? "synced" : "unsynced",
            // Server tidak mengirim balik file foto/kode - dipertahankan
            // dari cache lokal kalau ada supaya tetap bisa ditampilkan.
            photoUri: existing?.photoUri,
            kode: existing?.kode,
            koordinat: existing?.koordinat,
          };
        });

        Object.keys(previousLocal).forEach((dateKey) => {
          if (merged[dateKey]) return;
          if (previousLocal[dateKey].status === "unsynced") {
            merged[dateKey] = previousLocal[dateKey];
          }
        });

        await AsyncStorage.setItem("@lkh_records", JSON.stringify(merged));
        setRecords(merged);
      }
    } catch (error) {
      console.error("Gagal menarik LKH:", error);
      const stored = await AsyncStorage.getItem("@lkh_records");
      if (stored) setRecords(JSON.parse(stored));
    }
  };

  const saveLocalRecords = async (newRecords: { [key: string]: LKHRecord }) => {
    try {
      await AsyncStorage.setItem("@lkh_records", JSON.stringify(newRecords));
      setRecords(newRecords);
    } catch (e) {
      console.error("Gagal simpan data lokal", e);
    }
  };

  const isWithinKKNPeriod = (date: Date) => {
    // Mode Demo (tombol di ProfileScreen) sengaja melewati cek ini supaya
    // fitur kamera/lokasi/wajah tetap bisa diuji walau periode KKN asli
    // sudah lewat - lihat utils/demoMode.ts.
    if (demoModeActive) return true;
    // Fail-open kalau server belum punya tanggal periode sama sekali (lihat
    // kknPeriod di atas) - jangan blokir absen gara-gara data admin belum
    // lengkap.
    if (!kknPeriod.start || !kknPeriod.end) return true;
    return date >= kknPeriod.start && date <= kknPeriod.end;
  };

  const handleDatePress = async (day: number) => {
    const selectedDate = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      day,
    );

    const localDate = new Date(
      selectedDate.getTime() - selectedDate.getTimezoneOffset() * 60000,
    );
    const dateStr = localDate.toISOString().split("T")[0];

    const today = new Date();
    const localToday = new Date(
      today.getTime() - today.getTimezoneOffset() * 60000,
    );
    const todayStr = localToday.toISOString().split("T")[0];

    if (!isWithinKKNPeriod(selectedDate)) {
      Alert.alert("Perhatian", "Tanggal ini bukan dalam periode aktif KKN.");
      return;
    }

    // Tanggal hanya menampilkan info. Pengambilan foto absensi dilakukan
    // lewat tombol "Ambil Foto Absensi" di bawah kalender, bukan dari sini.
    const demoSuffix = records[dateStr]?.isDemo ? " (Uji Coba / Demo, tidak dikirim ke server)" : "";

    if (dateStr === todayStr) {
      Alert.alert(
        "Hari Ini",
        records[dateStr]?.status
          ? `Status: ${
              records[dateStr]?.status === "synced"
                ? "Sudah Tersinkron (Biru)"
                : "Belum Tersinkron (Kuning)"
            }${demoSuffix}`
          : 'Anda belum absen hari ini. Gunakan tombol "Ambil Foto Absensi" di bawah kalender.',
      );
    } else {
      Alert.alert(
        "Info Tanggal",
        `Tanggal: ${dateStr}\nStatus: ${
          records[dateStr]?.status === "synced"
            ? "Sudah Tersinkron (Biru)"
            : records[dateStr]?.status === "unsynced"
              ? "Belum Tersinkron (Kuning)"
              : "Tidak Mengisi / Kosong (Merah)"
        }${demoSuffix}`,
      );
    }
  };

  const handleOpenAttendanceCamera = async () => {
    const today = new Date();

    if (!isWithinKKNPeriod(today)) {
      Alert.alert("Perhatian", "Hari ini bukan dalam periode aktif KKN.");
      return;
    }

    // Enrollment terpisah: tanpa set wajah terdaftar, pintu masuknya adalah
    // modal pendaftaran (3-5 foto), BUKAN kamera absen - dan semua pemeriksaan
    // berat di bawah (izin kamera, geofence) tidak perlu dijalankan dulu.
    // Menggantikan jalur lama yang diam-diam menjadikan foto absen pertama
    // sebagai wajah patokan.
    if (!(await isEnrolled())) {
      setIsEnrollmentVisible(true);
      return;
    }

    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) {
        Alert.alert("Izin Ditolak", "Izin kamera dibutuhkan untuk selfie absensi.");
        return;
      }
    }
    if (!cameraDevice) {
      Alert.alert("Error", "Kamera depan tidak ditemukan di perangkat ini.");
      return;
    }

    setIsCheckingLocation(true);
    try {
      const poskoLocation = await resolvePoskoLocation({
        kecamatan: userData.kecamatan,
        kabupaten: userData.kabupaten,
        poskoKoordinat: userData.poskoKoordinat,
      });
      const { allowed, distanceKm, locationUnresolved, userLocation } =
        await checkAttendanceLocation(poskoLocation);
      pendingCoordinatesRef.current = `${userLocation.latitude},${userLocation.longitude}`;

      if (locationUnresolved) {
        // Tidak bisa menentukan lokasi posko sama sekali (data kecamatan
        // kosong & geocoding gagal) - absen tetap diizinkan (verifikasi
        // wajah tetap jadi pertahanan utama), tapi diberi tahu.
        console.log(
          "Geofence dilewati: lokasi posko tidak bisa ditentukan untuk akun ini.",
        );
      } else if (!allowed && distanceKm !== null) {
        // Mode Demo juga melewati geofence, bukan cuma periode KKN - supaya
        // kamera & verifikasi wajah tetap bisa diuji dari luar posko asli
        // (lihat catatan isDemo di persistAttendance: absen yang lolos lewat
        // jalur ini ditandai demo dan tidak pernah dikirim ke server asli).
        if (!demoModeActive) {
          Alert.alert(
            "Di Luar Jangkauan Posko",
            `Anda berjarak ${distanceKm.toFixed(1)} km dari posko. Absensi hanya bisa dilakukan dalam radius ${MAX_DISTANCE_KM} km dari posko/kecamatan lokasi KKN.`,
          );
          return;
        }
        console.log(
          `Mode Demo: geofence dilewati (berjarak ${distanceKm.toFixed(1)} km dari posko).`,
        );
      }
    } catch (error) {
      if (error instanceof LocationPermissionDeniedError) {
        Alert.alert("Izin Lokasi Ditolak", error.message);
      } else if (error instanceof LocationUnavailableError) {
        Alert.alert("Lokasi Tidak Ditemukan", error.message);
      } else {
        Alert.alert("Error", "Gagal memeriksa lokasi. Coba lagi.");
      }
      return;
    } finally {
      setIsCheckingLocation(false);
    }

    setIsCameraVisible(true);
  };

  const persistAttendance = async (photoUri: string) => {
    const today = new Date();
    const localToday = new Date(
      today.getTime() - today.getTimezoneOffset() * 60000,
    );
    const todayStr = localToday.toISOString().split("T")[0];

    const dir = FileSystem.documentDirectory || "";
    const newUri = `${dir}lkh_${todayStr}.jpg`;
    await FileSystem.copyAsync({
      from: photoUri,
      to: newUri,
    });

    const updatedRecords = {
      ...records,
      [todayStr]: {
        date: todayStr,
        status: "unsynced" as LKHStatus,
        photoUri: newUri,
        kode: records[todayStr]?.kode || generateLocalRecordCode(),
        koordinat: pendingCoordinatesRef.current || records[todayStr]?.koordinat,
        // Absen yang diambil selagi Mode Demo aktif ditandai demo - lihat
        // handleSync, catatan begini sengaja tidak pernah dikirim ke server
        // asli (mencegah data uji coba mengotori data KKN sungguhan kalau
        // kebetulan diambil di luar periode/lokasi asli).
        isDemo: demoModeActive || records[todayStr]?.isDemo,
      },
    };

    await saveLocalRecords(updatedRecords);
  };

  const takeSelfie = async () => {
    setIsProcessingFace(true);
    try {
      const photoFile = await photoOutput.capturePhotoToFile({}, {});
      // capturePhotoToFile() returns a plain filesystem path, not a
      // file:// URL - every downstream consumer here (expo-image-
      // manipulator, expo-file-system, <Image> source) expects a URI.
      const photoUri = `file://${photoFile.filePath}`;

      let embedding: Float32Array;
      try {
        embedding = await getFaceEmbedding(photoUri);
      } catch (error) {
        if (error instanceof NoFaceDetectedError) {
          setDebugPhotoUri(photoUri);
          Alert.alert("Wajah Tidak Terdeteksi", error.message);
        } else if (error instanceof MultipleFacesDetectedError) {
          Alert.alert("Wajah Lebih dari Satu", error.message);
        } else if (error instanceof PoorQualityFaceError) {
          Alert.alert("Foto Kurang Jelas", error.message);
        } else if (error instanceof Error) {
          Alert.alert("Verifikasi Wajah Gagal", error.message);
        } else {
          Alert.alert("Error", "Gagal memproses wajah. Coba lagi.");
        }
        return;
      }

      // Verifikasi max-of-N: bandingkan ke SEMUA embedding terdaftar dan
      // ambil similarity tertinggi (lihat bestSimilarityToEnrollment).
      const bestSimilarity = await bestSimilarityToEnrollment(embedding);

      if (bestSimilarity === null) {
        // Set wajah hilang di tengah jalan (misal di-reset dari halaman
        // Profil) - jalur enroll-diam-diam sudah dihapus, jadi arahkan ke
        // modal pendaftaran resmi alih-alih menjadikan foto ini patokan.
        setIsCameraVisible(false);
        setIsEnrollmentVisible(true);
        return;
      }

      await logSimilaritySample(bestSimilarity, "unknown");
      // Presisi 2 desimal sengaja dipakai sementara (bukan dibulatkan ke
      // bilangan bulat) supaya angka kemiripan yang asli kelihatan buat
      // kalibrasi - "100%" yang dibulatkan bisa saja aslinya 99.4%.
      const similarityLabel = (bestSimilarity * 100).toFixed(2);
      if (bestSimilarity < FACE_MATCH_THRESHOLD) {
        Alert.alert(
          "Wajah Tidak Cocok",
          `Wajah pada foto tidak cocok dengan wajah patokan absensi Anda (kemiripan ${similarityLabel}%). Absensi tidak disimpan.`,
        );
        return;
      }

      await persistAttendance(photoUri);
      setIsCameraVisible(false);
      Alert.alert(
        "Berhasil",
        `Wajah terverifikasi (kemiripan ${similarityLabel}%). Laporan dan foto selfie berhasil disimpan offline.`,
      );
    } catch (error) {
      console.error("Gagal mengambil foto selfie", error);
      Alert.alert("Error", "Gagal mengambil foto selfie.");
    } finally {
      setIsProcessingFace(false);
    }
  };

  const confirmSync = () => {
    Alert.alert("Sinkron", "Yakin Mensinkron data LKH yang masih kuning?", [
      { text: "Batal", style: "cancel" },
      {
        text: "OK",
        onPress: () => handleSync(),
      },
    ]);
  };

  // Endpoint & nama field di bawah ini direkonstruksi dari string di dalam
  // libapp.so aplikasi resmi (Flutter, decompiled) - bukan dari dokumentasi
  // API resmi, karena kita tidak punya akses ke situ. Kalau server menolak
  // dengan pesan validasi tertentu, itu yang jadi patokan buat koreksi nama
  // field selanjutnya (makanya pesan error asli dari server ditampilkan ke
  // pengguna, bukan cuma "gagal").
  const SIMPAN_LKH_URL = "https://lkh-kkn.uin-alauddin.ac.id/api/simpan-lkh";

  const syncOneRecord = async (
    nim: string,
    authToken: string,
    record: LKHRecord,
  ): Promise<{ ok: boolean; message?: string }> => {
    if (!record.photoUri) return { ok: false, message: "Tidak ada foto tersimpan." };

    const formData = new FormData();
    formData.append("nim", nim);
    formData.append("kode", record.kode || generateLocalRecordCode());
    formData.append("waktu", record.date);
    formData.append("koordinat", record.koordinat || "");
    formData.append("device_info", getDeviceInfoStr());
    formData.append("version", APP_VERSION);
    // React Native's FormData accepts this {uri,name,type} file shape (not
    // a real Blob) - the fetch polyfill turns it into a multipart part.
    formData.append("foto", {
      uri: record.photoUri,
      name: `lkh_${record.date}.jpg`,
      type: "image/jpeg",
    } as unknown as Blob);

    const response = await fetch(SIMPAN_LKH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "User-Agent": API_USER_AGENT,
        Accept: "application/json",
      },
      body: formData,
    });

    const text = await response.text();
    if (text.trim().startsWith("<")) {
      return { ok: false, message: "Sesi login kadaluarsa, silakan login ulang." };
    }

    try {
      const parsed = JSON.parse(text);
      const ok = response.ok && (parsed.statusCode === undefined || parsed.statusCode === 200);
      return { ok, message: parsed.desc };
    } catch {
      return { ok: response.ok, message: response.ok ? undefined : text.slice(0, 200) };
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const currentToken = await AsyncStorage.getItem("@user_token");
      const nim = await AsyncStorage.getItem("@user_nim");
      if (!currentToken || !nim) {
        Alert.alert("Gagal", "Sesi login tidak ditemukan, silakan login ulang.");
        return;
      }

      const updatedRecords = { ...records };
      let countSync = 0;
      let countFailed = 0;
      let countDemoSkipped = 0;
      let lastError = "";

      for (const key of Object.keys(updatedRecords)) {
        const record = updatedRecords[key];
        if (record.status !== "unsynced") continue;
        // Catatan demo tidak pernah dikirim ke server asli - lihat catatan
        // isDemo di persistAttendance.
        if (record.isDemo) {
          countDemoSkipped++;
          continue;
        }

        try {
          const result = await syncOneRecord(nim, currentToken, record);
          if (result.ok) {
            updatedRecords[key] = { ...record, status: "synced" };
            countSync++;
          } else {
            countFailed++;
            if (result.message) lastError = result.message;
          }
        } catch (err) {
          countFailed++;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      await saveLocalRecords(updatedRecords);
      await fetchServerLKH();

      const demoNote =
        countDemoSkipped > 0
          ? `\n\n${countDemoSkipped} laporan demo dilewati (tidak dikirim ke server).`
          : "";

      if (countFailed === 0) {
        Alert.alert(
          "Sinkronisasi Selesai",
          `${countSync} laporan berhasil disinkronkan ke server.${demoNote}`,
        );
      } else {
        Alert.alert(
          "Sinkronisasi Sebagian Gagal",
          `${countSync} berhasil, ${countFailed} gagal.` +
            (lastError ? `\n\nPesan server: ${lastError}` : "") +
            demoNote,
        );
      }
    } catch (e) {
      console.error("Gagal sinkronisasi", e);
      Alert.alert("Gagal", "Terjadi kesalahan saat sinkronisasi online.");
    } finally {
      setIsSyncing(false);
    }
  };

  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const today = new Date();
    const localToday = new Date(
      today.getTime() - today.getTimezoneOffset() * 60000,
    );
    const todayStr = localToday.toISOString().split("T")[0];

    // null kalau server belum kasih tanggal periode sama sekali (lihat
    // kknPeriod) - dalam kondisi itu, tanggal kosong tidak ditandai merah
    // sama sekali (kita tidak tahu apa tanggal itu "harusnya diisi" atau
    // bukan), daripada menebak pakai rentang yang salah.
    const kknStartStr = kknPeriod.start
      ? new Date(
          kknPeriod.start.getTime() - kknPeriod.start.getTimezoneOffset() * 60000,
        )
          .toISOString()
          .split("T")[0]
      : null;
    const kknEndStr = kknPeriod.end
      ? new Date(
          kknPeriod.end.getTime() - kknPeriod.end.getTimezoneOffset() * 60000,
        )
          .toISOString()
          .split("T")[0]
      : null;

    const days = [];
    for (let i = 0; i < firstDay; i++) {
      days.push(<View key={`empty-${i}`} style={styles.dayCell} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const localDate = new Date(
        date.getTime() - date.getTimezoneOffset() * 60000,
      );
      const dateStr = localDate.toISOString().split("T")[0];

      const record = records[dateStr];
      let bgStyle = styles.statusNone;

      // Catatan demo diprioritaskan tampil beda dari status lain (termasuk
      // dari warna "hari ini") supaya tidak pernah tertukar dengan absen
      // sungguhan sekilas mata.
      if (record?.isDemo) {
        bgStyle = styles.statusDemo;
      } else if (dateStr === todayStr) {
        bgStyle = styles.statusToday;
      } else if (record?.status === "synced") {
        bgStyle = styles.statusSynced;
      } else if (record?.status === "unsynced") {
        bgStyle = styles.statusUnsynced;
      } else if (
        kknStartStr &&
        kknEndStr &&
        dateStr >= kknStartStr &&
        dateStr <= kknEndStr &&
        dateStr < todayStr
      ) {
        bgStyle = styles.statusEmpty;
      }

      days.push(
        <TouchableOpacity
          key={`day-${day}`}
          style={styles.dayCell}
          onPress={() => handleDatePress(day)}
        >
          <View style={[styles.dayCircle, bgStyle]}>
            <Text style={styles.dayText}>{day}</Text>
          </View>
        </TouchableOpacity>,
      );
    }

    return days;
  };

  const captureDisabled = isProcessingFace;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.glassShadow}>
          <BlurView intensity={45} tint="light" style={styles.profileCard}>
            <Image
              source={{
                uri: userData.fotoUrl,
                // Foto profil sebelum ter-download lokal masih menunjuk ke
                // endpoint yang butuh Bearer token - tanpa header ini,
                // request-nya gagal diam-diam dan foto jatuh ke placeholder
                // abu-abu (backgroundColor di bawah). User-Agent juga wajib:
                // Cloudflare WAF memblokir request non-Dart sebelum sampai
                // server (lihat utils/deviceInfo.ts).
                headers: token
                  ? {
                      Authorization: `Bearer ${token}`,
                      "User-Agent": API_USER_AGENT,
                    }
                  : { "User-Agent": API_USER_AGENT },
              }}
              style={styles.profileImage}
              defaultSource={{
                uri: "https://uin-alauddin.ac.id/assets/img/logo-uin-alauddin.png",
              }}
            />
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{userData.nama}</Text>
              <Text style={styles.profileNim}>{userData.nim}</Text>
              <Text style={styles.profileMajor}>{userData.prodi}</Text>
            </View>
          </BlurView>
        </View>

        <View style={styles.glassShadow}>
          <BlurView intensity={45} tint="light" style={styles.calendarCard}>
            <View style={styles.monthNav}>
              <TouchableOpacity
                style={styles.monthNavBtn}
                onPress={() =>
                  setCurrentDate(
                    new Date(currentDate.setMonth(currentDate.getMonth() - 1)),
                  )
                }
              >
                <Ionicons name="chevron-back" size={20} color="#1C1C1E" />
              </TouchableOpacity>
              <Text style={styles.monthTitle}>
                {currentDate.toLocaleString("id-ID", {
                  month: "long",
                  year: "numeric",
                })}
              </Text>
              <TouchableOpacity
                style={styles.monthNavBtn}
                onPress={() =>
                  setCurrentDate(
                    new Date(currentDate.setMonth(currentDate.getMonth() + 1)),
                  )
                }
              >
                <Ionicons name="chevron-forward" size={20} color="#1C1C1E" />
              </TouchableOpacity>
            </View>

            <View style={styles.weekDaysRow}>
              {["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"].map((d) => (
                <Text key={d} style={styles.weekDayText}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>{renderCalendar()}</View>

            {/* Tombol ini sengaja diletakkan di sini, di antara kalender -
                bukan menempel pada sel tanggal manapun - sebagai satu-satunya
                pintu masuk untuk mengambil foto absensi. */}
            <TouchableOpacity
              style={[
                styles.attendanceButton,
                isCheckingLocation && styles.attendanceButtonDisabled,
              ]}
              onPress={handleOpenAttendanceCamera}
              activeOpacity={0.85}
              disabled={isCheckingLocation}
            >
              {isCheckingLocation ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <FontAwesome5 name="camera" size={16} color="#FFF" />
              )}
              <Text style={styles.attendanceButtonText}>
                {isCheckingLocation
                  ? "Memeriksa lokasi..."
                  : hasEnrollment
                    ? "Ambil Foto Absensi"
                    : "Daftarkan Wajah (Langkah Pertama)"}
              </Text>
            </TouchableOpacity>
            <Text style={styles.attendanceHint}>
              {hasEnrollment
                ? `Wajah diverifikasi otomatis, dan absen hanya bisa dalam radius ${MAX_DISTANCE_KM} km dari posko.`
                : `Sebelum absen, daftarkan wajah Anda lewat 3-5 foto selfie. Absen hanya bisa dalam radius ${MAX_DISTANCE_KM} km dari posko.`}
            </Text>

            <View style={styles.legendContainer}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, styles.statusSynced]} />
                <Text style={styles.legendText}>Sudah Tersinkron</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, styles.statusUnsynced]} />
                <Text style={styles.legendText}>Belum Tersinkron</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, styles.statusEmpty]} />
                <Text style={styles.legendText}>Tidak Mengisi</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, styles.statusToday]} />
                <Text style={styles.legendText}>Hari ini</Text>
              </View>
              {Object.values(records).some((r) => r.isDemo) && (
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, styles.statusDemo]} />
                  <Text style={styles.legendText}>Uji Coba (Demo)</Text>
                </View>
              )}
            </View>

            {demoModeActive ? (
              <Text style={styles.demoBadgeText}>
                Mode Demo aktif - cek periode & lokasi KKN dilewati (matikan lewat halaman Profil)
              </Text>
            ) : (
              !isWithinKKNPeriod(new Date()) && (
                <Text style={styles.warningText}>Bukan periode LKH</Text>
              )
            )}
          </BlurView>
        </View>
      </ScrollView>

      <TouchableOpacity
        style={styles.fabButton}
        onPress={confirmSync}
        activeOpacity={0.8}
      >
        <FontAwesome5 name="sync-alt" size={18} color="#FFF" />
      </TouchableOpacity>

      <Modal transparent visible={isSyncing} animationType="fade">
        <View style={styles.modalLoadingOverlay}>
          <BlurView intensity={60} tint="light" style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#0E783D" />
            <Text style={styles.loadingText}>Mensinkronkan Data...</Text>
          </BlurView>
        </View>
      </Modal>

      <Modal visible={isCameraVisible} animationType="slide">
        <SafeAreaView style={styles.cameraContainer}>
          {cameraDevice && (
            <FaceDetectorCamera
              style={styles.camera}
              device={cameraDevice}
              isActive={isCameraVisible}
              outputs={[photoOutput]}
              onFacesDetected={faceQualityGate.onFacesDetected}
              onError={faceQualityGate.onFaceDetectionError}
              performanceMode="fast"
              // DIAGNOSTIK: dipaksa false (bukan pakai
              // FACE_DETECTOR_OPTIONS.runLandmarks/runClassifications) untuk
              // isolasi apakah crash SIGSEGV saat kamera dibuka (lihat crash
              // log: EXC_BAD_ACCESS di thread JS Hermes, dipicu callback
              // onFacesDetected) berasal dari beban MLKit landmarks/
              // classifications di live preview - library ini sendiri
              // mengaku MLKit-iOS belum sepenuhnya kompatibel dengan iOS 26.
              // TIDAK memengaruhi pipeline foto still (utils/faceAuthNative.ts,
              // dipakai saat enroll/verify sungguhan) yang tetap pakai
              // FACE_DETECTOR_OPTIONS asli (landmarks+classifications ON).
              // Kalau setelah ini kamera masih crash, kemungkinan besar
              // masalahnya bukan di sini - live face detector-nya sendiri
              // yang perlu dimatikan total (bukan cuma landmarks/
              // classifications-nya).
              runLandmarks={false}
              runClassifications={false}
              minFaceSize={FACE_DETECTOR_OPTIONS.minFaceSize}
            />
          )}
          <View style={styles.cameraControls} pointerEvents="box-none">
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={() => {
                // Bersihkan overlay foto debug juga - kalau tidak, foto lama
                // ini akan nongol lagi menutupi kamera di sesi absen berikutnya
                // (debugPhotoUri masih ke-set dari kegagalan sebelumnya).
                setDebugPhotoUri(null);
                setIsCameraVisible(false);
              }}
            >
              <BlurView intensity={50} tint="dark" style={styles.closeBtnBlur}>
                <Ionicons name="close" size={24} color="#FFF" />
              </BlurView>
            </TouchableOpacity>

            <View style={styles.cameraBottomArea}>
              <BlurView intensity={50} tint="dark" style={styles.liveStatusPill}>
                <Text style={styles.liveStatusText}>
                  {`${faceQualityGate.message} (akan diverifikasi setelah jepret)`}
                </Text>
              </BlurView>

              <TouchableOpacity
                style={[
                  styles.captureBtn,
                  captureDisabled && styles.captureBtnDisabled,
                ]}
                onPress={takeSelfie}
                disabled={captureDisabled}
              >
                <View
                  style={[
                    styles.captureInner,
                    captureDisabled && styles.captureInnerDisabled,
                  ]}
                />
              </TouchableOpacity>
            </View>
          </View>

          {isProcessingFace && (
            <View style={styles.faceProcessingOverlay}>
              <ActivityIndicator size="large" color="#FFF" />
              <Text style={styles.faceProcessingText}>
                Memverifikasi wajah...
              </Text>
            </View>
          )}

          {/* DIAGNOSTIK SEMENTARA: lihat komentar di deklarasi debugPhotoUri.
              Dirender sebagai overlay di DALAM Modal kamera ini (bukan
              <Modal> terpisah) - dua <Modal> RN yang sama-sama visible di
              iOS tidak reliable (modal kedua bisa gagal tampil secara diam-
              diam), dan modal kamera ini sengaja tetap terbuka saat deteksi
              gagal supaya pengguna bisa langsung coba lagi. */}
          {!!debugPhotoUri && (
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "#000",
              }}
            >
              <Image
                source={{ uri: debugPhotoUri }}
                style={{ flex: 1 }}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={{ padding: 16, alignItems: "center" }}
                onPress={() => setDebugPhotoUri(null)}
              >
                <Text style={{ color: "#FFF", fontSize: 16 }}>Tutup</Text>
              </TouchableOpacity>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* Modal pendaftaran wajah (enrollment terpisah). Sengaja sebagai
          sibling dari modal kamera absen di atas - keduanya tidak akan pernah
          visible bersamaan: gate di handleOpenAttendanceCamera menjamin kamera
          absen hanya terbuka setelah enrollment selesai, dan dua <Modal> RN
          yang sama-sama visible di iOS tidak reliable (lihat catatan serupa
          di debug overlay modal kamera). */}
      <FaceEnrollmentModal
        visible={isEnrollmentVisible}
        onClose={() => setIsEnrollmentVisible(false)}
        onComplete={() => {
          setIsEnrollmentVisible(false);
          setHasEnrollment(true);
        }}
      />
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
    paddingBottom: 90,
  },
  glassShadow: {
    borderRadius: 28,
    marginBottom: 16,
    shadowColor: "#3A4B5C",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  profileCard: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.45)",
    padding: 18,
    borderRadius: 28,
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.65)",
  },
  profileImage: {
    width: 60,
    height: 60,
    borderRadius: 30,
    marginRight: 16,
    backgroundColor: "#EEE",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.8)",
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: "700",
    color: TEXT_PRIMARY,
    letterSpacing: 0.2,
  },
  profileNim: {
    fontSize: 13,
    color: TEXT_SECONDARY,
    marginVertical: 2,
  },
  profileMajor: {
    fontSize: 13,
    color: ACCENT,
    fontWeight: "600",
  },
  calendarCard: {
    backgroundColor: "rgba(255,255,255,0.45)",
    padding: 18,
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.65)",
  },
  monthNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  monthNavBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(120,130,150,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  monthTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: TEXT_PRIMARY,
    letterSpacing: 0.2,
  },
  weekDaysRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  weekDayText: {
    width: "14%",
    textAlign: "center",
    fontWeight: "600",
    color: TEXT_SECONDARY,
    fontSize: 12,
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayCell: {
    width: "14%",
    aspectRatio: 1,
    justifyContent: "center",
    alignItems: "center",
    marginVertical: 4,
  },
  // Lingkaran warna status di-inset dari sel supaya selalu terlihat sebagai
  // lingkaran terpisah, tidak menyatu jadi kotak/pil dengan tanggal sebelahnya.
  dayCircle: {
    width: "78%",
    height: "78%",
    borderRadius: 999,
    justifyContent: "center",
    alignItems: "center",
  },
  dayText: {
    fontSize: 14,
    color: TEXT_PRIMARY,
    fontWeight: "500",
  },
  statusSynced: { backgroundColor: "#AFC9F2" },
  statusUnsynced: { backgroundColor: "#F5DC94" },
  statusEmpty: { backgroundColor: "#F6C6C6" },
  statusToday: { backgroundColor: "#A6E3B8" },
  statusDemo: { backgroundColor: "#C9B6E4" },
  statusNone: { backgroundColor: "transparent" },

  attendanceButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: ACCENT,
    borderRadius: 18,
    paddingVertical: 14,
    marginTop: 18,
    shadowColor: ACCENT,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  attendanceButtonDisabled: {
    opacity: 0.6,
  },
  attendanceButtonText: {
    color: "#FFF",
    fontWeight: "700",
    fontSize: 14,
    marginLeft: 8,
    letterSpacing: 0.2,
  },
  attendanceHint: {
    textAlign: "center",
    fontSize: 12,
    color: TEXT_SECONDARY,
    marginTop: 8,
  },
  legendContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: "rgba(120,130,150,0.18)",
    paddingTop: 14,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    width: "50%",
    marginBottom: 8,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  legendText: {
    fontSize: 12,
    color: TEXT_SECONDARY,
  },
  warningText: {
    color: "#D32F2F",
    fontWeight: "700",
    textAlign: "center",
    marginTop: 12,
    fontSize: 13,
  },
  demoBadgeText: {
    color: "#B8860B",
    fontWeight: "700",
    textAlign: "center",
    marginTop: 12,
    fontSize: 12,
  },
  fabButton: {
    position: "absolute",
    right: 20,
    // Tab bar melayang di app/(tabs)/index.tsx menempati kira-kira
    // 14-76px dari bawah layar (bottom:14 + tinggi 62) - digeser ke atas
    // secukupnya supaya lolos, tapi tetap di pojok kanan bawah seperti biasa.
    bottom: 90,
    backgroundColor: ACCENT,
    width: 58,
    height: 58,
    borderRadius: 29,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 5,
  },
  modalLoadingOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingBox: {
    paddingVertical: 28,
    paddingHorizontal: 32,
    borderRadius: 24,
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: TEXT_PRIMARY,
  },
  faceProcessingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
  },
  faceProcessingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: "#FFF",
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: "#000",
    position: "relative",
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  cameraControls: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    padding: 20,
  },
  closeBtn: {
    alignSelf: "flex-end",
    marginTop: 10,
    borderRadius: 20,
    overflow: "hidden",
  },
  closeBtnBlur: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  cameraBottomArea: {
    alignItems: "center",
  },
  liveStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    overflow: "hidden",
    marginBottom: 18,
  },
  liveStatusText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  captureBtn: {
    alignSelf: "center",
    marginBottom: 30,
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: "#FFF",
    justifyContent: "center",
    alignItems: "center",
  },
  captureBtnDisabled: {
    borderColor: "rgba(255,255,255,0.35)",
  },
  captureInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#FFF",
  },
  captureInnerDisabled: {
    backgroundColor: "rgba(255,255,255,0.35)",
  },
});
