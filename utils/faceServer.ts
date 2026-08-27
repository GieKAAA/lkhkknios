import { apiGet, apiPostForm } from "./api";
import { DEMO_TOKEN } from "./demoMode";

/**
 * Sisi server untuk data wajah - mengikuti aplikasi Android resmi, yang
 * menyimpan wajah terdaftar di SERVER, bukan di HP.
 *
 * ASAL PENGETAHUAN INI (penting saat ada yang tidak cocok):
 * seluruh endpoint dan nama field di bawah direkonstruksi dari APK resmi
 * (`libapp.so`, Flutter AOT), bukan dari dokumentasi API - kita tidak punya
 * akses ke dokumentasinya. Yang benar-benar terlihat sebagai string literal
 * di dalam biner:
 *
 *   /api/face-data          /api/simpan-face-data
 *   /api/reset-wajah        /api/jumlah-reset        /api/max-reset
 *   face_data               reset_jumlah   reset_maksimum   reset_peserta_id
 *
 * Tabel sqflite lokal app Android, `reset(reset_peserta_id, reset_jumlah,
 * reset_maksimum)`, memperkuat bahwa jatah reset itu OTORITASNYA DI SERVER
 * dan cuma di-cache di perangkat - berbeda dengan port iOS ini yang semula
 * menghitungnya sendiri secara lokal.
 *
 * Yang TIDAK terlihat dari biner: bentuk persis payload-nya (kode Dart-nya
 * AOT-compiled, jadi string dump hanya memberi literal, bukan bagaimana
 * literal itu dirangkai). Jadi bentuk kiriman di bawah adalah tebakan
 * paling masuk akal: satu field `face_data` berisi JSON array-of-array
 * float. Kalau server menolak, PESAN ASLINYA ditampilkan ke pengguna dan
 * ikut dilempar lewat ApiError - itulah patokan untuk mengoreksi nama/bentuk
 * field di sini, pola yang sama seperti /api/simpan-lkh di LKHScreen.
 *
 * Pembacaan sengaja dibuat toleran (lihat parseEmbeddings): server bisa saja
 * mengembalikan array-of-array, satu array datar, atau string JSON.
 */

const PATH_FETCH = "/api/face-data";
const PATH_SAVE = "/api/simpan-face-data";
const PATH_RESET = "/api/reset-wajah";
const PATH_RESET_COUNT = "/api/jumlah-reset";
const PATH_RESET_MAX = "/api/max-reset";

/** Nama field payload wajah. Satu-satunya kandidat yang muncul di libapp.so. */
const FIELD_FACE_DATA = "face_data";

export interface ServerResetInfo {
  used: number;
  max: number;
}

/**
 * Mode demo memakai token lokal yang pasti ditolak server (lihat
 * demoMode.ts), jadi permintaannya dilewati sama sekali - bukan dikirim lalu
 * gagal. Tanpa ini setiap aksi wajah dalam mode demo menunggu timeout
 * jaringan tanpa guna.
 */
function isUsableSession(nim: string | null, token: string | null): boolean {
  return !!nim && !!token && token !== DEMO_TOKEN;
}

/**
 * Terima array-of-array (banyak wajah terdaftar), satu array datar (satu
 * wajah, gaya lama), atau string JSON berisi salah satunya. Nilai yang tidak
 * masuk akal dibuang, bukan diteruskan - embedding rusak yang lolos ke
 * pembanding menghasilkan "kemiripan NaN%" yang pernah terjadi sebelumnya.
 */
function parseEmbeddings(raw: unknown): number[][] | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length === 0) return null;

  const rows = typeof value[0] === "number" ? [value] : value;
  const clean: number[][] = [];
  for (const row of rows) {
    if (
      Array.isArray(row) &&
      row.length > 0 &&
      row.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      clean.push(row as number[]);
    }
  }
  return clean.length > 0 ? clean : null;
}

function pickFaceField(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    // Amplop {data:{face_data:...}} sudah dibongkar satu lapis oleh apiGet;
    // sisanya bisa saja langsung field-nya, atau objek yang memuatnya.
    if (FIELD_FACE_DATA in obj) return obj[FIELD_FACE_DATA];
    if ("encoding" in obj) return obj.encoding;
    if ("encodings" in obj) return obj.encodings;
  }
  return payload;
}

/**
 * Ambil set wajah terdaftar milik `nim` dari server.
 * - array embedding  -> server punya data
 * - null             -> server bisa dihubungi tapi belum ada wajah terdaftar
 * - lempar           -> server tidak bisa dihubungi / sesi habis; PEMANGGIL
 *                       WAJIB jatuh ke cache lokal, jangan anggap "kosong"
 *                       (menganggapnya kosong akan memaksa daftar ulang
 *                       setiap kali internet mati).
 */
export async function fetchServerEnrollment(
  nim: string | null,
  token: string | null,
): Promise<number[][] | null> {
  if (!isUsableSession(nim, token)) return null;
  const payload = await apiGet<unknown>(PATH_FETCH, token!, { nim: nim! });
  return parseEmbeddings(pickFaceField(payload));
}

/** Kirim set wajah terdaftar ke server (dipakai setelah enrollment selesai). */
export async function pushServerEnrollment(
  nim: string | null,
  token: string | null,
  embeddings: number[][],
): Promise<void> {
  if (!isUsableSession(nim, token)) {
    throw new Error("Sesi tidak tersedia untuk mengirim data wajah.");
  }
  await apiPostForm<unknown>(PATH_SAVE, token!, {
    nim: nim!,
    [FIELD_FACE_DATA]: JSON.stringify(embeddings),
  });
}

/**
 * Jatah reset menurut server. Dua endpoint terpisah di app Android
 * (/api/jumlah-reset dan /api/max-reset) - keduanya diambil sekaligus dan
 * kegagalan salah satunya membatalkan keduanya, supaya tidak pernah muncul
 * kombinasi setengah-server-setengah-lokal yang menyesatkan.
 */
export async function fetchServerResetInfo(
  nim: string | null,
  token: string | null,
): Promise<ServerResetInfo | null> {
  if (!isUsableSession(nim, token)) return null;
  const [countRaw, maxRaw] = await Promise.all([
    apiGet<unknown>(PATH_RESET_COUNT, token!, { nim: nim! }),
    apiGet<unknown>(PATH_RESET_MAX, token!, { nim: nim! }),
  ]);

  const num = (payload: unknown, ...keys: string[]): number | null => {
    if (typeof payload === "number") return payload;
    if (typeof payload === "string" && payload.trim() !== "") {
      const parsed = Number(payload);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (payload && typeof payload === "object") {
      for (const key of keys) {
        const found = num((payload as Record<string, unknown>)[key]);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const used = num(countRaw, "reset_jumlah", "jumlah", "jumlah_reset");
  const max = num(maxRaw, "reset_maksimum", "maksimum", "max_reset");
  if (used === null || max === null) return null;
  return { used, max };
}

/** Minta server menghapus wajah terdaftar dan menambah hitungan reset. */
export async function requestServerReset(
  nim: string | null,
  token: string | null,
): Promise<void> {
  if (!isUsableSession(nim, token)) {
    throw new Error("Sesi tidak tersedia untuk reset wajah.");
  }
  await apiPostForm<unknown>(PATH_RESET, token!, { nim: nim! });
}
