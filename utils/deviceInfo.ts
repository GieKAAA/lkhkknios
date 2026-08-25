/**
 * Version string sent to every LKH API call (`version=...`). Centralized so
 * a server-side minimum-version gate can be answered from ONE place - the
 * official Flutter app's own version string is the value most likely to be
 * accepted (see LoginScreen/LKHScreen usage).
 */
export const APP_VERSION = "1.1.1";

/**
 * User-Agent that mirrors the official Flutter/Dart app. Cloudflare's WAF in
 * front of lkh-kkn.uin-alauddin.ac.id blocks requests whose User-Agent is not
 * a Dart one (verified via scripts/login-probe3.ps1 variant 3/4: identical
 * POST reached the backend with this UA but got an HTML block page without
 * it). Every request to that server - fetch() AND <Image> sources alike -
 * must send this header or it never reaches the app.
 */
export const API_USER_AGENT = "Dart/3.8 (dart:io)";

/**
 * Fixed device fingerprint required by the LKH KKN server's security check
 * (it rejects requests whose `device_info` doesn't look like a real device).
 * Shared by LoginScreen, LKHScreen and ProfileScreen, which all talk to the
 * same API.
 */
const DEVICE_INFO = {
  "version.sdkInt": 28,
  "version.release": "9",
  "version.codename": "REL",
  "version.baseOS": "",
  brand: "vivo",
  device: "marlin",
  display: "PQ3A.190605.07081642 release-keys",
  hardware: "qcom",
  id: "PQ3A.190605.07081642",
  manufacturer: "vivo",
  model: "V2241A",
  product: "V2241A",
  type: "user",
  isPhysicalDevice: true,
  serialNumber: "unknown",
  isLowRamDevice: false,
};

export function getDeviceInfoObject() {
  return DEVICE_INFO;
}

/** URL-encoded JSON string, for use directly in a query string. */
export function getDeviceInfoStr(): string {
  return encodeURIComponent(JSON.stringify(DEVICE_INFO));
}
