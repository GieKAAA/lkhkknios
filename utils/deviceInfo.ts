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
