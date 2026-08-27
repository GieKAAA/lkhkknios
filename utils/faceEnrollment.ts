import AsyncStorage from "@react-native-async-storage/async-storage";
import { CALIBRATION_LOG_KEY, faceSimilarity } from "./faceAuthNative";
import {
  fetchServerEnrollment,
  fetchServerResetInfo,
  pushServerEnrollment,
  requestServerReset,
} from "./faceServer";

/**
 * Penyimpanan & verifikasi untuk alur enrollment terpisah
 * (components/FaceEnrollmentModal.tsx). Modul ini hanya mengurus
 * persistensi + perbandingan + migrasi; ia mengimpor dari faceAuthNative,
 * tidak pernah sebaliknya, supaya pipeline tetap bisa diuji tanpa storage.
 *
 * MODEL PENYIMPANAN - SERVER SUMBER KEBENARAN, LOKAL SEBAGAI CACHE.
 * Ini mengikuti aplikasi Android resmi, yang menyimpan wajah terdaftar di
 * server lewat /api/simpan-face-data dan membacanya lewat /api/face-data
 * (lihat utils/faceServer.ts untuk asal pengetahuan itu). Sebelumnya port
 * iOS ini murni lokal, yang berarti wajah terdaftar hilang saat ganti atau
 * instal ulang perangkat, dan jatah reset bisa diakali cukup dengan
 * membersihkan data aplikasi.
 *
 * Lokal tidak dibuang, hanya turun pangkat jadi cache. Alasannya wajib:
 * absen harus tetap jalan tanpa internet di posko, dan akun KKN yang
 * periodenya sudah lewat tidak bisa lagi menghubungi server sama sekali
 * (lihat utils/demoMode.ts). Aturannya:
 *
 *   - Server terbaca berisi  -> cache lokal ditimpa isi server.
 *   - Server terbaca kosong  -> data lokal justru DIKIRIM ke server
 *                               (self-healing; kita satu-satunya penulis).
 *   - Server tak terjangkau  -> pakai cache lokal apa adanya. JANGAN pernah
 *                               menganggapnya "belum terdaftar", karena itu
 *                               memaksa daftar ulang tiap internet mati.
 *
 * Enrollment yang belum sempat terkirim ditandai PENDING_PUSH_KEY dan dicoba
 * lagi tiap syncEnrollmentFromServer() jalan - pola yang sama dengan laporan
 * LKH berstatus "unsynced" di LKHScreen.
 *
 * Bentuk cache lokal ("@face_enrollment_v3", JSON):
 *   { version: 3, createdAt: number, embeddings: number[][], photos: string[] }
 */

export const MIN_ENROLLMENT_PHOTOS = 3;
export const MAX_ENROLLMENT_PHOTOS = 5;

const ENROLLMENT_KEY = "@face_enrollment_v3";

// Sengaja memakai key yang SAMA dengan pipeline referensi-tunggal lama, agar
// pengguna yang sudah memakai sebagian jatah resetnya tidak dapat jatah baru.
// Sejak jatah reset diambil dari server, nilai ini turun peran jadi cadangan
// saat server tidak terjangkau.
const RESET_COUNT_KEY = "@face_reference_reset_count";
export const MAX_FACE_RESETS = 3;

const PENDING_PUSH_KEY = "@face_enrollment_pending_push";

// Key v2 (satu embedding) dari pipeline lama. Dimigrasi sekali ke v3 lalu
// dihapus supaya tidak pernah bisa membayangi atau memecah state lagi.
const LEGACY_EMBEDDING_KEY = "@face_reference_embedding_v2";
const LEGACY_PHOTO_KEY = "@face_reference_photo_v2";

interface StoredEnrollment {
  version: 3;
  createdAt: number;
  embeddings: number[][];
  photos: string[];
}

export type SyncOutcome = "updated" | "pushed" | "pending" | "unavailable";

let migrationDone = false;

async function getSession(): Promise<{ nim: string | null; token: string | null }> {
  const [nim, token] = await Promise.all([
    AsyncStorage.getItem("@user_nim"),
    AsyncStorage.getItem("@user_token"),
  ]);
  return { nim, token };
}

function parseEnrollment(raw: string | null): StoredEnrollment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredEnrollment;
    if (
      parsed?.version !== 3 ||
      !Array.isArray(parsed.embeddings) ||
      parsed.embeddings.length === 0 ||
      !parsed.embeddings.every(
        (e) => Array.isArray(e) && e.length > 0 && e.every(Number.isFinite),
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeLocalEnrollment(
  embeddings: number[][],
  photos: string[],
): Promise<void> {
  const enrollment: StoredEnrollment = {
    version: 3,
    createdAt: Date.now(),
    embeddings,
    photos,
  };
  await AsyncStorage.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
}

/**
 * Migrasi lunak (keputusan desain: BUKAN paksa daftar ulang): instalasi yang
 * masih menyimpan referensi tunggal lama dibungkus jadi set v3 berisi satu
 * elemen. max-of-1 identik secara numerik dengan perbandingan lama, jadi
 * pengguna hasil migrasi tetap bisa absen di tengah periode KKN. Idempoten,
 * jalan paling banyak sekali per sesi aplikasi.
 */
async function migrateLegacyV2Once(): Promise<void> {
  if (migrationDone) return;
  try {
    const raw = await AsyncStorage.getItem(LEGACY_EMBEDDING_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const usable =
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((v) => typeof v === "number" && Number.isFinite(v));
      if (
        usable &&
        parseEnrollment(await AsyncStorage.getItem(ENROLLMENT_KEY)) === null
      ) {
        const photoUri = await AsyncStorage.getItem(LEGACY_PHOTO_KEY);
        await writeLocalEnrollment(
          [parsed as number[]],
          photoUri ? [photoUri] : [],
        );
        // Hasil migrasi belum pernah dikenal server - antrekan untuk dikirim.
        await AsyncStorage.setItem(PENDING_PUSH_KEY, "1");
      }
      await AsyncStorage.multiRemove([LEGACY_EMBEDDING_KEY, LEGACY_PHOTO_KEY]);
    }
  } catch {
    // Best-effort: nilai lama yang rusak berarti pengguna itu mendaftar ulang
    // lewat modal. Jangan pernah memblokir karena migrasi.
  }
  migrationDone = true;
}

async function readLocalEnrollment(): Promise<StoredEnrollment | null> {
  await migrateLegacyV2Once();
  return parseEnrollment(await AsyncStorage.getItem(ENROLLMENT_KEY));
}

export async function isEnrolled(): Promise<boolean> {
  return (await readLocalEnrollment()) !== null;
}

/** Semua embedding terdaftar, atau null kalau belum terdaftar. */
export async function getEnrollments(): Promise<Float32Array[] | null> {
  const stored = await readLocalEnrollment();
  if (!stored) return null;
  return stored.embeddings.map((e) => Float32Array.from(e));
}

/**
 * Selaraskan cache lokal dengan server. Panggil saat aplikasi terbuka.
 * Tidak pernah melempar - gagal jaringan adalah kondisi normal di sini, dan
 * hasilnya cukup dilaporkan lewat nilai balik.
 */
export async function syncEnrollmentFromServer(): Promise<SyncOutcome> {
  await migrateLegacyV2Once();
  const { nim, token } = await getSession();

  try {
    const remote = await fetchServerEnrollment(nim, token);
    if (remote) {
      const local = await readLocalEnrollment();
      await writeLocalEnrollment(remote, local?.photos ?? []);
      await AsyncStorage.removeItem(PENDING_PUSH_KEY);
      return "updated";
    }
    // Server terjangkau tapi belum punya wajah untuk akun ini. Kalau ada
    // salinan lokal, kirim - jangan hapus lokalnya.
    const local = await readLocalEnrollment();
    if (local) {
      await pushServerEnrollment(nim, token, local.embeddings);
      await AsyncStorage.removeItem(PENDING_PUSH_KEY);
      return "pushed";
    }
    return "updated";
  } catch {
    const local = await readLocalEnrollment();
    if (local && (await AsyncStorage.getItem(PENDING_PUSH_KEY))) return "pending";
    return "unavailable";
  }
}

/**
 * Simpan hasil enrollment: cache lokal dulu (supaya absen langsung bisa
 * dipakai walau offline), baru dikirim ke server. Kegagalan kiriman tidak
 * membatalkan enrollment - ditandai untuk dicoba lagi nanti.
 */
export async function saveEnrollment(
  embeddings: Float32Array[],
  photoUris: string[],
): Promise<SyncOutcome> {
  if (embeddings.length === 0) {
    throw new Error("Tidak ada data wajah untuk disimpan.");
  }
  const plain = embeddings.map((e) => Array.from(e));
  await writeLocalEnrollment(plain, photoUris);

  const { nim, token } = await getSession();
  try {
    await pushServerEnrollment(nim, token, plain);
    await AsyncStorage.removeItem(PENDING_PUSH_KEY);
    return "pushed";
  } catch {
    await AsyncStorage.setItem(PENDING_PUSH_KEY, "1");
    return "pending";
  }
}

/**
 * Kemiripan kosinus TERTINGGI antara `query` dan setiap embedding terdaftar.
 * Null kalau belum ada yang terdaftar: pemanggil wajib memperlakukannya
 * sebagai "belum terdaftar", bukan sebagai skor 0.
 */
export async function bestSimilarityToEnrollment(
  query: Float32Array | number[],
): Promise<number | null> {
  const enrolled = await getEnrollments();
  if (!enrolled || enrolled.length === 0) return null;
  let best = -Infinity;
  for (const reference of enrolled) {
    const similarity = faceSimilarity(query, reference);
    if (similarity > best) best = similarity;
  }
  return best;
}

export async function clearEnrollment(): Promise<void> {
  await AsyncStorage.multiRemove([ENROLLMENT_KEY, PENDING_PUSH_KEY]);
}

async function getLocalResetCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(RESET_COUNT_KEY);
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface ResetQuota {
  remaining: number;
  max: number;
  /** True kalau angkanya dari server; false kalau dari cadangan lokal. */
  fromServer: boolean;
}

/**
 * Jatah reset. Server yang berwenang (app Android memakai /api/jumlah-reset
 * dan /api/max-reset); hitungan lokal hanya dipakai saat server tidak
 * terjangkau, dan ikut disegarkan tiap kali server berhasil dibaca.
 */
export async function getResetQuota(): Promise<ResetQuota> {
  const { nim, token } = await getSession();
  try {
    const info = await fetchServerResetInfo(nim, token);
    if (info) {
      await AsyncStorage.setItem(RESET_COUNT_KEY, String(info.used));
      return {
        remaining: Math.max(0, info.max - info.used),
        max: info.max,
        fromServer: true,
      };
    }
  } catch {
    // jatuh ke cadangan lokal di bawah
  }
  return {
    remaining: Math.max(0, MAX_FACE_RESETS - (await getLocalResetCount())),
    max: MAX_FACE_RESETS,
    fromServer: false,
  };
}

export async function getRemainingFaceResets(): Promise<number> {
  return (await getResetQuota()).remaining;
}

/**
 * Hapus SELURUH set wajah terdaftar sehingga pengguna harus mengulang
 * enrollment 3-5 foto sebelum bisa absen lagi. Dibatasi jatah reset supaya
 * tidak bisa dipakai berulang untuk menukar wajah orang lain. Mengembalikan
 * false kalau jatahnya sudah habis (data dibiarkan utuh).
 */
export async function resetEnrollment(): Promise<boolean> {
  const { nim, token } = await getSession();

  try {
    const info = await fetchServerResetInfo(nim, token);
    if (info) {
      if (info.used >= info.max) return false;
      await requestServerReset(nim, token);
      await clearEnrollment();
      await AsyncStorage.setItem(RESET_COUNT_KEY, String(info.used + 1));
      return true;
    }
  } catch {
    // Server menolak atau tak terjangkau - pakai jatah lokal supaya reset
    // tetap mungkin saat offline / akun sudah tidak aktif.
  }

  const count = await getLocalResetCount();
  if (count >= MAX_FACE_RESETS) return false;
  await clearEnrollment();
  await AsyncStorage.setItem(RESET_COUNT_KEY, String(count + 1));
  return true;
}

/** Hapus seluruh state verifikasi wajah lokal, misalnya saat ganti akun. */
export async function clearAllFaceData(): Promise<void> {
  await AsyncStorage.multiRemove([
    ENROLLMENT_KEY,
    PENDING_PUSH_KEY,
    LEGACY_EMBEDDING_KEY,
    LEGACY_PHOTO_KEY,
    RESET_COUNT_KEY,
    CALIBRATION_LOG_KEY,
  ]);
}
