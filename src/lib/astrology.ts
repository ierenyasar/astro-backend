// @ts-ignore — kütüphane kendi tip tanımlarını sağlamıyor
import { Origin, Horoscope } from "circular-natal-horoscope-js";
import { resolveCity, GeoPoint } from "./geo";

export const SIGNS = [
  { name: "Aries", tr: "Koç", element: "Fire", ruler: "Mars" },
  { name: "Taurus", tr: "Boğa", element: "Earth", ruler: "Venus" },
  { name: "Gemini", tr: "İkizler", element: "Air", ruler: "Mercury" },
  { name: "Cancer", tr: "Yengeç", element: "Water", ruler: "Moon" },
  { name: "Leo", tr: "Aslan", element: "Fire", ruler: "Sun" },
  { name: "Virgo", tr: "Başak", element: "Earth", ruler: "Mercury" },
  { name: "Libra", tr: "Terazi", element: "Air", ruler: "Venus" },
  { name: "Scorpio", tr: "Akrep", element: "Water", ruler: "Pluto" },
  { name: "Sagittarius", tr: "Yay", element: "Fire", ruler: "Jupiter" },
  { name: "Capricorn", tr: "Oğlak", element: "Earth", ruler: "Saturn" },
  { name: "Aquarius", tr: "Kova", element: "Air", ruler: "Uranus" },
  { name: "Pisces", tr: "Balık", element: "Water", ruler: "Neptune" },
] as const;

export type SignName = (typeof SIGNS)[number]["name"];

export function signByName(name: string) {
  return SIGNS.find((s) => s.name === name) ?? SIGNS[0];
}

/** Doğum saati bilinmiyorsa kullanılan varsayılan saat — SADECE Güneş burcu için güvenilir. */
const DEFAULT_HOUR = 12;
const DEFAULT_MINUTE = 0;

const PLANET_KEYS = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"] as const;

export interface ComputedChart {
  sunSign: SignName;
  sunDegree: number;
  moonSign: SignName | null;
  moonDegree: number;
  risingSign: SignName | null;
  risingDegree: number | null;
  planets: Record<string, { sign: string; degree: number; house: number | null; retrograde: boolean }> | null;
  houses: { house: number; sign: string; degree: number }[] | null;
  aspects: { a: string; b: string; type: string; orb: number }[] | null;
  housesAvailable: boolean;
  /** Doğum saati bilinmediğinde Ay burcu gün içinde değişebileceği için belirsizdir. */
  moonUncertain: boolean;
}

export class GeocodingError extends Error {}

/**
 * Gerçek efemeris hesaplaması (circular-natal-horoscope-js, tropical zodiac, Placidus houses).
 *
 * Doğum saati bilinmiyorsa:
 * - Yükselen burç ve evler hesaplanmaz (null döner) — bunlar saate tamamen bağlıdır.
 * - Ay burcu öğlen 12:00 varsayımıyla hesaplanır ama Ay ~2.5 günde bir burç değiştirdiği için
 *   gün içinde geçiş olabilir; bu durumda `moonUncertain: true` işaretlenir ve UI'da belirtilmelidir.
 *
 * SAAT DİLİMİ: Kütüphane verilen saati doğum YERİNİN yerel saati olarak yorumlar ve
 * koordinattan saat dilimini kendisi çözer — tarihsel DST kuralları dahil (örn. Türkiye
 * 2010'da kışın UTC+2, yazın UTC+3). Bu yüzden ayrıca offset uygulamak GEREKMEZ;
 * uygulanırsa çift dönüşüm olur ve harita bozulur. Bkz. tests/astrology.test.ts.
 */
export async function computeChart(params: {
  birthDate: Date;
  birthTime: string | null;
  birthTimeKnown: boolean;
  birthCity: string;
  latitude?: number | null;
  longitude?: number | null;
}): Promise<ComputedChart> {
  let geo: GeoPoint | null = null;
  if (params.latitude != null && params.longitude != null) {
    // "UTC" burada da (geo.ts'teki gibi) yalnızca yer tutucu bir etikettir —
    // aşağıdaki Origin/Horoscope hesaplaması saat dilimini enlem/boylamdan
    // kendisi çözer, bu alana bakmaz. Bkz. geo.ts'teki GeoPoint.timezone notu.
    geo = { latitude: params.latitude, longitude: params.longitude, timezone: "UTC" };
  } else {
    geo = await resolveCity(params.birthCity);
  }
  if (!geo) {
    throw new GeocodingError(
      `"${params.birthCity}" için konum bilgisi bulunamadı. Lütfen şehri farklı yazmayı dene.`
    );
  }

  let hour = DEFAULT_HOUR;
  let minute = DEFAULT_MINUTE;
  if (params.birthTimeKnown && params.birthTime) {
    const [h, m] = params.birthTime.split(":").map((n) => parseInt(n, 10));
    if (!Number.isNaN(h)) hour = h;
    if (!Number.isNaN(m)) minute = m;
  }

  const origin = new Origin({
    year: params.birthDate.getUTCFullYear(),
    month: params.birthDate.getUTCMonth(), // kütüphane 0-indexed ay bekliyor
    date: params.birthDate.getUTCDate(),
    hour,
    minute,
    latitude: geo.latitude,
    longitude: geo.longitude,
  });

  const horoscope = new Horoscope({
    origin,
    houseSystem: "placidus",
    zodiac: "tropical",
    aspectPoints: ["bodies"],
    aspectWithPoints: ["bodies"],
    aspectTypes: ["major"],
    language: "en",
  });

  const bodies = horoscope.CelestialBodies;
  const timeKnown = params.birthTimeKnown && !!params.birthTime;

  const planets: NonNullable<ComputedChart["planets"]> = {};
  for (const key of PLANET_KEYS) {
    const b = bodies[key];
    if (!b) continue;
    planets[key] = {
      sign: b.Sign.label,
      // Ekliptik derece (0-360) — dairesel harita görselleştirmesinde gezegeni
      // burcun ortasına değil gerçek konumuna yerleştirmek için gerekli
      degree: Number(b.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0),
      house: timeKnown && b.House ? b.House.id : null,
      retrograde: !!b.isRetrograde,
    };
  }

  // Placidus ev sistemi eşit aralıklı DEĞİLDİR; her evin gerçek başlangıç derecesi taşınır
  const houses = timeKnown
    ? horoscope.Houses.map((h: any) => ({
        house: h.id,
        sign: h.Sign.label,
        degree: Number(h.ChartPosition?.StartPosition?.Ecliptic?.DecimalDegrees ?? 0),
      }))
    : null;

  const aspectsRaw = (horoscope.Aspects?.all ?? []) as any[];
  const aspects = aspectsRaw.map((a) => ({
    a: a.point1Key,
    b: a.point2Key,
    type: a.aspectKey,
    orb: Number(a.orb),
  }));

  return {
    sunSign: bodies.sun.Sign.label as SignName,
    sunDegree: Number(bodies.sun.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0),
    moonSign: bodies.moon.Sign.label as SignName,
    moonDegree: Number(bodies.moon.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0),
    risingSign: timeKnown ? (horoscope.Ascendant.Sign.label as SignName) : null,
    risingDegree: timeKnown
      ? Number(horoscope.Ascendant.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0)
      : null,
    planets,
    houses,
    aspects: aspects.length ? aspects : null,
    housesAvailable: timeKnown,
    moonUncertain: !timeKnown,
  };
}

/**
 * Sadece Güneş burcu gereken yerler için (örn. partner uyumu) hafif, senkron hesaplama.
 * Güneş burcu koordinattan pratikte bağımsız olduğu için sabit bir referans nokta kullanılır
 * ve geocoding'e (dolayısıyla ağ isteğine) hiç gidilmez.
 */
export function getSunSign(birthDate: Date) {
  const origin = new Origin({
    year: birthDate.getUTCFullYear(),
    month: birthDate.getUTCMonth(),
    date: birthDate.getUTCDate(),
    hour: DEFAULT_HOUR,
    minute: DEFAULT_MINUTE,
    latitude: 0,
    longitude: 0,
  });
  const horoscope = new Horoscope({
    origin,
    houseSystem: "placidus",
    zodiac: "tropical",
    aspectTypes: ["major"],
    language: "en",
  });
  return signByName(horoscope.CelestialBodies.sun.Sign.label);
}


/* ------------------------------ günlük enerji puanları ------------------------------ */

/**
 * Ana ekrandaki alan puanları (enerji / aşk / kariyer / para).
 *
 * Daha önce bu değerler sabitti — her kullanıcı aynı yıldızları görüyordu, ki bu
 * "kişiselleştirilmiş" vaadiyle çelişiyordu. Artık kullanıcının DOĞUM haritasındaki
 * gezegen konumları ile O GÜNKÜ transit konumlar arasındaki açılardan hesaplanır.
 *
 * Yöntem: her alan için ilgili gezegenlere bakılır; uyumlu açılar (kavuşum, üçgen,
 * altmışlık) puanı yükseltir, sert açılar (kare, karşıt) düşürür. Sonuç 1-5 arasına
 * ölçeklenir ve gün içinde sabittir (aynı gün tekrar hesaplanınca aynı çıkar).
 */

/** İki ekliptik derece arasındaki en kısa açısal mesafe (0-180). */
function angularDistance(a: number, b: number) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Açının uyumlu mu sert mi olduğunu ve etkisini döndürür. */
function aspectScore(distance: number) {
  const ORB = 8; // etki alanı
  const harmonious = [0, 60, 120];
  const challenging = [90, 180];

  for (const angle of harmonious) {
    if (Math.abs(distance - angle) <= ORB) {
      // Açı tam olduğunda etki güçlü, orb kenarında zayıf
      return 1 - Math.abs(distance - angle) / ORB;
    }
  }
  for (const angle of challenging) {
    if (Math.abs(distance - angle) <= ORB) {
      return -(1 - Math.abs(distance - angle) / ORB);
    }
  }
  return 0;
}

/** Alanlara göre hangi gezegenlerin dikkate alınacağı. */
const DOMAIN_PLANETS: Record<string, string[]> = {
  energy: ["sun", "mars"],
  love: ["venus", "moon"],
  career: ["saturn", "sun", "mars"],
  money: ["jupiter", "venus"],
};

export interface DailyScores {
  energy: number;
  love: number;
  career: number;
  money: number;
}

/**
 * Doğum haritası ile verilen günün transitlerini karşılaştırıp 1-5 arası puan üretir.
 * `natal`: computeChart çıktısındaki gezegen dereceleri (sun/moon dahil).
 */
export function computeDailyScores(
  natal: { sun: number; moon: number; planets: Record<string, { degree: number }> },
  date = new Date()
): DailyScores {
  // O günün gökyüzü — konum enlem/boylamdan neredeyse bağımsız olduğu için sabit referans yeterli
  const origin = new Origin({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    date: date.getUTCDate(),
    hour: 12,
    minute: 0,
    latitude: 0,
    longitude: 0,
  });
  const transit = new Horoscope({
    origin,
    houseSystem: "placidus",
    zodiac: "tropical",
    aspectTypes: ["major"],
    language: "en",
  });

  const transitDegrees: Record<string, number> = {
    sun: Number(transit.CelestialBodies.sun.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0),
    moon: Number(transit.CelestialBodies.moon.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0),
  };
  for (const key of PLANET_KEYS) {
    const b = transit.CelestialBodies[key];
    if (b) transitDegrees[key] = Number(b.ChartPosition?.Ecliptic?.DecimalDegrees ?? 0);
  }

  const natalDegrees: Record<string, number> = { sun: natal.sun, moon: natal.moon };
  for (const [key, val] of Object.entries(natal.planets || {})) {
    natalDegrees[key] = val.degree;
  }

  const result: Record<string, number> = {};

  for (const [domain, planets] of Object.entries(DOMAIN_PLANETS)) {
    let total = 0;
    let count = 0;

    for (const planet of planets) {
      const natalDeg = natalDegrees[planet];
      if (natalDeg == null) continue;

      // Her natal gezegeni, tüm transit gezegenlerle karşılaştır
      for (const [, transitDeg] of Object.entries(transitDegrees)) {
        total += aspectScore(angularDistance(natalDeg, transitDeg));
        count++;
      }
    }

    // Ortalama etkiyi 1-5 aralığına taşı; etki yoksa nötr (3)
    const avg = count > 0 ? total / count : 0;
    const scaled = Math.round(3 + avg * 6);
    result[domain] = Math.max(1, Math.min(5, scaled));
  }

  return result as unknown as DailyScores;
}


/* ------------------------------ sinastri (uyum) ------------------------------ */

/**
 * İki doğum haritası arasındaki uyum (sinastri).
 *
 * Daha önce bu puanlar isim+tarih string'inin hash'inden üretiliyordu — yani
 * astrolojiyle hiçbir ilgisi yoktu. Elimizde gerçek efemeris varken bu gereksizdi.
 * Artık iki haritanın gezegenleri arasındaki AÇILAR hesaplanıyor.
 *
 * Alan eşlemesi geleneksel sinastri yaklaşımını izler:
 *   iletişim      → Merkür, Ay
 *   duygusal bağ  → Ay, Güneş
 *   kimya         → Venüs, Mars
 *   uzun vade     → Satürn, Güneş, Jüpiter
 */

const SYNASTRY_DOMAINS: Record<string, string[]> = {
  communication: ["mercury", "moon"],
  emotionalConnection: ["moon", "sun"],
  chemistry: ["venus", "mars"],
  longTermPotential: ["saturn", "sun", "jupiter"],
};

export interface SynastryScores {
  overall: number;
  communication: number;
  emotionalConnection: number;
  chemistry: number;
  longTermPotential: number;
}

export interface NatalDegrees {
  sun: number;
  moon: number;
  planets: Record<string, { degree: number }>;
}

function degreeMap(natal: NatalDegrees): Record<string, number> {
  const map: Record<string, number> = { sun: natal.sun, moon: natal.moon };
  for (const [k, v] of Object.entries(natal.planets || {})) map[k] = v.degree;
  return map;
}

/**
 * İki harita arasındaki açılardan 40-95 aralığında uyum yüzdeleri üretir.
 * Deterministiktir: aynı iki harita her zaman aynı sonucu verir.
 */
export function computeSynastry(a: NatalDegrees, b: NatalDegrees): SynastryScores {
  const degA = degreeMap(a);
  const degB = degreeMap(b);

  const scoreDomain = (planets: string[]) => {
    let total = 0;
    let count = 0;

    for (const planet of planets) {
      const own = degA[planet];
      if (own == null) continue;
      // Kişinin ilgili gezegenini partnerin TÜM gezegenleriyle karşılaştır
      for (const [, otherDeg] of Object.entries(degB)) {
        total += aspectScore(angularDistance(own, otherDeg));
        count++;
      }
      // Simetrik olsun diye ters yönü de hesaba kat
      const partnerOwn = degB[planet];
      if (partnerOwn != null) {
        for (const [, ownDeg] of Object.entries(degA)) {
          total += aspectScore(angularDistance(partnerOwn, ownDeg));
          count++;
        }
      }
    }

    if (count === 0) return 65;
    const avg = total / count;
    // Ortalama etki genelde dar bir aralıkta kalır; okunabilir bir yüzdeye ölçekle
    const scaled = Math.round(68 + avg * 120);
    return Math.max(40, Math.min(95, scaled));
  };

  const communication = scoreDomain(SYNASTRY_DOMAINS.communication);
  const emotionalConnection = scoreDomain(SYNASTRY_DOMAINS.emotionalConnection);
  const chemistry = scoreDomain(SYNASTRY_DOMAINS.chemistry);
  const longTermPotential = scoreDomain(SYNASTRY_DOMAINS.longTermPotential);

  const overall = Math.round(
    (communication + emotionalConnection + chemistry + longTermPotential) / 4
  );

  return { overall, communication, emotionalConnection, chemistry, longTermPotential };
}
