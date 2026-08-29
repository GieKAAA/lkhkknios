import { useCallback, useRef, useState } from "react";
import type { Face } from "react-native-vision-camera-face-detector";
import { MIN_FACE_SIZE_RATIO } from "../utils/faceAuthNative";

/**
 * Deteksi keaktifan (liveness) berbasis TANTANGAN GERAK, untuk mencegah
 * titip-absen dengan foto/layar.
 *
 * MASALAH YANG DITUTUP: verifikasi wajah hanya menjawab "apakah ini wajah
 * yang benar?", bukan "apakah wajah HIDUP yang hadir sekarang?". Foto statis
 * milik orang terdaftar yang dihadapkan ke kamera lolos begitu saja - sudah
 * diuji dan memang berhasil. Tantangan gerak menuntut sesuatu yang foto
 * statis tidak bisa lakukan: menoleh ke dua sisi berlawanan atas perintah.
 *
 * KENAPA GERAK KEPALA, BUKAN KEDIP. Deteksi kedip butuh probabilitas mata,
 * yang hanya muncul saat `runClassifications` menyala di stream live. Kamera
 * live di aplikasi ini sengaja mematikannya (workaround crash SIGSEGV saat
 * kamera dibuka - lihat komentar di LKHScreen). Sudut `yawAngle` tetap
 * tersedia tanpa mode itu - quality gate live sudah membacanya dan terbukti
 * jalan - jadi head-turn menutup serangan tanpa menyalakan ulang mode yang
 * bikin crash.
 *
 * BATAS YANG DIAKUI: ini menghentikan FOTO/LAYAR STATIS, bukan pemutaran
 * VIDEO wajah orang yang sedang menoleh. Menahan video butuh model anti-spoof
 * pasif (analisis tekstur/moire) - di luar cakupan tantangan gerak ini.
 *
 * SIGN-CONVENTION AMAN: arah yaw positif/negatif bergantung konvensi ML Kit +
 * mirror kamera depan, yang tidak bisa diverifikasi tanpa perangkat. Maka
 * tantangan ini TIDAK memberi label kiri/kanan yang bisa salah: cukup "toleh
 * ke satu sisi", lalu "toleh ke sisi sebaliknya" - diterima arah mana pun
 * asal keduanya berlawanan dan melewati tengah. Tetap mustahil dipenuhi foto
 * diam, dan tidak bisa menyesatkan pengguna ke arah yang keliru.
 */

// Ambang magnitudo yaw untuk dihitung sebagai "menoleh". Di bawah MAX_YAW_DEG
// (25, batas quality gate saat menjepret), jadi setelah lolos tantangan
// pengguna cukup menghadap tengah lagi untuk mengambil foto.
const TURN_DEG = 20;
// Harus kembali ke dalam rentang ini sebelum tolehan kedua dihitung -
// membuktikan gerakan nyata bolak-balik, bukan satu pose yang ditahan.
const CENTER_DEG = 10;

type Phase = "first-turn" | "return-center" | "second-turn" | "passed";

const MSG = {
  frame: "Posisikan wajah Anda di dalam bingkai",
  near: "Dekatkan wajah Anda ke kamera",
  first: "Tolehkan kepala perlahan ke satu sisi",
  center: "Bagus - hadapkan lagi ke tengah",
  second: "Sekarang toleh ke sisi sebaliknya",
  passed: "Deteksi aktif berhasil - silakan ambil foto",
} as const;

export function useLivenessChallenge() {
  // State mesin disimpan di ref, bukan useState: onFacesDetected dipanggil
  // per frame dan harus stabil (tidak dibuat ulang tiap render), jadi ia
  // tidak boleh menutup nilai state yang bisa basi. useState hanya untuk
  // nilai yang benar-benar dirender.
  const phaseRef = useRef<Phase>("first-turn");
  const firstSignRef = useRef<-1 | 0 | 1>(0);

  const [passed, setPassed] = useState(false);
  const [instruction, setInstruction] = useState<string>(MSG.first);
  const [step, setStep] = useState(0);

  const reset = useCallback(() => {
    phaseRef.current = "first-turn";
    firstSignRef.current = 0;
    setPassed(false);
    setStep(0);
    setInstruction(MSG.first);
  }, []);

  const onFacesDetected = useCallback((faces: Face[]) => {
    if (phaseRef.current === "passed") return;

    if (!faces || faces.length === 0) {
      setInstruction(MSG.frame);
      return;
    }
    if (faces.length > 1) {
      setInstruction("Terdeteksi lebih dari satu wajah");
      return;
    }
    const face = faces[0];
    if (face.bounds.width / face.frameWidth < MIN_FACE_SIZE_RATIO) {
      setInstruction(MSG.near);
      return;
    }

    const yaw = face.yawAngle;

    switch (phaseRef.current) {
      case "first-turn":
        if (Math.abs(yaw) >= TURN_DEG) {
          firstSignRef.current = yaw >= 0 ? 1 : -1;
          phaseRef.current = "return-center";
          setStep(1);
          setInstruction(MSG.center);
        } else {
          setInstruction(MSG.first);
        }
        break;

      case "return-center":
        if (Math.abs(yaw) <= CENTER_DEG) {
          phaseRef.current = "second-turn";
          setInstruction(MSG.second);
        } else {
          setInstruction(MSG.center);
        }
        break;

      case "second-turn":
        // Harus melampaui ambang KE ARAH BERLAWANAN dari tolehan pertama.
        if (Math.abs(yaw) >= TURN_DEG && (yaw >= 0 ? 1 : -1) === -firstSignRef.current) {
          phaseRef.current = "passed";
          setStep(2);
          setPassed(true);
          setInstruction(MSG.passed);
        } else {
          setInstruction(MSG.second);
        }
        break;
    }
  }, []);

  return { passed, instruction, step, total: 2, onFacesDetected, reset };
}
