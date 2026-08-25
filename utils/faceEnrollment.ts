import AsyncStorage from "@react-native-async-storage/async-storage";
import { CALIBRATION_LOG_KEY, faceSimilarity } from "./faceAuthNative";

/**
 * Storage & verification layer for the SEPARATE enrollment flow (replaces
 * the old silent "first attendance photo becomes the reference" behavior
 * that used to live in LKHScreen.takeSelfie).
 *
 * Enrollment now happens up front in components/FaceEnrollmentModal.tsx:
 * the user captures 3-5 selfies (each one forced through the exact same
 * getFaceEmbedding() pipeline as verification - see module doc comment in
 * faceAuthNative.ts), and ALL of their embeddings are stored. Verification
 * compares a probe against every enrolled embedding and takes the HIGHEST
 * similarity (bestSimilarityToEnrollment below) - multiple captures cover
 * pose/expression/lighting variation, so genuine matches survive conditions
 * a single reference would miss.
 *
 * This module owns ONLY persistence + comparison + migration. It never
 * touches the camera or the model - it imports from faceAuthNative (never
 * the other way around), so the pipeline stays testable without storage.
 *
 * Storage shape ("@face_enrollment_v3", JSON):
 *   {
 *     version: 3,
 *     createdAt: number,          // epoch ms
 *     embeddings: number[][]      // 3-5 arrays of 192 floats
 *     photos: string[]            // file:// URIs of the capture photos
 *   }
 */

export const MIN_ENROLLMENT_PHOTOS = 3;
export const MAX_ENROLLMENT_PHOTOS = 5;

const ENROLLMENT_KEY = "@face_enrollment_v3";

// Deliberately the SAME key the old single-reference pipeline used for its
// reset budget (was RESET_COUNT_KEY in faceAuthNative.ts) - users who already
// spent some of their MAX_FACE_RESETS keep exactly that remaining budget
// instead of getting a fresh allowance when this flow ships.
const RESET_COUNT_KEY = "@face_reference_reset_count";
export const MAX_FACE_RESETS = 3;

// v2 single-embedding keys (written by saveReferenceEmbedding in the old
// pipeline). Migrated once into v3 by migrateLegacyV2Once, then removed so
// they can never shadow or split state again.
const LEGACY_EMBEDDING_KEY = "@face_reference_embedding_v2";
const LEGACY_PHOTO_KEY = "@face_reference_photo_v2";

interface StoredEnrollment {
  version: 3;
  createdAt: number;
  embeddings: number[][];
  photos: string[];
}

let migrationDone = false;

/**
 * Soft migration (design decision: NOT force-re-enroll): an install that
 * still has the old single-embedding reference gets it wrapped as a
 * one-element v3 set. max-of-1 is numerically identical to the old
 * comparison, so migrated users keep working seamlessly mid-KKN - they can
 * optionally complete a full multi-photo enrollment later. Idempotent,
 * runs at most once per app session, and wipes the legacy keys either way
 * so a corrupt value can't linger.
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
        const enrollment: StoredEnrollment = {
          version: 3,
          createdAt: Date.now(),
          embeddings: [parsed as number[]],
          photos: photoUri ? [photoUri] : [],
        };
        await AsyncStorage.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
      }
      await AsyncStorage.multiRemove([LEGACY_EMBEDDING_KEY, LEGACY_PHOTO_KEY]);
    }
  } catch {
    // Best-effort only: a corrupt/unreadable legacy value just means that
    // user enrolls fresh through the modal. Never block on migration.
  }
  migrationDone = true;
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

export async function isEnrolled(): Promise<boolean> {
  await migrateLegacyV2Once();
  return parseEnrollment(await AsyncStorage.getItem(ENROLLMENT_KEY)) !== null;
}

/** All enrolled embeddings, or null if the user hasn't enrolled (yet/anymore). */
export async function getEnrollments(): Promise<Float32Array[] | null> {
  await migrateLegacyV2Once();
  const stored = parseEnrollment(await AsyncStorage.getItem(ENROLLMENT_KEY));
  if (!stored) return null;
  return stored.embeddings.map((e) => Float32Array.from(e));
}

export async function saveEnrollment(
  embeddings: Float32Array[],
  photoUris: string[],
): Promise<void> {
  if (embeddings.length === 0) {
    throw new Error("Tidak ada data wajah untuk disimpan.");
  }
  const enrollment: StoredEnrollment = {
    version: 3,
    createdAt: Date.now(),
    embeddings: embeddings.map((e) => Array.from(e)),
    photos: photoUris,
  };
  await AsyncStorage.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
}

/**
 * Highest cosine similarity between `query` and EVERY enrolled embedding -
 * the multi-reference replacement for the old single
 * faceSimilarity(reference, probe). Null when there is nothing enrolled:
 * callers must treat that as "not enrolled", not as score 0.
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
  await AsyncStorage.removeItem(ENROLLMENT_KEY);
}

async function getFaceResetCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(RESET_COUNT_KEY);
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getRemainingFaceResets(): Promise<number> {
  const count = await getFaceResetCount();
  return Math.max(0, MAX_FACE_RESETS - count);
}

/**
 * Clears the WHOLE enrolled embedding set so the user must redo the full
 * 3-5 photo enrollment before attending again (unlike the old flow, there
 * is no fallback to "next photo becomes the reference" - enrollment only
 * ever happens through FaceEnrollmentModal now). Limited to MAX_FACE_RESETS
 * uses so it can't be used to repeatedly swap in someone else's face.
 * Returns false if the limit has already been reached (data is left
 * untouched in that case).
 */
export async function resetEnrollment(): Promise<boolean> {
  const count = await getFaceResetCount();
  if (count >= MAX_FACE_RESETS) return false;
  await clearEnrollment();
  await AsyncStorage.setItem(RESET_COUNT_KEY, String(count + 1));
  return true;
}

/** Wipes all local face-verification state, e.g. on logout/account switch. */
export async function clearAllFaceData(): Promise<void> {
  await AsyncStorage.multiRemove([
    ENROLLMENT_KEY,
    LEGACY_EMBEDDING_KEY,
    LEGACY_PHOTO_KEY,
    RESET_COUNT_KEY,
    CALIBRATION_LOG_KEY,
  ]);
}
