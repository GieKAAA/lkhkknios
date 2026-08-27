"""
Kalibrasi preprocessing + threshold MobileFaceNet untuk lkh-kkn-ios.

LATAR BELAKANG
--------------
Aplikasi Android resmi LKH KKN memakai mobilefacenet.tflite yang SAMA PERSIS
dengan yang dipakai app iOS ini (md5 7945c78f4484c99560df461df85baa2f, sudah
diverifikasi terhadap APK). Yang TIDAK bisa dipulihkan dari APK adalah
keputusan preprocessing-nya (kode Dart-nya AOT-compiled - string dump cuma
memberi literal, bukan aritmetikanya).

Padahal preprocessing yang meleset TIDAK memunculkan error: model tetap
mengeluarkan embedding, hanya daya pisahnya yang rusak - distribusi "wajah
sendiri" dan "wajah orang lain" jadi tumpang tindih. Gejalanya persis keluhan
yang sedang diperbaiki di branch fix/face-verification: wajah orang lain bisa
lolos absen.

Skrip ini menyelesaikannya secara empiris, bukan dengan menebak: jalankan
model yang sama atas foto Anda sendiri, coba SEMUA kombinasi preprocessing
yang masuk akal, lalu ukur mana yang paling memisahkan genuine dari impostor.
Kombinasi pemenangnya yang dipindahkan ke utils/faceAuthNative.ts.

Keluarannya (tabel d'/EER + threshold terpilih) juga layak dipakai sebagai
bukti metodologi di laporan skripsi - menggantikan konstanta yang saat ini
masih ditandai "tebakan" di dalam kode.

TEMUAN PENTING YANG SUDAH DIVERIFIKASI
--------------------------------------
Model ini SUDAH me-L2-normalize keluarannya sendiri (||y|| = 1.0 untuk input
apa pun). Konsekuensinya: cosine similarity dan Euclidean distance hanyalah
dua skala dari besaran yang sama,

    d^2 = 2 - 2*cos   <=>   cos = 1 - d^2/2

jadi "distance" ala Android dan "cosine" ala iOS memberi PERINGKAT yang
identik. Threshold Euclidean Android bisa diterjemahkan langsung ke cosine
kita lewat rumus di atas (lihat kolom d_eq pada laporan).

CARA PAKAI
----------
1. Siapkan folder foto, satu subfolder per orang:

       photos/
         saya/           <- minimal 6 foto wajah Anda, kondisi bervariasi
         orang-1/        <- minimal 2 foto per orang lain
         orang-2/
         ...

   Makin banyak orang lain, makin dipercaya angka impostor-nya. Target
   minimal yang berguna: 8 foto Anda + 4 orang lain @ 3 foto.

2. Jalankan:

       python calibrate.py --photos photos

   Tambahkan --full untuk memasukkan varian mirror (2x lebih lama).
"""

from __future__ import annotations

import argparse
import csv
import itertools
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Ruang varian preprocessing
# ---------------------------------------------------------------------------

# Normalisasi piksel. Kode iOS saat ini memakai (x-127.5)/128 - itu TEBAKAN
# (lihat komentar di utils/faceAuthNative.ts). Semua konvensi yang lazim untuk
# lineage MobileFaceNet ini ikut diuji.
NORMALIZATIONS: dict[str, tuple[float, float]] = {
    # nama: (mean, std) -> (x - mean) / std
    "(x-127.5)/128": (127.5, 128.0),
    "(x-128)/128": (128.0, 128.0),
    "(x-127.5)/127.5": (127.5, 127.5),
    "x/255": (0.0, 255.0),
    "(x-127.5)/255": (127.5, 255.0),
}

# Skala terhadap template kanonik. 1.0 = persis template ArcFace; di bawah 1
# memotong lebih ketat, di atas 1 memasukkan lebih banyak latar.
MARGINS = [0.9, 1.0, 1.1, 1.2]

RESAMPLE = Image.Resampling.BILINEAR

# --- Template kanonik ArcFace/InsightFace pada 112x112 ---------------------
# Titik mata kiri (38.2946, 51.6963) dan kanan (73.5318, 51.5014).
ARC_EYE_DISTANCE = 35.2372
ARC_EYE_CENTER_FX = 0.49926  # ((38.2946+73.5318)/2) / 112
ARC_EYE_CENTER_FY = 0.46070  # ((51.6963+51.5014)/2) / 112


# Perbandingan INITIAL_CROP_RATIO terhadap FINAL_CROP_RATIO di aplikasi.
# Crop pertama harus tetap menutupi crop final setelah rotasi melebarkan
# kanvas: cos(30deg)+sin(30deg) ~= 1.37, jadi 1.5 sudah cukup longgar.
INITIAL_TO_FINAL = 1.5


@dataclass(frozen=True)
class Variant:
    norm: str
    margin: float
    align: bool
    channel: str  # "RGB" | "BGR"
    mirror: bool

    @property
    def initial_margin(self) -> float:
        return self.margin * INITIAL_TO_FINAL

    def label(self) -> str:
        return (
            f"{self.norm:16s} m={self.margin:.1f} "
            f"align={'Y' if self.align else 'N'} {self.channel} "
            f"mirror={'Y' if self.mirror else 'N'}"
        )


def build_variants(full: bool) -> list[Variant]:
    mirrors = [False, True] if full else [False]
    return [
        Variant(n, m, a, c, mi)
        for n, m, a, c, mi in itertools.product(
            NORMALIZATIONS, MARGINS, [True, False], ["RGB", "BGR"], mirrors
        )
    ]


# ---------------------------------------------------------------------------
# Deteksi wajah (BlazeFace via mediapipe) - berdiri di posisi ML Kit
# ---------------------------------------------------------------------------


@dataclass
class FaceGeom:
    """Geometri wajah dalam koordinat piksel gambar asli."""

    cx: float
    cy: float
    size: float  # sisi terpanjang bounding box
    left_eye: tuple[float, float]
    right_eye: tuple[float, float]


class Detector:
    def __init__(self, model_path: Path):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        self._det = vision.FaceDetector.create_from_options(
            vision.FaceDetectorOptions(
                base_options=BaseOptions(model_asset_path=str(model_path)),
                min_detection_confidence=0.5,
            )
        )

    def detect(self, image: Image.Image) -> FaceGeom | None:
        arr = np.asarray(image.convert("RGB"))
        res = self._det.detect(
            self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=arr)
        )
        if not res.detections:
            return None
        # Ambil wajah terbesar kalau ada lebih dari satu.
        det = max(res.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height)
        bb = det.bounding_box
        h, w = arr.shape[:2]
        # Urutan keypoint BlazeFace: [mata kanan, mata kiri, hidung, mulut,
        # tragion kanan, tragion kiri] - "kanan/kiri" dari sudut pandang orang
        # di foto, jadi mata kanan muncul di sisi KIRI gambar.
        kp = det.keypoints
        if len(kp) < 2:
            return None
        eye_a = (kp[0].x * w, kp[0].y * h)
        eye_b = (kp[1].x * w, kp[1].y * h)
        # Urutkan berdasar x supaya rumus rotasi di bawah tidak bergantung
        # pada konvensi kiri/kanan detektor.
        left, right = sorted([eye_a, eye_b], key=lambda p: p[0])
        return FaceGeom(
            cx=bb.origin_x + bb.width / 2,
            cy=bb.origin_y + bb.height / 2,
            size=float(max(bb.width, bb.height)),
            left_eye=left,
            right_eye=right,
        )


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------


def _rotate_point(
    px: float, py: float, cx: float, cy: float, deg: float
) -> tuple[float, float]:
    """Posisi (px,py) setelah gambar diputar `deg` berlawanan jarum jam
    terhadap pusat (cx,cy) - konvensi PIL.Image.rotate."""
    r = math.radians(deg)
    dx, dy = px - cx, py - cy
    # y menunjuk ke bawah, jadi rotasi CCW secara visual = matriks di bawah.
    return (cx + dx * math.cos(r) + dy * math.sin(r),
            cy - dx * math.sin(r) + dy * math.cos(r))


def _clamp(value: float, low: float, high: float) -> float:
    """Salinan clamp() di utils/faceAuthNative.ts, termasuk perilakunya saat
    high <= low (kotak lebih besar dari gambar)."""
    if high <= low:
        return low
    return max(low, min(high, value))


def preprocess(image: Image.Image, face: FaceGeom, v: Variant) -> np.ndarray:
    """Ubah foto + geometri wajah jadi tensor [1,112,112,3] float32.

    Meniru cropAlignResize() di utils/faceAuthNative.ts LANGKAH DEMI LANGKAH:
    warp similaritas ke template kanonik ArcFace lewat crop -> rotate ->
    crop -> resize. Setiap perubahan di sini harus ikut diterapkan di sana,
    dan sebaliknya - kalau keduanya berbeda, angka hasil kalibrasi tidak lagi
    berlaku untuk aplikasi.

    DUA JEBAKAN yang sudah pernah menjatuhkan skrip ini:
    1. Versi awal memotong sekali saja dan membiarkan PIL mengisi bagian di
       luar batas dengan HITAM. Aplikasi menjepit crop agar tetap di dalam
       foto. Pada margin besar 35-65% area jadi hitam, embedding kolaps, dan
       lima orang berbeda tampak saling mirip 0.58-0.81.
    2. Versi berikutnya memotong berdasar rasio bounding box. Model ini
       dilatih untuk template kanonik; crop bbox membuat orang berbeda
       tetap mirip 0.53-0.66. Alignment kanonik menurunkannya ke 0.34.
    """
    img = image.convert("RGB")
    left, right = face.left_eye, face.right_eye

    if v.mirror:
        w = img.width
        img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        left, right = (w - right[0], right[1]), (w - left[0], left[1])

    dx, dy = right[0] - left[0], right[1] - left[1]
    eye_dist = math.hypot(dx, dy)
    ecx, ecy = (left[0] + right[0]) / 2, (left[1] + right[1]) / 2
    final_side = eye_dist * 112.0 / ARC_EYE_DISTANCE * v.margin

    # --- Langkah 1: kotak longgar di sekitar titik tengah mata, DIJEPIT ---
    initial_side = min(final_side * INITIAL_TO_FINAL, img.width, img.height)
    ox = _clamp(ecx - initial_side / 2, 0, img.width - initial_side)
    oy = _clamp(ecy - initial_side / 2, 0, img.height - initial_side)
    step1 = img.crop((round(ox), round(oy),
                      round(ox + initial_side), round(oy + initial_side)))
    ex, ey = ecx - ox, ecy - oy

    # --- Langkah 2: rotasi agar mata datar. Pivot ada di PUSAT crop, bukan
    #     di mata, jadi titik mata harus dilacak melewati rotasi ---
    if v.align:
        deg = math.degrees(math.atan2(dy, dx))
        if abs(deg) > 0.5:
            w0, h0 = step1.size
            step1 = step1.rotate(deg, resample=RESAMPLE, expand=True)
            t = math.radians(deg)
            c, s = math.cos(t), math.sin(t)
            offx, offy = ex - w0 / 2, ey - h0 / 2
            ex = step1.width / 2 + (offx * c + offy * s)
            ey = step1.height / 2 + (-offx * s + offy * c)

    # --- Langkah 3: tempatkan titik mata pada posisi kanonik + resize ---
    side = min(final_side, step1.width, step1.height)
    fx = _clamp(ex - side * ARC_EYE_CENTER_FX, 0, step1.width - side)
    fy = _clamp(ey - side * ARC_EYE_CENTER_FY, 0, step1.height - side)
    face_img = step1.crop((round(fx), round(fy),
                           round(fx + side), round(fy + side))
                          ).resize((112, 112), RESAMPLE)

    arr = np.asarray(face_img, dtype=np.float32)
    if v.channel == "BGR":
        arr = arr[:, :, ::-1]
    mean, std = NORMALIZATIONS[v.norm]
    arr = (arr - mean) / std
    return arr[None, ...].astype(np.float32)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class Embedder:
    def __init__(self, model_path: Path):
        from ai_edge_litert.interpreter import Interpreter

        self._it = Interpreter(model_path=str(model_path))
        self._it.allocate_tensors()
        self._in = self._it.get_input_details()[0]
        self._out = self._it.get_output_details()[0]

    def embed(self, tensor: np.ndarray) -> np.ndarray:
        self._it.set_tensor(self._in["index"], tensor)
        self._it.invoke()
        v = self._it.get_tensor(self._out["index"])[0].astype(np.float64)
        # Model sudah L2-normalize sendiri, tapi dinormalkan lagi agar aman
        # kalau suatu saat modelnya diganti varian yang tidak.
        n = np.linalg.norm(v)
        return v / n if n else v


# ---------------------------------------------------------------------------
# Metrik
# ---------------------------------------------------------------------------


def d_prime(gen: np.ndarray, imp: np.ndarray) -> float:
    """Seberapa jauh dua distribusi terpisah, dalam satuan simpangan baku.
    Dipakai sebagai skor utama karena tidak bergantung pada pemilihan
    threshold - beda dengan akurasi."""
    if len(gen) < 2 or len(imp) < 2:
        return float("nan")
    pooled = math.sqrt((gen.var(ddof=1) + imp.var(ddof=1)) / 2)
    return float((gen.mean() - imp.mean()) / pooled) if pooled else float("inf")


def eer_and_threshold(gen: np.ndarray, imp: np.ndarray) -> tuple[float, float]:
    """Equal Error Rate dan threshold tempat FAR bertemu FRR."""
    if len(gen) == 0 or len(imp) == 0:
        return float("nan"), float("nan")
    cands = np.unique(np.concatenate([gen, imp]))
    best = (float("inf"), float("nan"), float("nan"))
    for t in cands:
        far = float((imp >= t).mean())  # impostor diterima
        frr = float((gen < t).mean())  # genuine ditolak
        gap = abs(far - frr)
        if gap < best[0]:
            best = (gap, (far + frr) / 2, float(t))
    return best[1], best[2]


def best_accuracy_threshold(gen: np.ndarray, imp: np.ndarray) -> tuple[float, float]:
    cands = np.unique(np.concatenate([gen, imp]))
    best_acc, best_t = -1.0, float("nan")
    total = len(gen) + len(imp)
    for t in cands:
        correct = int((gen >= t).sum() + (imp < t).sum())
        acc = correct / total
        if acc > best_acc:
            best_acc, best_t = acc, float(t)
    return best_acc, best_t


def cos_to_euclid(c: float) -> float:
    """Threshold cosine -> threshold Euclidean setara (untuk membandingkan
    dengan angka gaya Android)."""
    return math.sqrt(max(0.0, 2.0 - 2.0 * c))


# ---------------------------------------------------------------------------
# Pemuatan foto
# ---------------------------------------------------------------------------

EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def load_dataset(root: Path, detector: Detector) -> dict[str, list[tuple[str, Image.Image, FaceGeom]]]:
    data: dict[str, list[tuple[str, Image.Image, FaceGeom]]] = {}
    people = sorted(p for p in root.iterdir() if p.is_dir())
    if not people:
        sys.exit(f"Tidak ada subfolder orang di {root}. Lihat docstring untuk strukturnya.")
    for person in people:
        items = []
        for f in sorted(person.iterdir()):
            if f.suffix.lower() not in EXT:
                continue
            img = Image.open(f)
            img.load()
            geom = detector.detect(img)
            if geom is None:
                print(f"  ! wajah tidak terdeteksi, dilewati: {person.name}/{f.name}")
                continue
            items.append((f.name, img, geom))
        if items:
            data[person.name] = items
            print(f"  {person.name}: {len(items)} foto")
        else:
            print(f"  {person.name}: KOSONG (tidak ada wajah terdeteksi)")
    return data


# ---------------------------------------------------------------------------
# Evaluasi
# ---------------------------------------------------------------------------


def evaluate_variant(
    data: dict[str, list[tuple[str, Image.Image, FaceGeom]]],
    embedder: Embedder,
    v: Variant,
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    """Kembalikan (skor genuine, skor impostor, embedding per orang)."""
    embeds: dict[str, np.ndarray] = {}
    for person, items in data.items():
        vecs = [embedder.embed(preprocess(img, geom, v)) for _, img, geom in items]
        embeds[person] = np.stack(vecs)

    gen, imp = [], []
    names = list(embeds)
    for i, a in enumerate(names):
        A = embeds[a]
        for x in range(len(A)):
            for y in range(x + 1, len(A)):
                gen.append(float(A[x] @ A[y]))
        for b in names[i + 1 :]:
            B = embeds[b]
            for x in range(len(A)):
                for y in range(len(B)):
                    imp.append(float(A[x] @ B[y]))
    return np.array(gen), np.array(imp), embeds


def aggregation_study(
    embeds: dict[str, np.ndarray], self_id: str, n_enroll: int
) -> list[tuple[str, float, float, float]]:
    """Bandingkan strategi penggabungan skor terhadap N wajah terdaftar.

    Ini inti bug yang sedang diperbaiki: bestSimilarityToEnrollment() memakai
    max-of-N, yang memberi impostor N kesempatan menembus ambang, bukan satu.
    """
    if self_id not in embeds:
        return []
    S = embeds[self_id]
    # Butuh minimal 2 probe tersisa setelah enrollment: dengan 1 probe,
    # ragam sampelnya tak terdefinisi dan d-prime keluar NaN.
    if len(S) < n_enroll + 2:
        return []
    enroll = S[:n_enroll]
    self_probes = S[n_enroll:]
    other_probes = np.concatenate([e for k, e in embeds.items() if k != self_id])

    def scores(probes: np.ndarray, how: str) -> np.ndarray:
        sims = probes @ enroll.T  # [n_probe, n_enroll]
        if how == "max":
            return sims.max(axis=1)
        if how == "mean":
            return sims.mean(axis=1)
        if how == "top2":
            k = min(2, sims.shape[1])
            return np.sort(sims, axis=1)[:, -k:].mean(axis=1)
        if how == "median":
            return np.median(sims, axis=1)
        raise ValueError(how)

    rows = []
    for how in ("max", "top2", "mean", "median"):
        g = scores(self_probes, how)
        i = scores(other_probes, how)
        eer, t = eer_and_threshold(g, i)
        rows.append((how, d_prime(g, i), eer, t))
    return rows


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", required=True, type=Path, help="folder berisi subfolder per orang")
    ap.add_argument(
        "--model",
        type=Path,
        default=here.parent.parent / "assets" / "models" / "mobilefacenet.tflite",
    )
    ap.add_argument("--detector", type=Path, default=here / "blaze_face_short_range.tflite")
    ap.add_argument("--self-id", default="saya", help="nama subfolder wajah Anda sendiri")
    ap.add_argument("--enroll", type=int, default=3, help="jumlah foto enrollment yang disimulasikan")
    ap.add_argument("--full", action="store_true", help="ikutkan varian mirror")
    ap.add_argument("--out", type=Path, default=here / "hasil-kalibrasi.csv")
    ap.add_argument("--top", type=int, default=15)
    args = ap.parse_args()

    for p, what in ((args.model, "model wajah"), (args.detector, "model detektor")):
        if not p.exists():
            sys.exit(f"{what} tidak ditemukan: {p}")

    print(f"Model    : {args.model}")
    print(f"Detektor : {args.detector}")
    print(f"\nMemuat foto dari {args.photos} ...")
    detector = Detector(args.detector)
    data = load_dataset(args.photos, detector)
    if len(data) < 2:
        sys.exit("Butuh minimal 2 orang (1 = Anda, sisanya pembanding impostor).")

    n_photos = sum(len(v) for v in data.values())
    print(f"\nTotal {n_photos} foto dari {len(data)} orang.")

    embedder = Embedder(args.model)
    variants = build_variants(args.full)
    print(f"Menguji {len(variants)} varian preprocessing "
          f"({len(variants) * n_photos} inferensi)...\n")

    results = []
    best_pack: tuple[float, Variant, dict[str, np.ndarray]] | None = None
    for idx, v in enumerate(variants, 1):
        gen, imp, embeds = evaluate_variant(data, embedder, v)
        dp = d_prime(gen, imp)
        eer, t_eer = eer_and_threshold(gen, imp)
        acc, t_acc = best_accuracy_threshold(gen, imp)
        results.append(
            dict(
                norm=v.norm, margin=v.margin, align=v.align, channel=v.channel,
                mirror=v.mirror, d_prime=dp, eer=eer, thr_eer=t_eer,
                acc=acc, thr_acc=t_acc, euclid_eq=cos_to_euclid(t_eer),
                gen_mean=float(gen.mean()), imp_mean=float(imp.mean()),
                gen_min=float(gen.min()), imp_max=float(imp.max()),
            )
        )
        if best_pack is None or (dp == dp and dp > best_pack[0]):
            best_pack = (dp, v, embeds)
        if idx % 10 == 0 or idx == len(variants):
            print(f"  {idx}/{len(variants)} varian selesai", end="\r", flush=True)

    print("\n")
    results.sort(key=lambda r: (-(r["d_prime"] if r["d_prime"] == r["d_prime"] else -1e9)))

    hdr = f"{'#':>3}  {'normalisasi':16s} {'marg':>4} {'algn':>4} {'ch':>3} {'mir':>3}  {'d-prime':>7} {'EER':>6} {'thr':>6} {'d_eq':>5} {'akur':>6}"
    print(hdr)
    print("-" * len(hdr))
    for i, r in enumerate(results[: args.top], 1):
        print(
            f"{i:>3}  {r['norm']:16s} {r['margin']:>4.1f} "
            f"{'Y' if r['align'] else 'N':>4} {r['channel'][:3]:>3} "
            f"{'Y' if r['mirror'] else 'N':>3}  "
            f"{r['d_prime']:>7.3f} {r['eer']:>6.2%} {r['thr_eer']:>6.3f} "
            f"{r['euclid_eq']:>5.2f} {r['acc']:>6.2%}"
        )

    with args.out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(results[0]))
        w.writeheader()
        w.writerows(results)
    print(f"\nLaporan lengkap: {args.out}")

    top = results[0]
    print("\n" + "=" * 72)
    print("REKOMENDASI")
    print("=" * 72)
    print(f"Preprocessing terbaik : {top['norm']}, margin {top['margin']:.1f}, "
          f"align={'ya' if top['align'] else 'tidak'}, {top['channel']}"
          + (", mirror" if top["mirror"] else ""))
    print(f"Daya pisah (d')       : {top['d_prime']:.3f}   EER {top['eer']:.2%}")
    print(f"FACE_MATCH_THRESHOLD  : {top['thr_eer']:.3f}  (setara jarak Euclidean {top['euclid_eq']:.2f})")
    print(f"Skor genuine terendah : {top['gen_min']:.3f}")
    print(f"Skor impostor tertinggi: {top['imp_max']:.3f}")
    if top["imp_max"] >= top["gen_min"]:
        print("\n  PERHATIAN: distribusi genuine dan impostor masih tumpang tindih.")
        print("  Tidak ada threshold yang memisahkan sempurna pada data ini -")
        print("  tambah foto (terutama orang lain) sebelum mengunci angkanya.")

    if best_pack:
        rows = aggregation_study(best_pack[2], args.self_id, args.enroll)
        if rows:
            print("\n" + "=" * 72)
            print(f"STRATEGI PENGGABUNGAN (enrollment {args.enroll} foto, config terbaik)")
            print("=" * 72)
            print(f"  {'strategi':10s} {'d-prime':>8} {'EER':>8} {'threshold':>10}")
            for how, dp, eer, t in rows:
                tag = "  <- dipakai sekarang" if how == "max" else ""
                print(f"  {how:10s} {dp:>8.3f} {eer:>8.2%} {t:>10.3f}{tag}")
            print("\n  max-of-N memberi impostor N kesempatan lolos, bukan satu.")
            print("  Kalau baris lain unggul, ganti bestSimilarityToEnrollment()")
            print("  di utils/faceEnrollment.ts sesuai baris tersebut.")
        else:
            print(f"\n(Studi penggabungan dilewati: butuh minimal "
                  f"{args.enroll + 2} foto di folder '{args.self_id}' - "
                  f"{args.enroll} untuk enrollment + minimal 2 sebagai probe.)")


if __name__ == "__main__":
    main()
