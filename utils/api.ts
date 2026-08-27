import { API_USER_AGENT, APP_VERSION, getDeviceInfoStr } from "./deviceInfo";

/**
 * Lapisan tipis di atas fetch() untuk API LKH KKN.
 *
 * Sebelum ini setiap pemanggil (LoginScreen, LKHScreen, ProfileScreen)
 * mengulang hal yang sama sendiri-sendiri: menempel base URL, menyusun
 * query `device_info`/`version`, memasang header Bearer + User-Agent Dart,
 * membaca respons sebagai teks dulu untuk mendeteksi HTML (sesi kadaluarsa /
 * block page Cloudflare), baru JSON.parse, lalu membongkar amplop
 * {statusCode, data, desc}. Enam salinan aturan yang sama berarti enam
 * tempat yang bisa lupa salah satunya - dan lupa User-Agent saja sudah
 * cukup membuat request tidak pernah sampai ke server (lihat deviceInfo.ts).
 *
 * Modul ini tidak mengubah perilaku apa pun, hanya menyatukan aturannya.
 */

export const API_BASE = "https://lkh-kkn.uin-alauddin.ac.id";

/** Server membalas HTML, bukan JSON - token kadaluarsa atau diblokir WAF. */
export class SessionExpiredError extends Error {}

/** Server menjawab dengan benar tapi menolak permintaannya. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

interface ApiEnvelope<T> {
  statusCode?: number;
  data?: T;
  desc?: string;
  message?: string;
}

function buildUrl(path: string, params?: Record<string, string | number>): string {
  const query = new URLSearchParams({
    ...(params
      ? Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        )
      : {}),
    version: APP_VERSION,
  }).toString();
  // getDeviceInfoStr() sudah URL-encoded, jadi ditempel manual - melewatkannya
  // lewat URLSearchParams akan meng-encode ulang tanda %-nya.
  return `${API_BASE}${path}?${query}&device_info=${getDeviceInfoStr()}`;
}

function authHeaders(token: string, extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": API_USER_AGENT,
    ...extra,
  };
}

/**
 * Baca respons, deteksi HTML, bongkar amplop {statusCode, data, desc}.
 * Melempar SessionExpiredError untuk HTML dan ApiError untuk penolakan yang
 * formatnya benar - pesan asli server dipertahankan apa adanya, karena
 * itulah satu-satunya petunjuk saat nama field harus dikoreksi (API ini
 * direkonstruksi dari APK, bukan dari dokumentasi).
 */
async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim().startsWith("<")) {
    throw new SessionExpiredError(
      "Sesi login kadaluarsa atau permintaan diblokir server.",
    );
  }

  let parsed: ApiEnvelope<T>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      `Server merespons non-JSON (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 200),
    );
  }

  const ok =
    response.ok && (parsed.statusCode === undefined || parsed.statusCode === 200);
  if (!ok) {
    throw new ApiError(
      parsed.desc || parsed.message || `HTTP ${response.status}`,
      response.status,
      text.slice(0, 200),
    );
  }
  return (parsed.data ?? (parsed as unknown)) as T;
}

export async function apiGet<T>(
  path: string,
  token: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const response = await fetch(buildUrl(path, params), {
    method: "GET",
    headers: authHeaders(token, { "Accept-Encoding": "gzip" }),
  });
  return unwrap<T>(response);
}

/**
 * POST multipart. Bentuk ini dipakai (bukan JSON) karena itu yang terbukti
 * diterima endpoint lain di server yang sama - lihat catatan di
 * scripts/login-probe2.ps1: hipotesis JSON sudah diuji dan tidak membuat
 * server berperilaku beda.
 */
export async function apiPostForm<T>(
  path: string,
  token: string,
  fields: Record<string, string | Blob>,
): Promise<T> {
  const body = new FormData();
  body.append("device_info", decodeURIComponent(getDeviceInfoStr()));
  body.append("version", APP_VERSION);
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value as string);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(token, { Accept: "application/json" }),
    body,
  });
  return unwrap<T>(response);
}
