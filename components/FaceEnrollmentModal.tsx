import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from "react-native-vision-camera";
import { Camera as FaceDetectorCamera } from "react-native-vision-camera-face-detector";
import {
  ENROLLMENT_CONSISTENCY_MIN,
  faceSimilarity,
  FACE_DETECTOR_OPTIONS,
  getFaceEmbedding,
  MultipleFacesDetectedError,
  NoFaceDetectedError,
  PoorQualityFaceError,
} from "../utils/faceAuthNative";
import {
  MAX_ENROLLMENT_PHOTOS,
  MIN_ENROLLMENT_PHOTOS,
  saveEnrollment,
} from "../utils/faceEnrollment";
import { useFaceQualityGate } from "../hooks/useFaceQualityGate";

interface CaptureSlot {
  embedding: Float32Array;
  photoUri: string;
}

interface FaceEnrollmentModalProps {
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
}

// Satu saran pose/ekspresi per slot - variasi inilah gunanya multi-foto:
// set embedding mencakup kondisi berbeda sehingga verifikasi harian tetap
// cocok meski pencahayaan/pose sedikit berubah. Karena variasi ini sengaja
// menurunkan similarity antar-capture, cross-check di handleCapture memakai
// ENROLLMENT_CONSISTENCY_MIN yang longgar (lihat komentar konstanta itu di
// faceAuthNative.ts) - tugasnya menangkap pergantian orang, bukan menegakkan
// konsistensi.
const CAPTURE_PROMPTS = [
  "Hadapkan wajah lurus ke kamera",
  "Ekspresi wajah santai / senyum tipis",
  "Sedikit menoleh ke kiri",
  "Sedikit menoleh ke kanan",
  "Terakhir - posisi/cahaya sedikit berbeda",
];

export default function FaceEnrollmentModal({
  visible,
  onClose,
  onComplete,
}: FaceEnrollmentModalProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice("front");
  const qualityGate = useFaceQualityGate();
  // Resolusi sama dengan kamera absensi (LKHScreen) - alasan yang sama:
  // rasio 9:16 mendekati bentuk preview, dan jauh melampaui input
  // MobileFaceNet yang cuma 112x112.
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.FHD_16_9,
  });

  const [captures, setCaptures] = useState<CaptureSlot[]>([]);
  const [isProcessingFace, setIsProcessingFace] = useState(false);

  // Sesi selalu mulai kosong tiap modal dibuka - keluar di tengah jalan
  // berarti membuang seluruh capture sesi itu (desain: tidak ada resume
  // parsial; enrollment hanya valid kalau lengkap).
  useEffect(() => {
    if (visible) {
      setCaptures([]);
      setIsProcessingFace(false);
    }
  }, [visible]);

  const captureDisabled =
    isProcessingFace || captures.length >= MAX_ENROLLMENT_PHOTOS;
  const canFinish =
    captures.length >= MIN_ENROLLMENT_PHOTOS && !isProcessingFace;
  const progressLabel =
    captures.length >= MAX_ENROLLMENT_PHOTOS
      ? `Semua ${MAX_ENROLLMENT_PHOTOS} foto terisi - tekan Selesai`
      : `Foto ${captures.length + 1}: ${
          CAPTURE_PROMPTS[Math.min(captures.length, CAPTURE_PROMPTS.length - 1)]
        }`;

  const handleCapture = async () => {
    if (captureDisabled) return;
    setIsProcessingFace(true);
    try {
      const photoFile = await photoOutput.capturePhotoToFile({}, {});
      // capturePhotoToFile() mengembalikan path filesystem polos, bukan URI
      // file:// (pola sama dengan takeSelfie di LKHScreen).
      const photoUri = `file://${photoFile.filePath}`;

      // Hard gate yang sama persis dengan jalur verifikasi: deteksi wajah +
      // qualityGate() + cropAlignResize + inferensi, semua di dalam
      // getFaceEmbedding(). Gagal di sini tidak menghabiskan slot apa pun.
      const embedding = await getFaceEmbedding(photoUri);

      if (captures.length > 0) {
        const bestInSession = Math.max(
          ...captures.map((c) => faceSimilarity(c.embedding, embedding)),
        );
        if (bestInSession < ENROLLMENT_CONSISTENCY_MIN) {
          Alert.alert(
            "Wajah Berbeda Terdeteksi",
            "Foto ini terlihat seperti orang yang berbeda dari foto sebelumnya. Pastikan Anda sendiri yang ada di frame dari foto pertama sampai terakhir.",
          );
          return;
        }
      }

      setCaptures((prev) => [...prev, { embedding, photoUri }]);
    } catch (error) {
      if (error instanceof NoFaceDetectedError) {
        Alert.alert("Wajah Tidak Terdeteksi", error.message);
      } else if (error instanceof MultipleFacesDetectedError) {
        Alert.alert("Wajah Lebih dari Satu", error.message);
      } else if (error instanceof PoorQualityFaceError) {
        Alert.alert("Foto Kurang Jelas", error.message);
      } else if (error instanceof Error) {
        Alert.alert("Pendaftaran Wajah Gagal", error.message);
      } else {
        Alert.alert("Error", "Gagal memproses wajah. Coba lagi.");
      }
    } finally {
      setIsProcessingFace(false);
    }
  };

  const handleFinish = async () => {
    if (!canFinish) return;
    setIsProcessingFace(true);
    try {
      const outcome = await saveEnrollment(
        captures.map((c) => c.embedding),
        captures.map((c) => c.photoUri),
      );
      onComplete();
      // Wajah terdaftar disimpan di server (lihat utils/faceEnrollment.ts).
      // Kalau kiriman gagal, enrollment TIDAK dibatalkan - sudah tersimpan
      // lokal dan absen bisa langsung jalan - tapi pengguna perlu tahu
      // datanya belum aman di server supaya tidak kaget kalau hilang saat
      // ganti perangkat.
      if (outcome === "pending") {
        Alert.alert(
          "Tersimpan di Perangkat",
          "Wajah Anda sudah terdaftar dan bisa langsung dipakai absen. Namun data belum terkirim ke server (koneksi bermasalah atau sesi kadaluarsa) - akan dikirim otomatis saat aplikasi dibuka kembali dengan koneksi yang baik.",
        );
      }
    } catch (error) {
      console.error("Gagal menyimpan enrollment wajah", error);
      Alert.alert(
        "Error",
        "Gagal menyimpan data wajah. Periksa penyimpanan perangkat lalu coba lagi.",
      );
      setIsProcessingFace(false); // modal dibiarkan terbuka supaya bisa retry
    }
  };

  return (
    <Modal visible={visible} animationType="slide">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={onClose}
            disabled={isProcessingFace}
          >
            <BlurView intensity={50} tint="dark" style={styles.closeBtnBlur}>
              <Ionicons name="close" size={24} color="#FFF" />
            </BlurView>
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.title}>Daftarkan Wajah</Text>
            <Text style={styles.subtitle}>
              Ambil {MIN_ENROLLMENT_PHOTOS}-{MAX_ENROLLMENT_PHOTOS} foto selfie
              sebagai patokan verifikasi absensi
            </Text>
          </View>
        </View>

        {hasPermission && cameraDevice ? (
          <FaceDetectorCamera
            style={styles.camera}
            device={cameraDevice}
            isActive={visible}
            outputs={[photoOutput]}
            onFacesDetected={qualityGate.onFacesDetected}
            onError={qualityGate.onFaceDetectionError}
            performanceMode="fast"
            runLandmarks={false}
            runClassifications={false}
            minFaceSize={FACE_DETECTOR_OPTIONS.minFaceSize}
          />
        ) : (
          <View style={[styles.camera, styles.permissionPane]}>
            <Text style={styles.permissionText}>
              {!hasPermission
                ? "Izin kamera dibutuhkan untuk mendaftarkan wajah."
                : "Kamera depan tidak ditemukan di perangkat ini."}
            </Text>
            {!hasPermission && (
              <TouchableOpacity
                style={styles.permissionBtn}
                onPress={() => {
                  requestPermission();
                }}
              >
                <Text style={styles.permissionBtnText}>Berikan Izin</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.bottomArea} pointerEvents="box-none">
          <BlurView intensity={50} tint="dark" style={styles.statusPill}>
            <Text style={styles.statusText}>{qualityGate.message}</Text>
          </BlurView>
          <BlurView intensity={50} tint="dark" style={styles.promptPill}>
            <Text style={styles.promptText}>{progressLabel}</Text>
          </BlurView>

          <View style={styles.slotsRow}>
            {Array.from({ length: MAX_ENROLLMENT_PHOTOS }, (_, i) => (
              <View
                key={i}
                style={[styles.slot, i < captures.length && styles.slotFilled]}
              >
                {captures[i] ? (
                  <Image
                    source={{ uri: captures[i].photoUri }}
                    style={styles.slotImage}
                  />
                ) : (
                  <Text style={styles.slotIndex}>{i + 1}</Text>
                )}
              </View>
            ))}
          </View>

          <View style={styles.controlsRow}>
            <View style={styles.sideSlot}>
              {canFinish && (
                <TouchableOpacity style={styles.finishBtn} onPress={handleFinish}>
                  <Ionicons name="checkmark" size={16} color="#FFF" />
                  <Text style={styles.finishBtnText}>
                    Selesai ({captures.length})
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[
                styles.captureBtn,
                captureDisabled && styles.captureBtnDisabled,
              ]}
              onPress={handleCapture}
              disabled={captureDisabled}
            >
              <View
                style={[
                  styles.captureInner,
                  captureDisabled && styles.captureInnerDisabled,
                ]}
              />
            </TouchableOpacity>
            <View style={styles.sideSlot} />
          </View>
        </View>

        {isProcessingFace && (
          <View style={styles.processingOverlay}>
            <ActivityIndicator size="large" color="#FFF" />
            <Text style={styles.processingText}>Memproses wajah...</Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const ACCENT = "#0E783D";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
  },
  closeBtnBlur: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextWrap: {
    flex: 1,
    marginLeft: 12,
  },
  title: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "700",
  },
  subtitle: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    marginTop: 2,
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  permissionPane: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111",
  },
  permissionText: {
    color: "#FFF",
    fontSize: 15,
    textAlign: "center",
    marginHorizontal: 32,
  },
  permissionBtn: {
    marginTop: 16,
    backgroundColor: ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 22,
  },
  permissionBtnText: {
    color: "#FFF",
    fontWeight: "700",
  },
  bottomArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: 24,
  },
  statusPill: {
    overflow: "hidden",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  statusText: {
    color: "#FFF",
    fontSize: 13,
    fontWeight: "600",
  },
  promptPill: {
    overflow: "hidden",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginTop: 8,
  },
  promptText: {
    color: "#FFF",
    fontSize: 13,
    fontWeight: "700",
  },
  slotsRow: {
    flexDirection: "row",
    marginTop: 14,
  },
  slot: {
    width: 46,
    height: 46,
    borderRadius: 12,
    marginHorizontal: 4,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.5)",
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  slotFilled: {
    borderColor: ACCENT,
  },
  slotImage: {
    width: "100%",
    height: "100%",
  },
  slotIndex: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 16,
    fontWeight: "700",
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 18,
  },
  sideSlot: {
    width: 110,
    alignItems: "flex-start",
  },
  finishBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ACCENT,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  finishBtnText: {
    color: "#FFF",
    fontWeight: "700",
    marginLeft: 5,
  },
  captureBtn: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
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
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  processingText: {
    color: "#FFF",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 12,
  },
});
