/**
 * Doğum yeri → enlem/boylam çözümleme.
 *
 * Katmanlı strateji:
 *   1) Yerleşik şehir listesi (anında, ağ gerektirmez) — en sık kullanılan şehirler
 *   2) Veritabanı cache'i — daha önce çözülmüş aramalar
 *   3) Nominatim (OpenStreetMap) geocoding API — ücretsiz, API key gerektirmez
 *
 * Nominatim kullanım şartları saniyede 1 istek ve tanımlayıcı bir User-Agent gerektirir.
 * Yüksek hacimde Google Geocoding / Mapbox gibi ücretli bir servise geçilmelidir
 * (GEOCODER env değişkeni ile sağlayıcı değiştirilebilir hale getirilebilir).
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
  timezone: string;
  label?: string;
}

const CITIES: Record<string, GeoPoint> = {
  istanbul: { latitude: 41.0082, longitude: 28.9784, timezone: "Europe/Istanbul" },
  ankara: { latitude: 39.9334, longitude: 32.8597, timezone: "Europe/Istanbul" },
  izmir: { latitude: 38.4237, longitude: 27.1428, timezone: "Europe/Istanbul" },
  bursa: { latitude: 40.1826, longitude: 29.0665, timezone: "Europe/Istanbul" },
  antalya: { latitude: 36.8969, longitude: 30.7133, timezone: "Europe/Istanbul" },
  adana: { latitude: 37.0, longitude: 35.3213, timezone: "Europe/Istanbul" },
  konya: { latitude: 37.8746, longitude: 32.4932, timezone: "Europe/Istanbul" },
  gaziantep: { latitude: 37.0662, longitude: 37.3833, timezone: "Europe/Istanbul" },
  kayseri: { latitude: 38.7312, longitude: 35.4787, timezone: "Europe/Istanbul" },
  eskisehir: { latitude: 39.7767, longitude: 30.5206, timezone: "Europe/Istanbul" },
  trabzon: { latitude: 41.0015, longitude: 39.7178, timezone: "Europe/Istanbul" },
  diyarbakir: { latitude: 37.9144, longitude: 40.2306, timezone: "Europe/Istanbul" },
  samsun: { latitude: 41.2867, longitude: 36.33, timezone: "Europe/Istanbul" },
  mersin: { latitude: 36.8121, longitude: 34.6415, timezone: "Europe/Istanbul" },
  denizli: { latitude: 37.7765, longitude: 29.0864, timezone: "Europe/Istanbul" },
  sanliurfa: { latitude: 37.1591, longitude: 38.7969, timezone: "Europe/Istanbul" },
  malatya: { latitude: 38.3552, longitude: 38.3095, timezone: "Europe/Istanbul" },
  erzurum: { latitude: 39.9, longitude: 41.27, timezone: "Europe/Istanbul" },
  van: { latitude: 38.4891, longitude: 43.4089, timezone: "Europe/Istanbul" },
  london: { latitude: 51.5074, longitude: -0.1278, timezone: "Europe/London" },
  paris: { latitude: 48.8566, longitude: 2.3522, timezone: "Europe/Paris" },
  berlin: { latitude: 52.52, longitude: 13.405, timezone: "Europe/Berlin" },
  amsterdam: { latitude: 52.3676, longitude: 4.9041, timezone: "Europe/Amsterdam" },
  "new york": { latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
  "los angeles": { latitude: 34.0522, longitude: -118.2437, timezone: "America/Los_Angeles" },
  dubai: { latitude: 25.2048, longitude: 55.2708, timezone: "Asia/Dubai" },
};

/**
 * Prisma'yı gecikmeli (lazy) yükler: geocoding cache'i opsiyonel bir optimizasyondur,
 * DB erişilemezse şehir çözümlemesi yine de çalışmaya devam etmelidir.
 */
async function getPrisma() {
  try {
    const mod = await import("./prisma");
    return mod.prisma;
  } catch {
    return null;
  }
}

/** Türkçe karakterleri normalize ederek arama anahtarı üretir. */
export function normalize(city: string) {
  return city
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/\s+/g, " ");
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = process.env.GEOCODER_USER_AGENT || "AstroApp/1.0 (astrology birth chart app)";

/** Nominatim rate limit'i (1 req/sn) için basit sıralayıcı. */
let lastRequestAt = 0;
async function throttle() {
  const wait = 1100 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function geocodeRemote(city: string): Promise<GeoPoint | null> {
  await throttle();
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(city)}&format=json&limit=1&addressdetails=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "tr,en" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const results = (await res.json()) as any[];
    if (!results?.length) return null;
    const r = results[0];
    return {
      latitude: parseFloat(r.lat),
      longitude: parseFloat(r.lon),
      // ÖNEMLİ — karıştırılmasın: Nominatim gerçek saat dilimi döndürmez, bu alan
      // sadece bilgi amaçlıdır ve HİÇBİR HESAPLAMADA KULLANILMAZ.
      //
      // Doğum haritası hesaplamasının kendi saat dilimi çözümü VARDIR ve buradan
      // bağımsız çalışır: astrology.ts'teki efemeris kütüphanesi (computeChart),
      // verilen enlem/boylamdan doğum anının saat dilimini KENDİSİ hesaplar —
      // tarihsel DST kuralları dahil (örn. Türkiye 2010'da kışın UTC+2, yazın
      // UTC+3; kütüphane bunu doğru uyguluyor, test edilerek doğrulandı — bkz.
      // tests/astrology.test.ts "Saat dilimi UTC'ye doğru çevriliyor").
      //
      // Yani: bu "UTC" placeholder'ı doğum haritasının yanlış hesaplanmasına
      // yol açmaz. Gerçek bir eksiklik değil, sadece kullanılmayan bir alan.
      // İstersen ileride burayı gerçek bir tz-lookup servisiyle (örn.
      // timezonedb.com, Google Time Zone API) doldurup uygulamada "doğum yeri:
      // Europe/Istanbul" gibi göstermek amacıyla kullanabilirsin — ama bu
      // yalnızca GÖRSEL/bilgilendirme amaçlıdır, hesaplama doğruluğunu etkilemez.
      timezone: "UTC",
      label: r.display_name,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Şehri koordinata çevirir. Bulunamazsa null döner —
 * çağıran taraf bunu kullanıcıya anlamlı bir hata olarak iletmeli.
 */
export async function resolveCity(city: string): Promise<GeoPoint | null> {
  const key = normalize(city);
  if (!key) return null;

  // 1) Yerleşik liste
  if (CITIES[key]) return CITIES[key];

  // 2) DB cache
  const prisma = await getPrisma();
  try {
    const cached = await prisma?.geocodeCache.findUnique({ where: { query: key } });
    if (cached) {
      if (cached.latitude == null || cached.longitude == null) return null; // negatif sonuç da cache'lenir
      return {
        latitude: cached.latitude,
        longitude: cached.longitude,
        timezone: cached.timezone || "UTC",
        label: cached.label || undefined,
      };
    }
  } catch {
    // cache tablosu yoksa/erişilemezse sessizce devam et
  }

  // 3) Uzak geocoding
  const remote = await geocodeRemote(city);

  try {
    await prisma?.geocodeCache.upsert({
      where: { query: key },
      update: {
        latitude: remote?.latitude ?? null,
        longitude: remote?.longitude ?? null,
        timezone: remote?.timezone ?? null,
        label: remote?.label ?? null,
      },
      create: {
        query: key,
        latitude: remote?.latitude ?? null,
        longitude: remote?.longitude ?? null,
        timezone: remote?.timezone ?? null,
        label: remote?.label ?? null,
      },
    });
  } catch {
    // cache yazılamazsa sonucu yine de döndür
  }

  return remote;
}

/** Şehir arama önerileri (mobil uygulamadaki autocomplete için). */
export async function searchCities(query: string): Promise<GeoPoint[]> {
  const key = normalize(query);
  if (!key) return [];

  const local = Object.entries(CITIES)
    .filter(([name]) => name.startsWith(key))
    .map(([name, p]) => ({ ...p, label: name }));

  if (local.length) return local.slice(0, 8);

  const remote = await resolveCity(query);
  return remote ? [remote] : [];
}

export const KNOWN_CITIES = Object.keys(CITIES);
