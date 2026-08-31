/**
 * AI güvenlik katmanı (madde 9, 42).
 *
 * Sistem prompt'u modele ne yapmaması gerektiğini SÖYLER, ama garanti etmez.
 * Bu katman iki yönde çalışır:
 *
 *   1. Girdi tarafı: kullanıcı kriz, sağlık veya intihar konusunda yazdıysa
 *      astroloji yorumu ÜRETİLMEZ — AI'ya hiç gidilmez, destekleyici bir yanıt döner.
 *      Bir astroloji uygulamasının "yıldızlara göre iyileşeceksin" demesi tehlikelidir.
 *
 *   2. Çıktı tarafı: model yine de yasak bir iddiada bulunduysa yakalanır.
 *
 * Kelime listeleri kaçınılmaz olarak eksiktir; amaç mükemmel filtre değil,
 * en açık ve en riskli durumlarda yanlış davranmamaktır.
 */

export type RiskCategory = "self_harm" | "medical" | "none";

export interface SafetyCheck {
  category: RiskCategory;
  blocked: boolean;
  response?: string;
}

/** Türkçe metni normalize eder — büyük/küçük harf ve aksan farklarını eler. */
function normalize(text: string) {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/\s+/g, " ");
}

/**
 * Kendine zarar verme / intihar sinyalleri.
 * Yanlış pozitif, yanlış negatiften daha kabul edilebilir: bu konuda
 * gereksiz yere destek mesajı göstermek, gerçek bir krizi kaçırmaktan iyidir.
 */
const SELF_HARM_PATTERNS = [
  "intihar",
  "kendimi oldur",
  "kendimi olduru",
  "olmek istiyorum",
  "olsem daha iyi",
  "olsem mi",
  "yasamak istemiyorum",
  "hayatima son",
  "canima kiy",
  "kendime zarar",
  "artik dayanamiyorum",
  "bitirmek istiyorum hayat",
];

/** Tıbbi teşhis/tedavi soruları — astroloji uygulaması bunlara cevap vermemeli. */
const MEDICAL_PATTERNS = [
  "kanser mi",
  "hastaligim gececek mi",
  "hastaligim gecer mi",
  "iyilesecek miyim",
  "ilacimi birak",
  "ilaci birak",
  "ilac kullanmayi birak",
  "tedaviyi birak",
  "ameliyat olmali miyim",
  "doktora gitmeli miyim",
  "teshis",
  "hamile miyim",
];

/** Ölüm zamanı/öngörüsü soruları — kesinlikle cevaplanmamalı. */
const DEATH_PREDICTION_PATTERNS = [
  "ne zaman olecegim",
  "ne zaman olurum",
  "olum tarihim",
  "kac yasinda olecegim",
  "ne zaman olecek",
  "olecek mi",
];

const SELF_HARM_RESPONSE = `Yazdıkların için teşekkür ederim; bunu paylaşmak kolay değil. Şu an zorlandığını duyuyorum ve bu konuda sana yıldızlarla cevap vermek doğru olmaz.

Böyle anlarda yalnız kalmamak önemli. Güvendiğin birine — bir yakınına, arkadaşına ya da bir uzmana — bugün ulaşabilir misin?

Kendini güvende hissetmiyorsan ya da acil bir durumdaysan **112**'yi arayabilirsin. Bir ruh sağlığı uzmanıyla konuşmak da iyi gelebilir.

Buradayım ve başka bir şey konuşmak istersen seni dinlerim.`;

const MEDICAL_RESPONSE = `Bu konuda sana astrolojiyle bir şey söylemem doğru olmaz — sağlıkla ilgili sorular gerçek bir değerlendirme gerektiriyor ve yıldız haritası bunun yerini tutamaz.

Bir doktora ya da ilgili uzmana danışmanı öneririm. İlaç veya tedavi kullanıyorsan, doktoruna sormadan değişiklik yapma.

Aklındaki başka bir konuda — ilişkiler, kariyer, kişisel gelişim — seninle konuşmaktan memnuniyet duyarım.`;

const DEATH_RESPONSE = `Bu soruya cevap vermem doğru olmaz. Astroloji ölüm zamanı gibi şeyleri söyleyemez; söylediğini iddia eden bir yorum da güvenilir değildir.

Bu soruyu soran bir kaygı varsa onun hakkında konuşabiliriz — ya da hayatındaki başka bir alana bakabiliriz.`;

function containsAny(text: string, patterns: string[]) {
  return patterns.some((p) => text.includes(p));
}

/**
 * Kullanıcı mesajını AI'ya göndermeden ÖNCE kontrol eder.
 * `blocked: true` dönerse AI çağrısı yapılmamalı, `response` doğrudan kullanıcıya gösterilmeli.
 */
export function checkUserMessage(message: string): SafetyCheck {
  const text = normalize(message);

  if (containsAny(text, SELF_HARM_PATTERNS)) {
    return { category: "self_harm", blocked: true, response: SELF_HARM_RESPONSE };
  }
  if (containsAny(text, DEATH_PREDICTION_PATTERNS)) {
    return { category: "medical", blocked: true, response: DEATH_RESPONSE };
  }
  if (containsAny(text, MEDICAL_PATTERNS)) {
    return { category: "medical", blocked: true, response: MEDICAL_RESPONSE };
  }

  return { category: "none", blocked: false };
}

/* ------------------------------ çıktı doğrulama ------------------------------ */

/** Modelin ASLA üretmemesi gereken iddialar. */
const FORBIDDEN_OUTPUT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bolece(k|gi)(sin|niz)\b/i, reason: "ölüm öngörüsü" },
  { pattern: /olum(un|unuz) (yakin|yaklas)/i, reason: "ölüm öngörüsü" },
  { pattern: /kanser|tumor|felc gecir/i, reason: "hastalık iddiası" },
  { pattern: /ilac(ini|inizi)? (birak|kes)/i, reason: "tedavi müdahalesi" },
  { pattern: /(hisse|bitcoin|kripto|altin)(a| )?(al|yatirim yap)/i, reason: "yatırım tavsiyesi" },
  { pattern: /kesinlikle (olacak|gerceklesecek)/i, reason: "kesinlik iddiası" },
  { pattern: /dava(yi|niz) (kazanacak|kaybedecek)/i, reason: "hukuki öngörü" },
];

export interface OutputCheck {
  safe: boolean;
  reason?: string;
}

/**
 * Model çıktısını kullanıcıya göstermeden önce doğrular.
 * Güvenli değilse çağıran taraf yorumu göstermemeli, yeniden üretmeli veya hata döndürmeli.
 */
export function checkAiOutput(output: string): OutputCheck {
  const text = normalize(output);
  for (const { pattern, reason } of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, reason };
    }
  }
  return { safe: true };
}

/* ------------------------------ klişe tespiti ------------------------------ */

/**
 * Madde 36: AI'ın sürekli aynı kalıpları kullanmasını engelle.
 * Bu bir engelleme değil, ÖLÇÜM aracıdır — çıktı kalitesini izlemek için loglanır.
 */
const CLICHE_PATTERNS = [
  "bugun harika bir gun",
  "evrene guven",
  "heyecan verici bir sey olabilir",
  "kendine inan",
  "her sey yoluna girecek",
  "pozitif enerji",
  "ic sesini dinle",
];

export function countCliches(text: string): number {
  const t = normalize(text);
  return CLICHE_PATTERNS.filter((c) => t.includes(c)).length;
}
