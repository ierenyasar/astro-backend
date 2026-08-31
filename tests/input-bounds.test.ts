import { z } from "zod";

/**
 * Bu testler route dosyalarındaki Zod şemalarının bir KOPYASINI değil,
 * doğrudan kaynaktan (regex ile) çıkarılan sınır değerlerini kontrol eder —
 * şema route dosyasında değişirse test de otomatik güncellenmiş sayılmaz,
 * bu yüzden burada şemaları YENİDEN TANIMLAMIYORUZ, gerçek dosyaları okuyup
 * ilgili alanın `.max(N)` içerip içermediğini doğruluyoruz.
 */

import fs from "fs";
import path from "path";

let pass = 0,
  fail = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log("PASS:", name);
    pass++;
  } catch (e: any) {
    console.log("FAIL:", name, "-", e.message);
    fail++;
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function read(file: string) {
  return fs.readFileSync(path.join(__dirname, "..", "src", "routes", file), "utf8");
}

/**
 * `fieldName: z.string()...` satırının bir yerinde `.max(` çağrısı var mı kontrol eder.
 * AI prompt'una gömülen veya dış servise gönderilen her serbest metin alanının
 * bir üst sınırı OLMALI — aksi halde kullanıcı devasa bir string göndererek
 * gereksiz AI token maliyeti veya dış API kötüye kullanımı yaratabilir.
 */
function hasMaxBound(src: string, fieldName: string) {
  // Satır sonuna kadar yakalanır (virgülde değil) — çünkü ".min(8, \"mesaj\")" gibi
  // çağrıların kendi argümanları arasındaki virgül erken kesilmeye yol açardı.
  const re = new RegExp(`${fieldName}:\\s*z\\.string\\(\\)[^\\n]*`, "g");
  const matches = [...src.matchAll(re)];
  if (!matches.length) return null; // alan bulunamadı
  return matches.every((m) => /\.max\(/.test(m[0]));
}

const userSrc = read("user.ts");
const astrologySrc = read("astrology.ts");
const compatibilitySrc = read("compatibility.ts");
const notificationsSrc = read("notifications.ts");
const chatSrc = read("chat.ts");
const authSrc = read("auth.ts");
const subscriptionSrc = read("subscription.ts");

/* ---------------- AI prompt'una gömülen alanlar (en kritik) ---------------- */

t("firstName sınırlı (her AI prompt'una gömülür)", () => {
  assert(hasMaxBound(userSrc, "firstName") === true, "firstName sınırsız — AI maliyet riski");
});

t("focusArea sınırlı (her AI prompt'una gömülür)", () => {
  assert(hasMaxBound(userSrc, "focusArea") === true, "focusArea sınırsız");
});

t("chat mesajı sınırlı", () => {
  assert(hasMaxBound(chatSrc, "message") === true, "chat mesajı sınırsız — AI maliyet riski");
});

t("partnerName sınırlı", () => {
  assert(hasMaxBound(compatibilitySrc, "partnerName") === true, "partnerName sınırsız");
});

/* ---------------- dış servise (geocoding) gönderilen alanlar ---------------- */

t("birthCity sınırlı (Nominatim'e gönderilir)", () => {
  assert(hasMaxBound(astrologySrc, "birthCity") === true, "birthCity sınırsız — dış API kötüye kullanımı");
});

t("partnerBirthCity sınırlı (Nominatim'e gönderilir)", () => {
  assert(hasMaxBound(compatibilitySrc, "partnerBirthCity") === true, "partnerBirthCity sınırsız");
});

/* ---------------- depolama alanları ---------------- */

t("push token sınırlı", () => {
  assert(hasMaxBound(notificationsSrc, "token") === true, "push token sınırsız — DB bloat riski");
});

/* ---------------- gerçek davranış: Zod ile canlı doğrulama ---------------- */

t("50 karakterden uzun isim gerçekten reddediliyor", () => {
  const schema = z.string().min(1).max(50);
  const huge = "a".repeat(10_000);
  const result = schema.safeParse(huge);
  assert(!result.success, "Zod .max(50) 10.000 karakterlik girdiyi kabul etti — test kurulumu yanlış");
});

t("100 karakterden uzun şehir adı gerçekten reddediliyor", () => {
  const schema = z.string().min(1).max(100);
  const huge = "İ".repeat(50_000);
  const result = schema.safeParse(huge);
  assert(!result.success, "Zod .max(100) 50.000 karakterlik girdiyi kabul etti");
});

/* ---------------- kimlik doğrulama (public uçlar — özellikle önemli) ---------------- */

t("Kayıt/giriş e-postası sınırlı (RFC 5321 azami uzunluk)", () => {
  // Zod'un .email() formatı doğrular ama uzunluğu SINIRLAMAZ — bu satır olmadan
  // "a"*10000+"@x.com" geçerli bir e-posta gibi geçebilirdi.
  const matches = [...authSrc.matchAll(/email:\s*z\.string\(\)\.email\([^)]*\)([^\n]*)/g)];
  assert(matches.length >= 3, `beklenen en az 3 email alanı, bulunan ${matches.length}`);
  assert(matches.every((m) => /\.max\(/.test(m[0])), "bir e-posta alanı sınırsız");
});

t("Şifre alanları sınırlı", () => {
  const matches = [...authSrc.matchAll(/password:\s*z\.string\(\)[^\n]*/g)];
  assert(matches.length >= 3, `beklenen en az 3 şifre alanı, bulunan ${matches.length}`);
  assert(matches.every((m) => /\.max\(/.test(m[0])), "bir şifre alanı sınırsız");
});

t("Şifre sıfırlama token'ı sınırlı (public/kimliksiz uç)", () => {
  assert(hasMaxBound(authSrc, "token") === true, "reset-password token'ı sınırsız");
});

t("discardToken sınırlı", () => {
  assert(hasMaxBound(authSrc, "discardToken") === true, "discardToken sınırsız");
});

/* ---------------- abonelik doğrulama ---------------- */

t("purchaseToken sınırlı", () => {
  assert(hasMaxBound(subscriptionSrc, "purchaseToken") === true, "purchaseToken sınırsız");
});

/* ---------------- gerçek davranış: uzun e-posta reddediliyor ---------------- */

t("254 karakterden uzun e-posta gerçekten reddediliyor", () => {
  const schema = z.string().email().max(254);
  const huge = "a".repeat(300) + "@ornek.com";
  assert(!schema.safeParse(huge).success, "uzun e-posta kabul edildi");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
