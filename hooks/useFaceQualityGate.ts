import { useCallback, useState } from "react";
import type { Face } from "react-native-vision-camera-face-detector";
import {
  MAX_PITCH_DEG,
  MAX_YAW_DEG,
  MIN_EYE_OPEN_PROB,
  MIN_FACE_SIZE_RATIO,
} from "../utils/faceAuthNative";

/**
 * Live, real-time-preview-only quality gate: drives the on-screen guidance
 * text and whether the capture button is enabled, using
 * react-native-vision-camera-face-detector's `onFacesDetected` callback
 * (fired on the JS thread for every processed frame - see
 * react-native-vision-camera-face-detector's <Camera> wrapper).
 *
 * This does NOT decide whether a captured photo is usable - that's a
 * separate, authoritative check (qualityGate() in utils/faceAuthNative.ts)
 * run again on the actual captured photo. This hook only exists so the
 * user gets instant feedback ("dekatkan wajah", "hadapkan lurus", ...)
 * before they even press the shutter, using the exact same thresholds so
 * the live "ready" state doesn't lie about what the hard gate will accept.
 */
export function useFaceQualityGate() {
  const [isReady, setIsReady] = useState(false);
  const [message, setMessage] = useState("Posisikan wajah Anda di dalam bingkai");

  const onFacesDetected = useCallback((faces: Face[]) => {
    if (!faces || faces.length === 0) {
      setIsReady(false);
      setMessage("Wajah tidak terdeteksi");
      return;
    }
    if (faces.length > 1) {
      setIsReady(false);
      setMessage("Terdeteksi lebih dari satu wajah");
      return;
    }

    const face = faces[0];
    if (face.bounds.width / face.frameWidth < MIN_FACE_SIZE_RATIO) {
      setIsReady(false);
      setMessage("Dekatkan wajah Anda ke kamera");
      return;
    }
    if (Math.abs(face.yawAngle) > MAX_YAW_DEG) {
      setIsReady(false);
      setMessage("Hadapkan wajah lurus ke kamera");
      return;
    }
    if (Math.abs(face.pitchAngle) > MAX_PITCH_DEG) {
      setIsReady(false);
      setMessage("Luruskan pandangan ke kamera");
      return;
    }
    if (
      (face.leftEyeOpenProbability !== undefined &&
        face.leftEyeOpenProbability < MIN_EYE_OPEN_PROB) ||
      (face.rightEyeOpenProbability !== undefined &&
        face.rightEyeOpenProbability < MIN_EYE_OPEN_PROB)
    ) {
      setIsReady(false);
      setMessage("Buka mata Anda");
      return;
    }

    setIsReady(true);
    setMessage("Siap - tekan tombol untuk mengambil foto");
  }, []);

  const onFaceDetectionError = useCallback((error: Error) => {
    console.error("Gagal mendeteksi wajah (live preview)", error);
  }, []);

  return { isReady, message, onFacesDetected, onFaceDetectionError };
}
