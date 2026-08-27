import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "react-native";
import * as tf from "@tensorflow/tfjs";
// Deep import instead of the package root: the root barrel
// (dist/index.js) also re-exports its camera-stream helpers, which
// statically `import "expo-camera"` - a package this project intentionally
// no longer depends on (see module doc comment - VisionCamera replaced
// it). decode_image.js has no such dependency (just tfjs-core + jpeg-js),
// so importing it directly avoids dragging that unused, now-missing
// dependency into the bundle.
import { decodeJpeg } from "@tensorflow/tfjs-react-native/dist/decode_image";
// BUGFIX: dist/index.js's SIDE EFFECT of `import './platform_react_native'`
// is what actually registers tfjs-core's React Native platform
// (`tf.setPlatform('react-native', new PlatformReactNative())`) - skipping
// the root barrel above to dodge expo-camera also skipped this
// registration, so `tf.ready()` resolved with no RN platform set, and any
// tensor op that internally reads `env().platform` (e.g. inside
// decodeJpeg/toFloat/reshape) crashed with "Cannot read property
// 'isTypedArray' of undefined". platform_react_native.js itself only
// imports tfjs-core/tfjs-backend-cpu/tfjs-backend-webgl/expo-gl/react-native
// - none of which are the expo-camera dependency being avoided - so
// importing it directly for its side effect is safe.
import "@tensorflow/tfjs-react-native/dist/platform_react_native";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { toByteArray } from "base64-js";
import {
  loadTensorflowModel,
  TensorflowModel,
} from "react-native-fast-tflite";
import { createImageFaceDetector, Face } from "react-native-vision-camera-face-detector";

/**
 * On-device face verification (MobileFaceNet) used to prevent "titip absen"
 * (proxy attendance). Replaces the old TFJS/BlazeFace+FaceRes pipeline in
 * faceAuth.ts - see that file's header comment for the history of why this
 * changed, and AGENTS.md-style notes below for why specific choices were
 * made.
 *
 * Model: mobilefacenet.tflite, extracted from the official Android app's
 * APK (sirius-ai/MobileFaceNet_TF lineage - confirmed by reading the
 * flatbuffer's internal tensor/op names: "input" -> ... InvResBlock ... ->
 * "embeddings", no quantize/dequantize op, no second "phase_train" input).
 * The file is byte-identical to the one inside the official Android APK
 * (md5 7945c78f4484c99560df461df85baa2f) - so the model itself needs no
 * porting at all; only the preprocessing around it does. Practical
 * consequences of that:
 *  - Single input tensor [1,112,112,3] float32 RGB, single output
 *    [1,192] float32 - matches react-native-fast-tflite's
 *    `model.run([buffer])` / `runSync([buffer])` single-in/single-out shape.
 *  - CORRECTION (measured, not inferred): this model DOES L2-normalize its
 *    own output. Running it under a desktop TFLite interpreter gives
 *    ||output|| = 1.0 for every input tried - zeros, constants, uniform
 *    noise at several scales (see tools/face-calibration/). An earlier
 *    version of this comment claimed the opposite from reading op names.
 *    l2Normalize() below is therefore a no-op in practice; it is kept only
 *    so a future model swap that ISN'T pre-normalized can't silently break
 *    the comparison.
 *  - Because the embeddings are unit vectors, cosine similarity and
 *    Euclidean distance are two scales of the same quantity:
 *        d^2 = 2 - 2*cos   <=>   cos = 1 - d^2/2
 *    They rank pairs identically. So the official Android app's
 *    distance-style threshold and this file's cosine-style threshold are
 *    interconvertible - useful because the Android app's exact number is
 *    not recoverable from its APK (its Dart code is AOT-compiled).
 *  - No baked-in normalization constants (no embedded TFLite metadata
 *    table), so pixel normalization is applied here explicitly using the
 *    standard convention for this model lineage: (pixel - 127.5) / 128,
 *    mapping 0..255 to roughly -1..1.
 *
 * Pipeline (one function, used identically for enroll AND verify - the
 * single-most-important thing for consistent embeddings is that both sides
 * of a comparison go through *exactly* the same code path):
 *   captured photo file
 *     -> detect exactly one face on the STILL PHOTO (not a live camera
 *        frame - see below for why) via createImageFaceDetector from
 *        react-native-vision-camera-face-detector (same package/Face
 *        shape used by the live quality gate)
 *     -> quality gate (single face, minimum size, small yaw/pitch, eyes
 *        open)
 *     -> warp the face onto the canonical 112x112 template using the eye
 *        landmarks (expo-image-manipulator; see the ARC_* constants - this
 *        is what the model was trained to receive, and getting it wrong
 *        collapses the embedding space without raising any error)
 *     -> decode the resulting small JPEG to raw pixels (tfjs-react-native's
 *        decodeJpeg - see note below on why tfjs is still a dependency)
 *     -> normalize to float32 and run through mobilefacenet.tflite
 *     -> L2-normalize the resulting 192-d embedding
 *
 * WHY THE CROP/ALIGN HAPPENS ON A CAPTURED PHOTO, NOT A LIVE CAMERA FRAME:
 * the natural place to do this would be inside a VisionCamera frame
 * processor using react-native-vision-camera-resizer to crop straight to
 * the detected face's bounding box on the GPU. As of the versions pinned
 * in package.json (react-native-vision-camera-resizer 5.2.1), that
 * resizer's `resize()` only supports resizing/scaling the *whole* frame
 * (cover/contain/stretch) - there is no way to crop to an arbitrary
 * sub-rectangle yet (open feature request:
 * https://github.com/mrousavy/react-native-vision-camera/issues/3746).
 * So the live camera/frame-processor side (see hooks/useFaceQualityGate.ts)
 * is used *only* for real-time UX - face guide overlay, and gating
 * *when* the capture button is enabled - using ML Kit's bounding
 * box/Euler angles/eye-open classification, none of which need pixel
 * cropping. The actual embedding is computed from the full-resolution
 * still photo taken by camera.takePhoto(), where cropping/rotating an
 * image file is a well-supported, stable operation
 * (expo-image-manipulator), not a brand-new GPU pipeline.
 *
 * WHY @tensorflow/tfjs-react-native IS STILL A DEPENDENCY: only for its
 * decodeJpeg() utility, to turn the final small aligned JPEG into a raw
 * pixel tensor before normalizing it for the tflite model. It is no longer
 * used for model inference (BlazeFace/FaceRes and their bundled weight
 * files are gone - see assets/models/README.md).
 */

const MODEL_INPUT_SIZE = 112;

// How much square margin (relative to the detected face box's longer side)
// to grab in the FIRST crop, before rotation. Generous on purpose: the
// image canvas expands when rotated (see rotateLevel below), and this
// first crop needs to be big enough that the final, tightly-cropped square
// is still fully covered after that expansion, even for a fairly tilted
// head. cos(30deg)+sin(30deg) ~= 1.37, so 2.4x comfortably covers rotations
// well beyond what a normal selfie would ever have.
/**
 * CANONICAL ALIGNMENT TEMPLATE (ArcFace/InsightFace 112x112).
 *
 * This replaced ratio-of-the-bounding-box cropping, and it is the single
 * most important correctness fix in this file. MobileFaceNet of this lineage
 * is trained on faces warped onto a fixed 5-point template, NOT on "the
 * detector's box, padded by some ratio". Feeding it box crops does not
 * error - it quietly collapses the embedding space, which is exactly the
 * reported bug (a different person passing attendance).
 *
 * Measured on a real photo set (19 owner photos + 5 other people,
 * tools/face-calibration, 2026-08-27) - similarity between DIFFERENT people,
 * which should be low:
 *     box crop, ratio 1.3 (old):  mean 0.656, worst 0.748  <- unusable
 *     box crop, ratio 2.0:        mean 0.528, worst 0.690
 *     canonical alignment:        mean 0.338, worst 0.500
 * and the owner's own photos rose from 0.763 to 0.805 mean at the same time.
 * Across 400 randomised enrollment splits the worst genuine score (0.565)
 * finally sits clear of the worst impostor score (0.374); with box cropping
 * the two overlapped and NO threshold could separate them.
 *
 * Only the two eye landmarks are used. A similarity transform has 4 degrees
 * of freedom (rotation, uniform scale, translation x/y) and two points pin
 * down all four - so this is a complete alignment, not an approximation of
 * the 5-point version. That matters practically: rotation + crop + resize is
 * exactly what expo-image-manipulator can do, so no arbitrary affine warp
 * (which it cannot do) is needed.
 */
const ARC_EYE_DISTANCE = 35.2372; // 73.5318 - 38.2946, on the 112px template
// Where the midpoint between the eyes must land, as a fraction of the final
// crop: ((38.2946+73.5318)/2, (51.6963+51.5014)/2) / 112.
const ARC_EYE_CENTER_FX = 0.49926;
const ARC_EYE_CENTER_FY = 0.46070;
// The first crop only has to be loose enough that the final square is still
// covered after rotation expands the canvas (cos30+sin30 ~= 1.37 < 1.5).
const INITIAL_CROP_TO_FINAL = 1.5;

// Quality gate thresholds - see qualityGate() below. Same calibration
// caveat as FACE_MATCH_THRESHOLD: these are reasonable starting points,
// not measured values, since this can only be tuned on-device. Exported so
// the live-preview quality gate (hooks/useFaceQualityGate.ts) checks the
// exact same numbers as the hard gate enforced here on the captured photo,
// instead of a second, possibly-drifting copy of these thresholds.
export const MIN_FACE_SIZE_RATIO = 0.15; // face width vs photo width
export const MAX_YAW_DEG = 25; // yawAngle
export const MAX_PITCH_DEG = 20; // pitchAngle
export const MIN_EYE_OPEN_PROB = 0.4;

// Shared by both the enroll/verify pipeline below (static image) and the
// live quality-gate frame processor (hooks/useFaceQualityGate.ts) - same
// options shape for both, see react-native-vision-camera-face-detector's
// ImageFaceDetectorOptions / FaceDetectorOptions.
export const FACE_DETECTOR_OPTIONS = {
  performanceMode: "accurate" as const,
  runLandmarks: true,
  runContours: false,
  runClassifications: true,
  minFaceSize: MIN_FACE_SIZE_RATIO,
  trackingEnabled: false,
};

const imageFaceDetector = createImageFaceDetector(FACE_DETECTOR_OPTIONS);

// Reference-embedding storage (v2 keys + reset budget + clearAllFaceData)
// moved to utils/faceEnrollment.ts together with the separate enrollment
// flow. Only the pre-v2 legacy keys below are still cleaned up here, from
// inside getFaceEmbedding.
// Old keys from the FaceRes/BlazeFace-based pipeline (1024-d, incompatible
// dimension) - wiped once on first use of this module so a leftover old
// reference can never get compared against a new-format embedding.
const LEGACY_KEYS = ["@face_reference_embedding", "@face_reference_photo"];

export class NoFaceDetectedError extends Error {}
export class MultipleFacesDetectedError extends Error {}
export class PoorQualityFaceError extends Error {}
export class FaceModelNotReadyError extends Error {}
export class FaceEmbeddingInvalidError extends Error {}

let legacyCleanupDone = false;
async function cleanupLegacyKeysOnce(): Promise<void> {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;
  await AsyncStorage.multiRemove(LEGACY_KEYS).catch(() => {});
}

let readyPromise: Promise<void> | null = null;
function ensureTfReady(): Promise<void> {
  // Only used for decodeJpeg() below, not for running any model - see
  // module doc comment.
  if (!readyPromise) {
    readyPromise = tf.ready();
  }
  return readyPromise;
}

let modelPromise: Promise<TensorflowModel> | null = null;
function getModel(): Promise<TensorflowModel> {
  if (!modelPromise) {
    modelPromise = loadTensorflowModel(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../assets/models/mobilefacenet.tflite"),
      [],
    ).catch((error) => {
      modelPromise = null;
      throw new FaceModelNotReadyError(
        `Model pengenalan wajah gagal dimuat: ${error instanceof Error ? error.message : error}`,
      );
    });
  }
  return modelPromise;
}

// expo-image-manipulator gets the actual pixel dimensions right (it's how
// cropAlignResize below reasons about coordinates), but when MLKit finds
// *zero* faces there's nothing else to go on to tell a genuinely blank/dark
// photo apart from one where the file's real dimensions/orientation don't
// match what the live preview showed - surfacing them directly in the error
// (rather than requiring a screenshot/screen recording of the on-device
// debug view, which turned out not to always be possible) is the fastest
// way to tell those apart from a chat message alone.
function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(error),
    );
  });
}

async function detectSingleFace(photoUri: string): Promise<Face> {
  let faces: Face[] | null;
  try {
    faces = imageFaceDetector.detectFaces(photoUri);
  } catch (error) {
    // BUGFIX: the native side (patched HybridImageFaceDetector.swift) now
    // THROWS a raw NSError (domain HybridImageFaceDetector, code -10) when
    // MLKit finds zero faces, instead of returning an empty array - it was
    // added as a temporary diagnostic to surface MLKit's internal state
    // (image size/scale/orientation/color space) without Xcode Console
    // access. Left uncaught, this raw native error bypassed the "0 faces"
    // handling below entirely (fell into LKHScreen's generic Error branch),
    // which meant the user never got the debug photo modal (setDebugPhotoUri)
    // built for exactly this case - only a wall of Swift diagnostic text.
    // Route it back through the same NoFaceDetectedError path, folding the
    // native diagnostic string into the message instead of discarding it.
    const nativeMessage = error instanceof Error ? error.message : String(error);
    let sizeInfo = "";
    try {
      const { width, height } = await getImageSize(photoUri);
      sizeInfo = ` [debug: file ${width}x${height}]`;
    } catch {
      sizeInfo = " [debug: gagal baca dimensi file]";
    }
    throw new NoFaceDetectedError(
      `Wajah tidak terdeteksi. Pastikan wajah terlihat jelas dan pencahayaan cukup.${sizeInfo} [native: ${nativeMessage}]`,
    );
  }

  if (!faces || faces.length === 0) {
    let sizeInfo = "";
    try {
      const { width, height } = await getImageSize(photoUri);
      sizeInfo = ` [debug: file ${width}x${height}]`;
    } catch {
      sizeInfo = " [debug: gagal baca dimensi file]";
    }
    throw new NoFaceDetectedError(
      `Wajah tidak terdeteksi. Pastikan wajah terlihat jelas dan pencahayaan cukup.${sizeInfo}`,
    );
  }
  if (faces.length > 1) {
    throw new MultipleFacesDetectedError(
      "Terdeteksi lebih dari satu wajah. Pastikan hanya wajah Anda sendiri yang ada di frame.",
    );
  }

  return faces[0];
}

function qualityGate(face: Face): void {
  const reasons: string[] = [];

  if (face.bounds.width / face.frameWidth < MIN_FACE_SIZE_RATIO) {
    reasons.push("wajah terlalu kecil/jauh dari kamera");
  }
  if (Math.abs(face.yawAngle) > MAX_YAW_DEG) {
    reasons.push("kepala terlalu menoleh ke samping");
  }
  if (Math.abs(face.pitchAngle) > MAX_PITCH_DEG) {
    reasons.push("kepala terlalu menunduk/mendongak");
  }
  if (
    face.leftEyeOpenProbability !== undefined &&
    face.leftEyeOpenProbability < MIN_EYE_OPEN_PROB
  ) {
    reasons.push("mata kiri tidak cukup terbuka");
  }
  if (
    face.rightEyeOpenProbability !== undefined &&
    face.rightEyeOpenProbability < MIN_EYE_OPEN_PROB
  ) {
    reasons.push("mata kanan tidak cukup terbuka");
  }

  if (reasons.length > 0) {
    throw new PoorQualityFaceError(
      `Foto kurang jelas untuk verifikasi (${reasons.join(", ")}). Coba lagi dengan wajah lebih dekat, lurus menghadap kamera, dan mata terbuka.`,
    );
  }
}

/**
 * Rotation angle (degrees, expo-image-manipulator convention: positive =
 * clockwise) that levels the two eye landmarks horizontally.
 *
 * Derived (not guessed) from expo-image-manipulator's documented
 * convention ("clockwise when positive"): in image-pixel coordinates
 * (x right, y down), a visually-clockwise rotation byθ maps
 * (x,y) -> (x*cosθ - y*sinθ, x*sinθ + y*cosθ) around the pivot. Solving for
 * the θ that zeroes out the y-difference between two points A (smaller x)
 * and B (larger x) gives θ = -atan2(B.y - A.y, B.x - A.x). (Verified with
 * a concrete example: A=(0,0), B=(10,10) i.e. B lower-right of A - a "\"
 * tilt - solves to θ=-45°, and plugging that back in does level B with A.)
 * This is the OPPOSITE sign from the old TFJS pipeline's
 * tf.image.rotateWithOffset() call, because that library's "positive"
 * rotation direction is defined the other way around (counter-clockwise) -
 * see the comment that used to be in faceAuth.ts for that derivation.
 */
function computeLevelingRotationDegrees(radians: number): number {
  return -(radians * (180 / Math.PI));
}

interface Point {
  x: number;
  y: number;
}

/**
 * The two eye landmarks in TRUE image pixel coordinates, ordered
 * left-to-right.
 *
 * WHY THIS IS NOT JUST `face.landmarks.LEFT_EYE`: for still images the
 * detector library reports transposed coordinates. In its
 * HybridFace.swift, with the still-image config (scaleX = scaleY = 1,
 * no orientation), landmarks are built as
 *     Point(x: position.y, y: position.x)
 * and the box origin as
 *     Bounds(x: bbox.minY, y: bbox.minX, width: bbox.width, height: bbox.height)
 * i.e. the ORIGINS are swapped while width/height are not. (frameWidth /
 * frameHeight come straight from uiImage.size and are not swapped.) That
 * mattered little when landmarks were only used for a rotation angle - it
 * just made the angle wrong - but canonical alignment needs absolute
 * positions, where a transpose is fatal.
 *
 * Rather than hard-coding "always swap", which would silently break the day
 * the library fixes this, the correct reading is DERIVED: the tilt of the
 * eye line has to agree with the head roll the detector reports separately.
 * A transpose turns a tilt of r degrees into 90 - r, so for any realistic
 * selfie (roll well under 45 degrees) the two candidates land far apart and
 * the choice is unambiguous. Deciding this from the face box instead does
 * NOT work - for a roughly square box both readings can fall inside it.
 */
function eyePair(face: Face): [Point, Point] | null {
  const leftEye = face.landmarks?.LEFT_EYE;
  const rightEye = face.landmarks?.RIGHT_EYE;
  if (!leftEye || !rightEye) return null;

  const order = (a: Point, b: Point): [Point, Point] =>
    a.x <= b.x ? [a, b] : [b, a];

  const asReported = order(
    { x: leftEye.x, y: leftEye.y },
    { x: rightEye.x, y: rightEye.y },
  );
  const transposed = order(
    { x: leftEye.y, y: leftEye.x },
    { x: rightEye.y, y: rightEye.x },
  );

  const tiltDegrees = ([a, b]: [Point, Point]): number =>
    Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI));

  const roll = Math.abs(face.rollAngle);
  return Math.abs(tiltDegrees(transposed) - roll) <
    Math.abs(tiltDegrees(asReported) - roll)
    ? transposed
    : asReported;
}

/**
 * Warps the face onto the canonical 112x112 template (see the ARC_* constants
 * above) and returns the resulting file's URI. See the module doc comment for
 * why this happens on the still photo file rather than a live camera frame.
 *
 * The target transform is a similarity transform - rotate the eye line level,
 * scale so the eyes sit ARC_EYE_DISTANCE apart, translate so their midpoint
 * lands on the template's eye midpoint. expo-image-manipulator has no affine
 * warp, but it does not need one: rotate supplies the rotation, the crop
 * origin supplies the translation, and resize supplies the scale. The only
 * subtlety is that rotate() always pivots around the image's own centre, so
 * the eye midpoint has to be tracked through that rotation rather than
 * assumed to stay put (it does not, once a crop has been clamped against the
 * photo edge).
 */
async function cropAlignResize(
  photoUri: string,
  face: Face,
  eyes: [Point, Point],
): Promise<string> {
  const [leftEye, rightEye] = eyes;
  const photoWidth = face.frameWidth;
  const photoHeight = face.frameHeight;

  const eyeDeltaX = rightEye.x - leftEye.x;
  const eyeDeltaY = rightEye.y - leftEye.y;
  const eyeDistance = Math.hypot(eyeDeltaX, eyeDeltaY);
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const eyeCenterY = (leftEye.y + rightEye.y) / 2;

  // The crop that, once resized to 112px, puts the eyes exactly
  // ARC_EYE_DISTANCE apart.
  const finalSide = (eyeDistance * MODEL_INPUT_SIZE) / ARC_EYE_DISTANCE;

  // Step 1: loose square around the eye midpoint, clamped inside the photo.
  const initialSide = Math.min(
    finalSide * INITIAL_CROP_TO_FINAL,
    photoWidth,
    photoHeight,
  );
  const initialOriginX = clamp(
    eyeCenterX - initialSide / 2,
    0,
    photoWidth - initialSide,
  );
  const initialOriginY = clamp(
    eyeCenterY - initialSide / 2,
    0,
    photoHeight - initialSide,
  );

  const step1 = await ImageManipulator.manipulateAsync(
    photoUri,
    [
      {
        crop: {
          originX: initialOriginX,
          originY: initialOriginY,
          width: initialSide,
          height: initialSide,
        },
      },
    ],
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
  );

  // Where the eye midpoint sits inside that crop.
  let trackedEyeX = eyeCenterX - initialOriginX;
  let trackedEyeY = eyeCenterY - initialOriginY;

  // Step 2: rotate the eye line level. The canvas grows, and the pivot is
  // step1's centre - not the eye midpoint - so carry the midpoint through
  // the same rotation to know where it ended up.
  const radians = Math.atan2(eyeDeltaY, eyeDeltaX);
  const rotationDegrees = computeLevelingRotationDegrees(radians);
  let step2 = step1;
  if (Math.abs(rotationDegrees) >= 0.5) {
    step2 = await ImageManipulator.manipulateAsync(
      step1.uri,
      [{ rotate: rotationDegrees }],
      { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
    );
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const offsetX = trackedEyeX - step1.width / 2;
    const offsetY = trackedEyeY - step1.height / 2;
    trackedEyeX = step2.width / 2 + (offsetX * cos + offsetY * sin);
    trackedEyeY = step2.height / 2 + (-offsetX * sin + offsetY * cos);
  }

  // Step 3: place the template's eye midpoint on the tracked one, then
  // resize - the crop origin is the translation, the resize is the scale.
  const croppedSide = Math.min(finalSide, step2.width, step2.height);
  const finalOriginX = clamp(
    trackedEyeX - croppedSide * ARC_EYE_CENTER_FX,
    0,
    step2.width - croppedSide,
  );
  const finalOriginY = clamp(
    trackedEyeY - croppedSide * ARC_EYE_CENTER_FY,
    0,
    step2.height - croppedSide,
  );

  const step3 = await ImageManipulator.manipulateAsync(
    step2.uri,
    [
      {
        crop: {
          originX: finalOriginX,
          originY: finalOriginY,
          width: croppedSide,
          height: croppedSide,
        },
      },
      { resize: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE } },
    ],
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
  );

  return step3.uri;
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.max(min, Math.min(max, value));
}

async function fileToNormalizedInputBuffer(uri: string): Promise<ArrayBuffer> {
  await ensureTfReady();
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = toByteArray(base64);
  const imageTensor = decodeJpeg(bytes, 3);
  try {
    // (pixel - 127.5) / 128 -> roughly -1..1, the standard preprocessing
    // for this MobileFaceNet lineage - see module doc comment.
    const normalized = imageTensor
      .toFloat()
      .sub(tf.scalar(127.5))
      .div(tf.scalar(128));
    const batched = normalized.reshape([
      1,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
      3,
    ]);
    const data = await batched.data();
    batched.dispose();
    normalized.dispose();
    // Float32Array.buffer is the exact ArrayBuffer fast-tflite expects -
    // TS types it as ArrayBufferLike (could theoretically be a
    // SharedArrayBuffer) but a tensor's .data() always allocates a plain
    // ArrayBuffer.
    return (data as Float32Array).buffer as ArrayBuffer;
  } finally {
    imageTensor.dispose();
  }
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Runs the full pipeline on a captured selfie and returns its L2-normalized
 * 192-d MobileFaceNet embedding. Same function used by BOTH sides of every
 * comparison - each enrollment capture (components/FaceEnrollmentModal.tsx)
 * and every attendance probe (LKHScreen.takeSelfie) - see module doc
 * comment for why identical preprocessing on both sides is the single most
 * important consistency guarantee. Throws
 * NoFaceDetectedError / MultipleFacesDetectedError / PoorQualityFaceError
 * when the photo isn't usable.
 */
export async function getFaceEmbedding(photoUri: string): Promise<Float32Array> {
  await cleanupLegacyKeysOnce();

  const face = await detectSingleFace(photoUri);
  qualityGate(face);

  // Without both eye landmarks the canonical alignment cannot be computed.
  // Fail here rather than falling back to a plain box crop: an unaligned
  // embedding is not comparable with an aligned one, so a silent fallback
  // would poison the enrollment set or the comparison with a value that
  // looks perfectly valid. See the ARC_* constants for what alignment buys.
  const eyes = eyePair(face);
  if (!eyes) {
    throw new PoorQualityFaceError(
      "Posisi mata tidak terbaca dari foto. Coba lagi menghadap kamera dengan mata terbuka dan pencahayaan lebih baik.",
    );
  }

  const alignedUri = await cropAlignResize(photoUri, face, eyes);
  const inputBuffer = await fileToNormalizedInputBuffer(alignedUri);

  const model = await getModel();
  const outputs = await model.run([inputBuffer]);
  const raw = new Float32Array(outputs[0]);
  const embedding = l2Normalize(raw);
  // BUGFIX: a broken tensor pipeline upstream (see the platform_react_native
  // registration fix elsewhere in this file) was able to run to completion
  // without throwing while still producing an embedding full of NaN - this
  // then got persisted (via what is now saveEnrollment() in
  // faceEnrollment.ts), silently poisoning every later faceSimilarity()
  // comparison ("kemiripan NaN%") since a dot product involving NaN is
  // always NaN. Fail loudly here instead, for both enrollment captures and
  // attendance probes, so a broken embedding can never be saved or compared
  // against in the first place.
  if (embedding.some((value) => !Number.isFinite(value))) {
    // Same reasoning as the "[debug: file WxH]" string in
    // NoFaceDetectedError: there is no Xcode console on this build, so the
    // numbers that would identify WHICH stage went wrong have to travel out
    // through the alert itself. Without them "data tidak valid" is a dead
    // end - it says the embedding is NaN but nothing about why.
    let alignedInfo = "?";
    try {
      const { width, height } = await getImageSize(alignedUri);
      alignedInfo = `${width}x${height}`;
    } catch {
      alignedInfo = "gagal dibaca";
    }
    const nanCount = embedding.reduce(
      (n, v) => n + (Number.isFinite(v) ? 0 : 1),
      0,
    );
    throw new FaceEmbeddingInvalidError(
      "Gagal memproses foto wajah (data tidak valid). Coba ambil ulang foto." +
        ` [debug: frame ${face.frameWidth}x${face.frameHeight}` +
        ` box ${Math.round(face.bounds.x)},${Math.round(face.bounds.y)}` +
        ` ${Math.round(face.bounds.width)}x${Math.round(face.bounds.height)}` +
        ` mata ${Math.round(eyes[0].x)},${Math.round(eyes[0].y)}` +
        ` -> ${Math.round(eyes[1].x)},${Math.round(eyes[1].y)}` +
        ` aligned ${alignedInfo} nan ${nanCount}/${embedding.length}]`,
    );
  }
  return embedding;
}

/**
 * Cosine similarity between two L2-normalized embeddings (equivalent to a
 * plain dot product once both are unit vectors) - the metric this model's
 * embedding space was actually trained for, unlike the old FaceRes model.
 * Range -1..1 in theory, but for genuinely different faces from this model
 * family it typically sits around 0..0.4, and >0.9 for the same face under
 * good conditions. See FACE_MATCH_THRESHOLD's calibration note.
 */
export function faceSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) dot += a[i] * b[i];
  return dot;
}

// CALIBRATION STATUS: measured (tools/face-calibration, 2026-08-27) on 19
// owner photos across two sessions plus 5 other people. Over 400 randomised
// enrollment splits (3-5 photos, both session directions), using canonical
// alignment and median aggregation:
//     worst genuine score  0.565
//     worst impostor score 0.374
//     0 of 400 splits had the two overlap
// 0.47 is the midpoint of that worst-case gap, so the two error types carry
// roughly equal headroom (~0.10 each).
//
// This is much lower than the 0.6-0.62 that stood here before, and that is
// expected rather than alarming: the old numbers were tuned on box-cropped
// embeddings, where EVERY face scored high against every other. Canonical
// alignment pushed impostor scores down (different people now average 0.34,
// not 0.66), so the whole scale shifted. A threshold from the old pipeline
// is meaningless against the new one.
//
// CAVEAT: five impostor identities is still few, and four of them contribute
// a single photo each. The worst impostor score is the figure most likely to
// be underestimated. Re-run the calibration as more faces become available.
//
// CARA MENGKALIBRASI ULANG (dua jalan, yang pertama tidak butuh build iOS):
//  1. tools/face-calibration/calibrate.py - jalankan model yang sama di PC
//     atas foto Anda sendiri + foto orang lain. Lihat README di folder itu.
//  2. Di perangkat: tiap percobaan absen mencatat skornya lewat
//     logSimilaritySample() (lihat LKHScreen.takeSelfie), dibaca dari
//     halaman Profil.
//
// PENTING - JANGAN UBAH SENDIRIAN: nilai ini hanya berarti untuk pasangan
// alignment kanonik (ARC_* di atas) + agregasi median (similarityToEnrollment
// di faceEnrollment.ts). Mengubah salah satunya menggeser seluruh skala skor,
// jadi ambang ini harus diukur ulang bersamaan.
export const FACE_MATCH_THRESHOLD = 0.47;

/**
 * Enrollment cross-check ONLY (enforced per-capture in
 * components/FaceEnrollmentModal.tsx): each new enrollment capture must beat
 * this against every capture already accepted in the same session.
 *
 * Deliberately MUCH looser than FACE_MATCH_THRESHOLD, and a separate
 * constant on purpose: the enrollment prompts (turn slightly left/right,
 * change expression, different lighting) intentionally push consecutive
 * captures of the SAME face apart, so enforcing verification-level
 * similarity here would reject legitimate variation. This floor exists only
 * to catch a mid-enrollment PERSON SWAP (someone else leaning into frame),
 * not to enforce consistency. Do not reuse or unify with
 * FACE_MATCH_THRESHOLD - they answer different questions.
 */
// RAISED from 0.35 alongside the alignment fix. 0.35 was calibrated against
// box-cropped embeddings; under canonical alignment two DIFFERENT people
// average 0.34, so the old value sat right on the impostor mean and would
// have waved a person swap straight through. Same-session captures of one
// person score far higher (0.80 mean, 0.54 worst even across sessions), so
// 0.45 still leaves plenty of room for the deliberate pose variation the
// enrollment prompts ask for.
export const ENROLLMENT_CONSISTENCY_MIN = 0.45;

export const CALIBRATION_LOG_KEY = "@face_calibration_log";
const MAX_CALIBRATION_LOG_ENTRIES = 200;

/**
 * Appends a similarity sample to a small on-device log (AsyncStorage) for
 * threshold calibration - call this on every verify attempt (both accepted
 * and rejected), labeling whether you personally know it was your own face
 * or someone else's. Read it back with getCalibrationLog(). This never
 * gets sent anywhere - it's purely a local debugging aid.
 */
export async function logSimilaritySample(
  similarity: number,
  label: "self" | "other" | "unknown",
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CALIBRATION_LOG_KEY);
    const log: { t: number; s: number; label: string }[] = raw ? JSON.parse(raw) : [];
    log.push({ t: Date.now(), s: Math.round(similarity * 10000) / 10000, label });
    while (log.length > MAX_CALIBRATION_LOG_ENTRIES) log.shift();
    await AsyncStorage.setItem(CALIBRATION_LOG_KEY, JSON.stringify(log));
    console.log(`[FaceCalibration] similarity=${similarity.toFixed(4)} label=${label}`);
  } catch {
    // Best-effort only - never let logging break the actual verify flow.
  }
}

export async function getCalibrationLog(): Promise<
  { t: number; s: number; label: string }[]
> {
  const raw = await AsyncStorage.getItem(CALIBRATION_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function clearCalibrationLog(): Promise<void> {
  await AsyncStorage.removeItem(CALIBRATION_LOG_KEY);
}
