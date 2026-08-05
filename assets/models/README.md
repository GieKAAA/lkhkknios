# Model wajah (MobileFaceNet, TFLite)

Folder ini berisi model yang dipakai `utils/faceAuthNative.ts` untuk
verifikasi wajah saat absen:

| File | Fungsi | Ukuran |
|---|---|---|
| `mobilefacenet.tflite` | Deteksi wajah (via ML Kit, native) + embedding wajah (192 dimensi) | ~5.0 MB |

Format **TensorFlow Lite**, dijalankan lewat `react-native-fast-tflite`
(Nitro Modules, native) - **tidak** kompatibel Expo Go, butuh custom dev
client / build native (lihat catatan build di root project).

## Sumber & provenance

`mobilefacenet.tflite` **diekstrak dari APK aplikasi Android resmi LKH KKN
UIN Alauddin** (bukan diunduh dari repositori model publik seperti
blazeface.json/faceres.json versi TFJS sebelumnya - lihat riwayat git untuk
model itu kalau masih perlu dirujuk). Berdasarkan nama tensor internalnya
(`MobileFaceNet/.../InvResBlock_*`, `input` → `embeddings`, tanpa
`l2_normalize`, tanpa op quantize/dequantize), arsitekturnya konsisten
dengan implementasi **sirius-ai/MobileFaceNet_TF**
(https://github.com/sirius-ai/MobileFaceNet_TF) yang dikonversi ke TFLite.

**Penting untuk laporan skripsi**: karena file ini diekstrak dari aplikasi
pihak lain (bukan dilatih ulang atau diunduh dari sumber model publik
dengan lisensi eksplisit), cantumkan provenance ini secara jujur di
laporan/lampiran - misalnya bahwa model deteksi wajah yang dipakai berasal
dari APK aplikasi resmi kampus yang sudah digunakan pada platform Android,
diekstrak untuk keperluan interoperabilitas (verifikasi terhadap sistem
absensi yang sama), bukan diklaim sebagai model buatan sendiri. Diskusikan
dengan dosen pembimbing apakah ini perlu izin/disclosure tambahan.

## Spesifikasi yang dibutuhkan kode ini

- Input: `[1, 112, 112, 3]` float32, urutan channel RGB, dinormalisasi
  `(pixel - 127.5) / 128` (lihat `utils/faceAuthNative.ts`).
- Output: `[1, 192]` float32 - embedding mentah, **belum** di-L2-normalize
  oleh model (dilakukan manual setelah inferensi).
- Metrik pembanding: cosine similarity antar embedding yang sudah
  di-L2-normalize (lihat `faceSimilarity()`).

## Jika perlu ganti model

File ini boleh ditimpa dengan model MobileFaceNet/ArcFace-style TFLite lain
selama format input `[1,112,112,3]` float32 dan output `[.., 192]` (atau
dimensi lain - kode membaca panjang output apa adanya, tidak di-hardcode ke
192) float32 terpenuhi. `metro.config.js` sudah menambahkan `tflite`
sebagai `assetExt` supaya file ini ikut terbundel oleh Metro.
