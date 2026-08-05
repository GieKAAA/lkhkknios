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
 * "embeddings", no l2_normalize op, no quantize/dequantize op, no second
 * "phase_train" input). Practical consequences of that:
 *  - Single input tensor [1,112,112,3] float32 RGB, single output
 *    [1,192] float32 - matches react-native-fast-tflite's
 *    `model.run([buffer])` / `runSync([buffer])` single-in/single-out shape.
 *  - The 192-d output is NOT L2-normalized by the model itself - this file
 *    normalizes it after inference (see l2Normalize below). MobileFaceNet
 *    is virtually always trained with an ArcFace/CosFace-style angular
 *    margin loss, i.e. cosine similarity between L2-normalized embeddings
 *    is the metric the model's embedding space was actually shaped for -
 *    unlike the OLD FaceRes model, cosine similarity is the right choice
 *    here, not a Euclidean-distance workaround.
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
 *     -> crop a generous square around the face, rotate it level using the
 *        eye landmarks, crop again tightly, resize to 112x112
 *        (expo-image-manipulator)
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
const INITIAL_CROP_RATIO = 2.4;
// Final crop margin (relative to face box's longer side) after alignment -
// same padding philosophy as the old pipeline's CROP_PADDING_RATIO: enough
// context (forehead/chin/ears) without diluting the identity signal with
// background/hair.
const FINAL_CROP_RATIO = 1.3;

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

const REFERENCE_EMBEDDING_KEY = "@face_reference_embedding_v2";
const REFERENCE_PHOTO_KEY = "@face_reference_photo_v2";
// Old keys from the FaceRes/BlazeFace-based pipeline (1024-d, incompatible
// dimension) - wiped once on first use of this module so a leftover old
// reference can never get compared against a new-format embedding.
const LEGACY_KEYS = ["@face_reference_embedding", "@face_reference_photo"];

export class NoFaceDetectedError extends Error {}
export class MultipleFacesDetectedError extends Error {}
export class PoorQualityFaceError extends Error {}
export class FaceModelNotReadyError extends Error {}

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
  const faces = imageFaceDetector.detectFaces(photoUri);

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
function computeLevelingRotationDegrees(face: Face): number {
  const landmarks = face.landmarks;
  const leftEye = landmarks?.LEFT_EYE;
  const rightEye = landmarks?.RIGHT_EYE;
  if (!leftEye || !rightEye) return 0;

  const [a, b] =
    leftEye.x <= rightEye.x ? [leftEye, rightEye] : [rightEye, leftEye];
  const radians = Math.atan2(b.y - a.y, b.x - a.x);
  return -(radians * (180 / Math.PI));
}

/**
 * Crops a square around the face, rotates it level using the eye
 * landmarks, crops tightly again, and resizes to MODEL_INPUT_SIZE. Returns
 * the resulting file's URI. See the module doc comment for why this
 * happens on the still photo file rather than a live camera frame.
 */
async function cropAlignResize(photoUri: string, face: Face): Promise<string> {
  const photoWidth = face.frameWidth;
  const photoHeight = face.frameHeight;
  const faceSize = Math.max(face.bounds.width, face.bounds.height);
  const faceCenterX = face.bounds.x + face.bounds.width / 2;
  const faceCenterY = face.bounds.y + face.bounds.height / 2;

  // Step 1: generous square crop centered on the face, in original-photo
  // pixel coordinates. Clamped to stay inside the photo.
  const initialSide = Math.min(
    faceSize * INITIAL_CROP_RATIO,
    photoWidth,
    photoHeight,
  );
  const initialOriginX = clamp(
    faceCenterX - initialSide / 2,
    0,
    photoWidth - initialSide,
  );
  const initialOriginY = clamp(
    faceCenterY - initialSide / 2,
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

  // Step 2: rotate level. expo-image-manipulator's rotate() pivots around
  // the image's own center and expands the canvas to fit - since step1 was
  // centered on the face, the face stays centered (in the new, larger
  // canvas) after this.
  const rotationDegrees = computeLevelingRotationDegrees(face);
  const step2 =
    Math.abs(rotationDegrees) < 0.5
      ? step1
      : await ImageManipulator.manipulateAsync(
          step1.uri,
          [{ rotate: rotationDegrees }],
          { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
        );

  // Step 3: final tight crop (centered on step2's own center, which is
  // still the face center) + resize to the model's input size, in one call.
  const finalSide = Math.min(
    faceSize * FINAL_CROP_RATIO,
    step2.width,
    step2.height,
  );
  const finalOriginX = clamp(
    step2.width / 2 - finalSide / 2,
    0,
    step2.width - finalSide,
  );
  const finalOriginY = clamp(
    step2.height / 2 - finalSide / 2,
    0,
    step2.height - finalSide,
  );

  const step3 = await ImageManipulator.manipulateAsync(
    step2.uri,
    [
      {
        crop: {
          originX: finalOriginX,
          originY: finalOriginY,
          width: finalSide,
          height: finalSide,
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
 * 192-d MobileFaceNet embedding. Same function used for both enroll (first
 * photo, becomes the reference) and verify (compare against the reference)
 * - see module doc comment for why that matters. Throws
 * NoFaceDetectedError / MultipleFacesDetectedError / PoorQualityFaceError
 * when the photo isn't usable.
 */
export async function getFaceEmbedding(photoUri: string): Promise<Float32Array> {
  await cleanupLegacyKeysOnce();

  const face = await detectSingleFace(photoUri);
  qualityGate(face);

  const alignedUri = await cropAlignResize(photoUri, face);
  const inputBuffer = await fileToNormalizedInputBuffer(alignedUri);

  const model = await getModel();
  const outputs = await model.run([inputBuffer]);
  const raw = new Float32Array(outputs[0]);
  return l2Normalize(raw);
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

// CALIBRATION STATUS: starting guess, not a measured value - same caveat
// as the old pipeline. Cosine similarity between L2-normalized
// ArcFace/CosFace-style embeddings (this model family) commonly separates
// genuine/impostor pairs somewhere around 0.4-0.5, but that depends on
// this exact model's training data and needs on-device verification. Every
// attendance attempt logs its score (see logSimilaritySample below) -
// collect a handful of your own face vs. someone else's face, look at
// where the two clusters of numbers separate, and update this constant.
export const FACE_MATCH_THRESHOLD = 0.5;

const CALIBRATION_LOG_KEY = "@face_calibration_log";
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

export async function getReferenceEmbedding(): Promise<Float32Array | null> {
  await cleanupLegacyKeysOnce();
  const json = await AsyncStorage.getItem(REFERENCE_EMBEDDING_KEY);
  return json ? Float32Array.from(JSON.parse(json)) : null;
}

export async function saveReferenceEmbedding(
  embedding: Float32Array,
  photoUri: string,
): Promise<void> {
  await AsyncStorage.setItem(
    REFERENCE_EMBEDDING_KEY,
    JSON.stringify(Array.from(embedding)),
  );
  await AsyncStorage.setItem(REFERENCE_PHOTO_KEY, photoUri);
}

export async function clearReferenceEmbedding(): Promise<void> {
  await AsyncStorage.multiRemove([REFERENCE_EMBEDDING_KEY, REFERENCE_PHOTO_KEY]);
}

const RESET_COUNT_KEY = "@face_reference_reset_count";
export const MAX_FACE_RESETS = 3;

export async function getFaceResetCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(RESET_COUNT_KEY);
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getRemainingFaceResets(): Promise<number> {
  const count = await getFaceResetCount();
  return Math.max(0, MAX_FACE_RESETS - count);
}

/**
 * Clears the reference face so the next attendance photo becomes the new
 * baseline - e.g. when the first registration photo came out blurry or was
 * captured by mistake. Limited to MAX_FACE_RESETS uses so it can't be used
 * to repeatedly swap in someone else's face. Returns false if the limit has
 * already been reached (embedding is left untouched in that case).
 */
export async function resetReferenceFace(): Promise<boolean> {
  const count = await getFaceResetCount();
  if (count >= MAX_FACE_RESETS) return false;
  await clearReferenceEmbedding();
  await AsyncStorage.setItem(RESET_COUNT_KEY, String(count + 1));
  return true;
}

/** Wipes all local face-verification state, e.g. on logout/account switch. */
export async function clearAllFaceData(): Promise<void> {
  await AsyncStorage.multiRemove([
    REFERENCE_EMBEDDING_KEY,
    REFERENCE_PHOTO_KEY,
    RESET_COUNT_KEY,
    CALIBRATION_LOG_KEY,
  ]);
}
