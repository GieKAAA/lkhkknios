# Panduan Build ke .ipa (lkh-kkn-ios)

Panduan ini menggantikan panduan build sebelumnya. **Yang berubah**: sejak
migrasi ke VisionCamera + Nitro modules (fast-tflite, ML Kit face
detector), project ini **tidak lagi bisa dites lewat Expo Go** dan cuma
bisa dites lewat *custom dev client* / build native penuh. Prosesnya masih
sama-sama butuh Mac untuk tahap kompilasi iOS-nya.

---

## 0. Sekali saja: siapkan Mac (kalau belum pernah)

Di **Mac**, pastikan sudah ada:

1. **Xcode** (App Store) - versi terbaru yang tersedia. Setelah instal,
   buka sekali supaya Xcode selesai memasang komponen tambahan, lalu buka
   **Xcode → Settings → Locations** dan pastikan **Command Line Tools**
   terisi (pilih versi Xcode yang terpasang).
2. **Node.js** (versi LTS terbaru, 20.x ke atas) - instal dari
   https://nodejs.org atau lewat `brew install node`.
3. **CocoaPods**:
   ```bash
   sudo gem install cocoapods
   # atau
   brew install cocoapods
   ```
4. **Watchman** (opsional tapi disarankan, bikin `expo start` lebih
   stabil):
   ```bash
   brew install watchman
   ```
5. Akun **Apple ID** yang sudah ditambahkan di Xcode (**Xcode → Settings →
   Accounts**) - akun gratis (tanpa Apple Developer Program berbayar)
   sudah cukup untuk install langsung ke iPhone via kabel, hanya masa
   berlakunya lebih pendek (~7 hari) kalau tidak pakai akun berbayar.

Langkah di atas cukup sekali - lewati kalau Mac-nya sama dengan yang
kemarin dipakai build.

---

## 1. Di Windows: siapkan & kompres project

Project ini **bukan** repo git, jadi cara pindahnya lewat zip manual.
**Jangan** ikutkan folder `node_modules` di dalam zip - selain ukurannya
besar, sebagian paket punya native binary yang di-build khusus untuk OS
tempat `npm install` dijalankan (Windows), yang tidak kompatibel kalau
dipakai langsung di Mac. Lebih aman & cepat: instal ulang dependency-nya
langsung di Mac (langkah 3).

Jalankan di PowerShell, dari folder project:

```powershell
$src = "c:\Users\As Shadiq Nur\Documents\Skripsi\lkh-kkn-ios\lkh-kkn-ios"
$staging = "$env:TEMP\lkh-kkn-ios-export"
$zipPath = "$env:USERPROFILE\Desktop\lkh-kkn-ios.zip"

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# Salin project tanpa node_modules/.expo/ios/android/dist (folder-folder
# ini akan dibuat ulang otomatis di Mac).
robocopy $src $staging /E /XD node_modules .expo ios android dist

Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -Force
Write-Host "Zip siap di $zipPath"
```

> Catatan: `robocopy` normal kalau menampilkan kode keluar bukan `0` (itu
> bukan error, cuma ringkasan jumlah file yang disalin) - yang penting
> `Write-Host "Zip siap..."` di akhir muncul.

File `lkh-kkn-ios.zip` akan muncul di Desktop. Pastikan `package-lock.json`
ikut ter-zip (jangan sampai ke-exclude) - ini yang menjamin versi
dependency di Mac sama persis dengan yang sudah diuji di Windows.

---

## 2. Pindahkan ke Mac

Pilih salah satu:

- **AirDrop** (paling gampang kalau Mac & PC ada di jaringan yang sama dan
  ada perangkat Apple perantara) - atau kirim lewat kabel/USB drive.
- **Cloud** (Google Drive / OneDrive) - upload dari Windows, download di
  Mac. Perhatikan: **jangan upload lewat tool web pihak ketiga sembarangan**
  kalau isinya ada token/kredensial - project ini sejauh yang saya tahu
  tidak menyimpan secret di source (token disimpan di AsyncStorage saat
  runtime, bukan di file project), tapi tetap gunakan akun cloud pribadi,
  bukan link publik.
- **Kabel data langsung ke Mac** lewat Finder/File Sharing, kalau
  Windows & Mac bisa saling lihat di jaringan yang sama (SMB).

Setelah file `lkh-kkn-ios.zip` sampai di Mac, **extract** ke lokasi kerja,
misalnya `~/Projects/lkh-kkn-ios/`.

---

## 3. Di Mac: install dependency

Buka Terminal, masuk ke folder project hasil extract:

```bash
cd ~/Projects/lkh-kkn-ios

npm install --legacy-peer-deps
```

`--legacy-peer-deps` **wajib** dipakai - `@tensorflow/tfjs-react-native`
punya peer dependency versi lama untuk `@react-native-async-storage/async-storage`
yang bentrok dengan versi yang benar-benar dipakai project ini kalau tidak
diberi flag ini.

---

## 4. Generate project native iOS

Project ini pakai Expo *managed workflow* + native modules custom
(VisionCamera, dll), jadi folder `ios/` perlu di-generate dari `app.json`
setiap kali mulai dari zip baru:

```bash
npx expo prebuild --platform ios --clean
```

Perintah ini membaca `app.json` (bundle identifier, izin kamera/lokasi,
config plugin `expo-router`/`expo-notifications`/`expo-location`/
`expo-splash-screen`) dan membuat folder `ios/` berisi project Xcode asli,
termasuk menjalankan `pod install` untuk semua native module (VisionCamera,
react-native-fast-tflite, react-native-vision-camera-face-detector,
react-native-nitro-modules, dll).

Kalau di akhir prosesnya **tidak** otomatis menjalankan pod install (jarang
terjadi, tapi kalau ada error terkait pods), jalankan manual:

```bash
cd ios
pod install
cd ..
```

---

## 5A. Jalur cepat: langsung ke iPhone lewat kabel (untuk testing)

Paling praktis untuk siklus coba-perbaiki-coba lagi (misalnya sambil
kalibrasi ambang kemiripan wajah):

1. Sambungkan iPhone ke Mac lewat kabel, buka kunci layar, kalau muncul
   dialog "Trust This Computer?" pilih **Trust**.
2. Jalankan:
   ```bash
   npx expo run:ios --device
   ```
3. Pilih iPhone kamu dari daftar perangkat yang muncul di terminal (kalau
   ada lebih dari satu opsi).
4. Tunggu proses build (beberapa menit di percobaan pertama, lebih cepat
   di percobaan berikutnya). Expo CLI otomatis build lewat Xcode dan
   install ke iPhone.
5. Kalau ini pertama kali app ini terinstal dari developer/Apple ID kamu,
   iPhone akan menolak membuka app-nya - lihat langkah **"Percaya
   Developer"** di bagian 7 di bawah.

App yang terinstal lewat cara ini **langsung bisa dipakai tanpa KSign**,
tapi (kalau Apple ID kamu bukan akun Developer Program berbayar) akan
otomatis "expired" dan perlu diinstal ulang setelah ~7 hari.

---

## 5B. Jalur lengkap: Archive → Export .ipa → (opsional) KSign

Kalau butuh file `.ipa` yang bisa dipasang lebih tahan lama (lewat KSign
atau disimpan sebagai backup), lakukan lewat Xcode:

1. Buka project di Xcode:
   ```bash
   open ios/lkhkknios.xcworkspace
   ```
   (**Penting**: buka file `.xcworkspace`, bukan `.xcodeproj` - CocoaPods
   butuh workspace supaya semua pod native module ikut ter-link.)

2. Di panel kiri, klik nama project paling atas → tab **Signing &
   Capabilities**:
   - Pilih **Team** = Apple ID kamu (kalau belum ada, tambah dulu lewat
     Xcode → Settings → Accounts, lalu pilih di sini).
   - Pastikan **Automatically manage signing** dicentang.
   - **Bundle Identifier** harus tetap `com.gieka21.lkhkknios` (sudah
     diisi otomatis dari `app.json`).

3. Di bagian atas jendela Xcode, pilih target device: klik dropdown
   perangkat (biasanya tertulis simulator), pilih iPhone kamu yang
   tersambung kabel (harus muncul di daftar setelah "Trust This
   Computer").

4. Menu **Product → Destination**, pastikan sudah "Any iOS Device (arm64)"
   kalau mau Archive (Archive tidak bisa dipilih kalau target-nya masih
   simulator).

5. Menu **Product → Archive**. Tunggu sampai selesai (bisa beberapa
   menit) - jendela **Organizer** akan terbuka otomatis menampilkan hasil
   archive.

6. Di Organizer, pilih archive yang baru dibuat → klik **Distribute App**:
   - Pilih **Development** (untuk install manual/KSign) atau **Ad Hoc**
     kalau device-nya sudah terdaftar di provisioning profile.
   - Ikuti wizard-nya sampai selesai, lalu **Export** ke folder pilihan.
   - Hasilnya folder berisi file `.ipa`.

7. File `.ipa` ini yang dipakai untuk KSign (re-sign supaya bisa dipasang
   tanpa Xcode/kabel lagi) seperti proses sebelumnya.

---

## 6. "Percaya" developer di iPhone (kalau app tidak mau dibuka)

Setelah instal (baik lewat `expo run:ios --device` maupun `.ipa`), kalau
muncul pesan **"Untrusted Enterprise Developer"** atau app tidak mau
dibuka:

1. Di iPhone: **Settings → General → VPN & Device Management**.
2. Cari nama Apple ID/profil developer kamu di bawah **Developer App**.
3. Tap, lalu **Trust "..."** → **Trust**.
4. Buka lagi aplikasinya.

---

## 7. Hal spesifik ke stack baru (perlu diperhatikan)

- **ML Kit tidak jalan di iOS Simulator** - selalu tes di iPhone fisik
  lewat kabel, jangan lewat simulator Xcode (deteksi wajah akan gagal
  total di simulator, ini bukan bug kode).
- **New Architecture wajib tetap aktif** (`newArchEnabled: true` di
  `app.json`) - VisionCamera v5 dan semua Nitro module (fast-tflite,
  face-detector, resizer) butuh New Architecture, tidak bisa dimatikan.
- **Setelah update kode di Windows dan mau build ulang**: cukup ulangi
  dari langkah 1 (zip) kalau ada perubahan file JS/TS biasa. Kalau
  perubahan **hanya** di file `.ts`/`.tsx`/`.js` (bukan `package.json`,
  `app.json`, atau native config lain), langkah 4 (`expo prebuild`) boleh
  dilewati - langsung `npx expo run:ios --device` lagi juga cukup, dia
  akan pakai folder `ios/` yang sudah ada.
- **Reset Wajah Patokan** setelah build pertama kali dari migrasi ini -
  embedding wajah lama (model TensorFlow.js) tidak sebanding dengan
  embedding baru (MobileFaceNet) - lihat Profile → Reset Wajah Patokan,
  lalu daftar ulang.

---

## 8. Troubleshooting umum

| Gejala | Kemungkinan penyebab / solusi |
|---|---|
| `pod install` gagal | Jalankan `cd ios && pod repo update && pod install` |
| Xcode error "no such module" untuk salah satu Nitro package | `npx expo prebuild --platform ios --clean` lagi dari awal (folder `ios/` mungkin korup/setengah ter-generate) |
| Build sukses tapi app crash saat buka kamera | Cek `Settings → Privacy → Camera` di iPhone, pastikan izin untuk app ini aktif |
| Deteksi wajah selalu gagal padahal wajah jelas | Pastikan bukan di Simulator (lihat poin ML Kit di atas) |
| `npm install` gagal karena peer dependency | Pastikan pakai `--legacy-peer-deps` (langkah 3) |
