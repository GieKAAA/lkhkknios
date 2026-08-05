import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

/**
 * Location-based attendance restriction: blocks absen when the device is
 * further than MAX_DISTANCE_KM from the student's posko (KKN post).
 *
 * NOTE ON SCOPE: the actual request was "within 10km or can't be outside the
 * kecamatan". Checking a real kecamatan administrative boundary needs either
 * a paid maps/geocoding API or bundled GeoJSON boundary data - not practical
 * for an Expo Go app with no backend. A fixed-radius check is used instead
 * as a practical approximation (a kecamatan is roughly this scale).
 *
 * PER-ACCOUNT LOCATION: the posko location is resolved per student, not a
 * single hardcoded point for everyone (KKN students are placed at different
 * posko). Resolution order (see resolvePoskoLocation()):
 *   1. `wilayahKec.setting.koordinat` from the LKH server's /api/peserta
 *      response (captured in LoginScreen.js as profile.poskoKoordinat) -
 *      the real posko/kecamatan coordinate, when the server has it filled
 *      in. Observed to often be empty (not yet set by an admin), so...
 *   2. Fallback: geocode the student's kecamatan+kabupaten name (from the
 *      same profile) via OpenStreetMap Nominatim (free, no API key) to get
 *      an approximate kecamatan-center point. Cached locally so it's only
 *      looked up once per kecamatan.
 *   3. If neither works (no profile data, no internet for geocoding), the
 *      location can't be verified at all - checkAttendanceLocation() then
 *      *allows* the attendance rather than blocking it (fail-open), since
 *      face verification remains the primary anti-titip-absen defense and
 *      blocking a legitimate student over missing reference data would be
 *      worse than the geofence being skipped for that one attempt.
 */

export const MAX_DISTANCE_KM = 10;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface ProfileLocationHint {
  kecamatan?: string | null;
  kabupaten?: string | null;
  poskoKoordinat?: string | null;
}

export class LocationPermissionDeniedError extends Error {}
export class LocationUnavailableError extends Error {}

/** Haversine great-circle distance between two lat/long points, in km. */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const EARTH_RADIUS_KM = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_KM * c;
}

function isValidCoordinate(c: Coordinates): boolean {
  return (
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    Math.abs(c.latitude) <= 90 &&
    Math.abs(c.longitude) <= 180 &&
    // (0,0) almost always means "actually empty/unset", not Null Island.
    !(c.latitude === 0 && c.longitude === 0)
  );
}

/**
 * Parses a "lat,long" (or "lat;long") style string as commonly used for a
 * single free-text coordinate field. Returns null if the string is empty or
 * not in a recognizable format.
 */
function parseCoordinateString(raw: string): Coordinates | null {
  const parts = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const coord: Coordinates = {
    latitude: parseFloat(parts[0]),
    longitude: parseFloat(parts[1]),
  };
  return isValidCoordinate(coord) ? coord : null;
}

const GEOCODE_CACHE_PREFIX = "@geocode_cache_";

/**
 * Resolves a kecamatan+kabupaten name to approximate coordinates via
 * OpenStreetMap's free Nominatim geocoder, caching the result locally.
 * Returns null if the lookup fails (no internet, no match, etc.) - this is
 * a best-effort fallback, not a guaranteed source.
 */
async function geocodeKecamatan(
  kecamatan: string,
  kabupaten: string,
): Promise<Coordinates | null> {
  const cacheKey = `${GEOCODE_CACHE_PREFIX}${kecamatan}_${kabupaten}`.toLowerCase();

  const cached = await AsyncStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Coordinates;
      if (isValidCoordinate(parsed)) return parsed;
    } catch {
      // fall through and re-fetch
    }
  }

  try {
    const query = encodeURIComponent(`${kecamatan}, ${kabupaten}, Indonesia`);
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      {
        headers: {
          // Nominatim's usage policy requires an identifying User-Agent.
          "User-Agent": "lkh-kkn-ios (KKN attendance app, geofence lookup)",
        },
      },
    );
    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) return null;

    const coord: Coordinates = {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };
    if (!isValidCoordinate(coord)) return null;

    await AsyncStorage.setItem(cacheKey, JSON.stringify(coord));
    return coord;
  } catch {
    return null;
  }
}

/**
 * Resolves the posko location to check attendance against, for a specific
 * student's profile. See module doc comment for the resolution order.
 */
export async function resolvePoskoLocation(
  hint: ProfileLocationHint,
): Promise<Coordinates | null> {
  if (hint.poskoKoordinat) {
    const parsed = parseCoordinateString(hint.poskoKoordinat);
    if (parsed) return parsed;
  }
  if (hint.kecamatan && hint.kabupaten) {
    return geocodeKecamatan(hint.kecamatan, hint.kabupaten);
  }
  return null;
}

export interface GeofenceCheckResult {
  allowed: boolean;
  distanceKm: number | null;
  /** True when the posko location couldn't be resolved at all - the check
   * was skipped (fail-open) rather than genuinely passing. */
  locationUnresolved: boolean;
  /** The device's own GPS coordinates at check time - callers that need to
   * submit "where this attendance happened" (e.g. syncing to the server)
   * can reuse this instead of requesting location again. */
  userLocation: Coordinates;
}

/**
 * Gets the device's current GPS position and checks it against the given
 * posko location. Throws LocationPermissionDeniedError if permission is
 * denied, or LocationUnavailableError if a GPS fix can't be obtained (e.g.
 * indoors with no signal, location services off).
 */
export async function checkAttendanceLocation(
  poskoLocation: Coordinates | null,
): Promise<GeofenceCheckResult> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== "granted") {
    throw new LocationPermissionDeniedError(
      "Izin lokasi dibutuhkan untuk memverifikasi posisi absensi.",
    );
  }

  let position: Location.LocationObject;
  try {
    position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
  } catch {
    throw new LocationUnavailableError(
      "Tidak bisa mendapatkan lokasi GPS. Pastikan layanan lokasi aktif dan coba lagi di area terbuka.",
    );
  }

  const userLocation: Coordinates = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };

  if (!poskoLocation) {
    return {
      allowed: true,
      distanceKm: null,
      locationUnresolved: true,
      userLocation,
    };
  }

  const distance = distanceKm(poskoLocation, userLocation);

  return {
    allowed: distance <= MAX_DISTANCE_KM,
    distanceKm: distance,
    locationUnresolved: false,
    userLocation,
  };
}
