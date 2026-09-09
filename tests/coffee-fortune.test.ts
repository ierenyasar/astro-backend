import { z } from "zod";
import fs from "fs";
import path from "path";

/**
 * coffee.ts'teki doğrulama mantığını izole test eder — gerçek route dosyasından
 * kopyalamak yerine aynı sabitleri/şemayı buradan çıkarıp test ediyoruz.
 */

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_IMAGE_BASE64_LENGTH = 2_500_000;
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 4;

const coffeeFortuneSchema = z.object({
  images: z
    .array(
      z.object({
        image: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH, "Görsel çok büyük. Lütfen daha küçük bir fotoğraf dene."),
        mediaType: z.enum(ALLOWED_MEDIA_TYPES),
      })
    )
    .min(MIN_PHOTOS, `En az ${MIN_PHOTOS} fotoğraf gerekli.`)
    .max(MAX_PHOTOS, `En fazla ${MAX_PHOTOS} fotoğraf gönderebilirsin.`),
});

function stripDataUrlPrefix(base64: string): string {
  const match = base64.match(/^data:image\/[a-z]+;base64,(.+)$/s);
  return match ? match[1] : base64;
}

function img(mediaType: (typeof ALLOWED_MEDIA_TYPES)[number] = "image/jpeg", data = "aGVsbG8=") {
  return { image: data, mediaType };
}

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

/* ---------------- fotoğraf sayısı sınırları (1-4) ---------------- */

t("Tek fotoğraf kabul edilir (minimum)", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img()] });
  assert(r.success, "reddedildi");
});

t("Dört fotoğraf kabul edilir (maksimum)", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img(), img(), img(), img()] });
  assert(r.success, "reddedildi");
});

t("Sıfır fotoğraf reddedilir", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [] });
  assert(!r.success, "kabul edildi — en az 1 fotoğraf gerekli");
});

t("Beş fotoğraf reddedilir (maksimumu aşıyor)", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img(), img(), img(), img(), img()] });
  assert(!r.success, "kabul edildi — en fazla 4 fotoğraf olmalı");
});

t("İki ve üç fotoğraf da kabul edilir (aradaki değerler)", () => {
  assert(coffeeFortuneSchema.safeParse({ images: [img(), img()] }).success, "2 fotoğraf reddedildi");
  assert(coffeeFortuneSchema.safeParse({ images: [img(), img(), img()] }).success, "3 fotoğraf reddedildi");
});

/* ---------------- görsel başına doğrulama ---------------- */

t("Desteklenmeyen MIME type reddedilir", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img("image/gif" as any)] });
  assert(!r.success, "kabul edildi — gif desteklenmemeli");
});

t("SVG gibi tehlikeli/beklenmeyen bir tür reddedilir", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img("image/svg+xml" as any)] });
  assert(!r.success, "kabul edildi");
});

t("Dizideki tek bir boş görsel bile tüm isteği reddettirir", () => {
  const r = coffeeFortuneSchema.safeParse({ images: [img(), { image: "", mediaType: "image/jpeg" }] });
  assert(!r.success, "kabul edildi");
});

t("Aşırı büyük tek bir görsel reddedilir", () => {
  const huge = "a".repeat(MAX_IMAGE_BASE64_LENGTH + 1000);
  const r = coffeeFortuneSchema.safeParse({ images: [img("image/jpeg", huge)] });
  assert(!r.success, "kabul edildi — boyut sınırı çalışmıyor");
});

t("Sınır değerindeki görsel kabul edilir", () => {
  const atLimit = "a".repeat(MAX_IMAGE_BASE64_LENGTH);
  const r = coffeeFortuneSchema.safeParse({ images: [img("image/jpeg", atLimit)] });
  assert(r.success, "sınırdaki geçerli boyut reddedildi");
});

t("4 fotoğrafın hepsi sınırda olsa bile tek tek değerlendirilir (toplam değil)", () => {
  const atLimit = "a".repeat(MAX_IMAGE_BASE64_LENGTH);
  const r = coffeeFortuneSchema.safeParse({
    images: [img("image/jpeg", atLimit), img("image/jpeg", atLimit), img("image/jpeg", atLimit), img("image/jpeg", atLimit)],
  });
  assert(r.success, "4 sınır-değerinde görsel reddedildi");
});

/* ---------------- data URL öneki temizleme ---------------- */

t("data: URL öneki temizleniyor", () => {
  const withPrefix = "data:image/jpeg;base64,aGVsbG8=";
  assert(stripDataUrlPrefix(withPrefix) === "aGVsbG8=", "önek temizlenmedi");
});

t("Önek yoksa metin olduğu gibi kalır", () => {
  assert(stripDataUrlPrefix("aGVsbG8=") === "aGVsbG8=", "değişmemesi gereken metin değişti");
});

t("Farklı MIME önekleri de temizleniyor (png)", () => {
  assert(stripDataUrlPrefix("data:image/png;base64,xyz123") === "xyz123", "png öneki temizlenmedi");
});

/* ---------------- gerçek dosyayla senkron kontrolü ---------------- */

t("Test sabitleri coffee.ts ile senkron (MAX_IMAGE_BASE64_LENGTH)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "coffee.ts"), "utf8");
  const normalized = src.replace(/(\d)_(\d)/g, "$1$2");
  assert(
    normalized.includes(`MAX_IMAGE_BASE64_LENGTH = ${MAX_IMAGE_BASE64_LENGTH}`),
    "coffee.ts'teki değer bu testtekiyle aynı değil"
  );
});

t("Test sabitleri coffee.ts ile senkron (MIN/MAX_PHOTOS)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "coffee.ts"), "utf8");
  assert(src.includes(`MIN_PHOTOS = ${MIN_PHOTOS}`), "MIN_PHOTOS senkron değil");
  assert(src.includes(`MAX_PHOTOS = ${MAX_PHOTOS}`), "MAX_PHOTOS senkron değil");
});

t("Test sabitleri coffee.ts ile senkron (izin verilen MIME türleri)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "coffee.ts"), "utf8");
  for (const type of ALLOWED_MEDIA_TYPES) {
    assert(src.includes(`"${type}"`), `${type} coffee.ts'te bulunamadı`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
