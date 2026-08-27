# Kalibrasi preprocessing & threshold wajah

Alat ini menjawab satu pertanyaan yang tidak bisa dijawab dari dalam
aplikasi: **kombinasi preprocessing mana yang benar, dan di angka berapa
`FACE_MATCH_THRESHOLD` seharusnya dipasang.**

## Kenapa perlu

Model `mobilefacenet.tflite` di repo ini **byte-identik** dengan yang ada di
dalam APK aplikasi Android resmi (md5 `7945c78f4484c99560df461df85baa2f`).
Jadi modelnya tidak perlu dikonversi sama sekali.

Yang tidak ikut terbawa adalah keputusan di sekelilingnya — margin crop,
alignment, interpolasi resize, konstanta normalisasi, urutan channel, dan
threshold. Semua itu tidak bisa dibaca dari APK karena kode Dart-nya
AOT-compiled: string dump hanya memberi literal, bukan aritmetikanya.

Masalahnya, preprocessing yang meleset **tidak memunculkan error**. Model
tetap mengeluarkan embedding; hanya daya pisahnya yang rusak, sehingga
distribusi "wajah sendiri" dan "wajah orang lain" saling tumpang tindih.
Gejalanya persis keluhan yang sedang diperbaiki: wajah orang lain bisa lolos
absen.

## Yang sudah terverifikasi

Model ini **sudah me-L2-normalize keluarannya sendiri** (‖y‖ = 1.0 untuk
setiap input yang diuji). Konsekuensinya, cosine similarity dan Euclidean
distance hanyalah dua skala dari besaran yang sama:

```
d² = 2 − 2·cos        cos = 1 − d²/2
```

Keduanya memberi peringkat identik. Jadi threshold gaya "distance" milik
Android dan gaya "cosine" milik iOS bisa saling diterjemahkan — kolom `d_eq`
pada laporan menampilkan padanan Euclidean dari threshold yang disarankan.

## Hasil kalibrasi 2026-08-27

Data: 19 foto pemilik (dua sesi terpisah) + 5 orang lain. Tidak ada pasangan
nyaris identik, jadi variasi genuine-nya nyata.

### Temuan utama: model ini butuh alignment kanonik, bukan crop bbox

MobileFaceNet lineage ini dilatih atas wajah yang sudah di-warp ke template
5-titik ArcFace, bukan atas "kotak deteksi yang dilebarkan sekian rasio".
Memberi crop bbox tidak memunculkan error — model tetap mengeluarkan
embedding — tapi ruang embedding-nya kolaps. Kemiripan antara orang-orang
yang **jelas berbeda**:

| Preprocessing | beda orang (rata²) | terburuk | sesama pemilik (rata²) |
|---|---|---|---|
| crop bbox rasio 1.3 (versi lama) | 0.656 | 0.748 | 0.763 |
| crop bbox rasio 2.0 | 0.528 | 0.690 | 0.750 |
| **alignment kanonik** | **0.338** | **0.500** | **0.805** |

Dengan crop bbox, skor impostor terburuk (0.748) **melampaui** skor genuine
terburuk (0.423) — tidak ada ambang mana pun yang bisa memisahkan keduanya.
Itulah sebab sebenarnya wajah orang lain bisa lolos absen; bukan soal
normalisasi, bukan soal angka ambang.

Setelah alignment diperbaiki, sapuan penuh 80 varian memberi **d′ 6.37,
EER 0.00%, akurasi 100%** (sebelumnya d′ 2.64, EER 11.4%).

### Faktor lain

| Faktor | Hasil |
|---|---|
| Normalisasi | `(x-128)/128` ≈ `(x-127.5)/128` ≈ `(x-127.5)/127.5` — setara; `x/255` lebih buruk |
| Channel | RGB jelas mengungguli BGR |
| Skala template | 1.0 dan 1.1 praktis seri (6.32 vs 6.37); dipakai 1.0 karena itu nilai kanonik |
| Rotasi leveling | pengaruh kecil (6.32 vs 6.17) — tetap dipakai karena benar secara teori dan gratis |

Jadi normalisasi dan urutan channel di aplikasi memang **sudah benar sejak
awal**.

### Strategi penggabungan & ambang

Validasi silang 400 subset enrollment acak (ukuran 3–5, kedua arah sesi),
dengan alignment kanonik — **semua strategi lolos 400/400 tanpa tumpang
tindih**. Yang membedakan adalah jarak kasus-terburuk:

| strategi | genuine terburuk | impostor terburuk | jarak |
|---|---|---|---|
| max | 0.579 | 0.422 | +0.157 |
| top2 | 0.572 | 0.398 | +0.174 |
| mean | 0.562 | 0.380 | +0.182 |
| **median** | 0.565 | **0.374** | **+0.191** |

Dipakai **median**, dan `FACE_MATCH_THRESHOLD = 0.47` — titik tengah jarak
kasus-terburuk itu, sehingga kedua jenis kesalahan punya ruang aman setara
(~0.10 masing-masing).

Angka ini jauh di bawah 0.6 yang dipakai sebelumnya, dan itu wajar: ambang
lama dikalibrasi atas embedding hasil crop bbox, tempat semua wajah
berskor tinggi terhadap semua wajah. Ambang dari pipeline lama tidak berlaku
untuk pipeline baru.

### Batas keabsahan

Lima identitas impostor masih sedikit, dan empat di antaranya menyumbang satu
foto saja. Skor impostor terburuk adalah angka yang paling mungkin
diremehkan. Ulangi kalibrasi begitu ada lebih banyak wajah.

### Catatan koreksi

Kalibrasi putaran pertama (sebelum foto orang ke-2 sampai ke-5 masuk)
menyimpulkan "margin crop 2.0 dan ambang 0.62". Kesimpulan itu **keliru**:
harness saat itu memotong satu kali dan membiarkan area di luar batas gambar
terisi hitam, sehingga pada margin besar 35–65% masukan model menjadi hitam.
Aplikasi tidak pernah berperilaku begitu — ia menjepit crop. Harness sudah
diperbaiki agar meniru `cropAlignResize()` langkah demi langkah; angka di
halaman ini berasal dari harness yang sudah benar.

## Menyiapkan bahan uji

Buat folder foto, satu subfolder per orang:

```
photos/
  saya/        <- minimal 5 foto wajah Anda (3 enrollment + 2 probe)
  orang-1/     <- minimal 2 foto per orang lain
  orang-2/
  orang-3/
```

Target minimal yang benar-benar berguna: **8 foto Anda + 4 orang lain @ 3
foto**. Makin banyak orang lain, makin dipercaya angka impostor-nya —
merekalah yang menentukan seberapa aman threshold-nya.

Untuk foto Anda sendiri, sengaja variasikan: pencahayaan berbeda, dengan dan
tanpa kacamata, ekspresi berbeda, sedikit menoleh. Justru kondisi sulit itu
yang menentukan seberapa rendah threshold boleh dipasang tanpa menolak Anda
sendiri.

Foto orang lain boleh dari siapa saja yang bersedia — teman satu posko
paling ideal, karena merekalah yang realistis akan mencoba titip absen.

## Menjalankan

```powershell
# sekali saja
py -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt

# tiap kali
.\.venv\Scripts\python calibrate.py --photos photos
```

Opsi yang berguna:

| Opsi | Arti |
|---|---|
| `--full` | ikutkan varian mirror (2× lebih lama) |
| `--self-id nama` | nama subfolder wajah Anda (default `saya`) |
| `--enroll 3` | jumlah foto enrollment yang disimulasikan |
| `--top 20` | berapa baris teratas yang ditampilkan |

## Membaca hasilnya

Tabel diurutkan berdasarkan **d-prime** — jarak antara rata-rata skor
genuine dan impostor, dalam satuan simpangan baku. Dipakai sebagai skor utama
karena tidak bergantung pada pemilihan threshold. Makin besar makin baik;
di bawah ~2 berarti pemisahannya lemah.

Kolom lain: `EER` (titik saat kesalahan menerima = kesalahan menolak, makin
kecil makin baik), `thr` (threshold cosine di titik itu), `d_eq` (padanan
Euclidean-nya), `akur` (akurasi terbaik yang bisa dicapai).

Blok **REKOMENDASI** menyebut kombinasi pemenang dan angka threshold-nya.
Kalau muncul peringatan bahwa distribusi masih tumpang tindih, jangan kunci
angkanya dulu — tambah foto, terutama foto orang lain.

Blok **STRATEGI PENGGABUNGAN** membandingkan `max` / `top2` / `mean` /
`median` terhadap N wajah terdaftar. Sejak kalibrasi 2026-08-27 aplikasi
memakai `median` (`similarityToEnrollment` di `utils/faceEnrollment.ts`);
sebelumnya `max`, yang memberi impostor N kesempatan menembus ambang
alih-alih satu. Kalau kalibrasi ulang memenangkan baris lain, ganti di sana.

## Memindahkan hasilnya ke aplikasi

| Temuan | Diterapkan di |
|---|---|
| Konstanta normalisasi | `fileToNormalizedInputBuffer()` di `utils/faceAuthNative.ts` |
| Skala template | konstanta `ARC_*` di `utils/faceAuthNative.ts` |
| Alignment kanonik | `cropAlignResize()` di `utils/faceAuthNative.ts` |
| Threshold | `FACE_MATCH_THRESHOLD` di `utils/faceAuthNative.ts` |
| Strategi penggabungan | `similarityToEnrollment()` di `utils/faceEnrollment.ts` |

Simpan `hasil-kalibrasi.csv` — tabel d-prime/EER lengkapnya layak dipakai
sebagai lampiran metodologi skripsi, menggantikan konstanta yang sebelumnya
ditandai "tebakan" di dalam kode.

## Catatan tentang detektor

Deteksi wajah di sini memakai BlazeFace (mediapipe), bukan ML Kit seperti di
perangkat. Keduanya BUKAN detektor yang sama persis, jadi kotak wajahnya bisa
sedikit berbeda. Itu tidak menggugurkan hasilnya: detektor yang sama dipakai
untuk seluruh varian, sehingga perbandingan antar-varian tetap adil. Yang
perlu diingat hanyalah bahwa nilai threshold absolutnya sebaiknya diverifikasi
sekali di perangkat lewat log kemiripan di halaman Profil.
