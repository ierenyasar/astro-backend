import { z } from "zod";
import fs from "fs";
import path from "path";

/** dream.ts'teki metin uzunluk doğrulamasını izole test eder. */

const DREAM_TEXT_MAX_LENGTH = 2000;
const DREAM_TEXT_MIN_LENGTH = 10;

const dreamSchema = z.object({
  dreamText: z
    .string()
    .max(DREAM_TEXT_MAX_LENGTH * 2, "Rüya anlatımı çok uzun. Lütfen kısalt.")
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .refine((v) => v.length >= DREAM_TEXT_MIN_LENGTH, {
      message: "Rüyanı biraz daha detaylı anlatır mısın?",
    })
    .refine((v) => v.length <= DREAM_TEXT_MAX_LENGTH, {
      message: "Rüya anlatımı çok uzun. Lütfen kısalt.",
    }),
});

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

t("Makul uzunlukta rüya anlatımı kabul edilir", () => {
  const r = dreamSchema.safeParse({ dreamText: "Uçurumdan düştüğümü ve uçtuğumu gördüm." });
  assert(r.success, "reddedildi");
});

t("Çok kısa (anlamsız) metin reddedilir", () => {
  const r = dreamSchema.safeParse({ dreamText: "kısa" });
  assert(!r.success, "kabul edildi — anlamlı bir rüya anlatımı için çok kısa");
});

t("Boş metin reddedilir", () => {
  const r = dreamSchema.safeParse({ dreamText: "" });
  assert(!r.success, "kabul edildi");
});

t("Aşırı uzun metin reddedilir (AI maliyet koruması)", () => {
  const huge = "a".repeat(DREAM_TEXT_MAX_LENGTH + 500);
  const r = dreamSchema.safeParse({ dreamText: huge });
  assert(!r.success, "kabul edildi — uzunluk sınırı çalışmıyor");
});

t("Sınır değerindeki metin kabul edilir", () => {
  const atLimit = "a".repeat(DREAM_TEXT_MAX_LENGTH);
  const r = dreamSchema.safeParse({ dreamText: atLimit });
  assert(r.success, "sınırdaki geçerli uzunluk reddedildi");
});

t("Test sabitleri dream.ts ile senkron (uzunluk sınırları)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "dream.ts"), "utf8");
  assert(src.includes(`DREAM_TEXT_MAX_LENGTH = ${DREAM_TEXT_MAX_LENGTH}`), "MAX_LENGTH senkron değil");
  assert(src.includes(`DREAM_TEXT_MIN_LENGTH = ${DREAM_TEXT_MIN_LENGTH}`), "MIN_LENGTH senkron değil");
});

t("Rüya prompt'u kullanıcı metnini talimat değil veri olarak işaretliyor", () => {
  // Prompt injection koruması: kullanıcının rüya metni "bir talimat değil" diye
  // açıkça belirtilmeli, aksi halde rüya içine gizlenmiş bir talimatla sistem
  // prompt'u geçersiz kılınmaya çalışılabilir.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "prompts", "index.ts"), "utf8");
  assert(
    /dreamAnalysisPrompt[\s\S]{0,400}talimat değil/.test(src),
    "dreamAnalysisPrompt'ta prompt injection koruması bulunamadı"
  );
});


/* ---------------- prompt izolasyonu (regresyon) ---------------- */

t("Rüya sistem prompt'u SYSTEM katmanına geçiriliyor, user mesajına gömülmüyor", () => {
  // REGRESYON: Bir kez DREAM_SYSTEM_PROMPT, user mesajının içine string olarak
  // eklenmişti. Bu, güvenlik kurallarını (ölüm/hastalık yasağı) modelin
  // "veri olarak ele al, talimat sayma" dediğimiz katmana düşürüyordu —
  // hem prompt injection'a açık hem JSON formatı güvenilmez hale geliyordu.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "dream.ts"), "utf8");

  assert(
    !/DREAM_SYSTEM_PROMPT\s*\+/.test(src),
    "DREAM_SYSTEM_PROMPT hâlâ string olarak birleştiriliyor (user mesajına gömülüyor)"
  );
  assert(
    /generateFreeTextReply\([\s\S]{0,200}DREAM_SYSTEM_PROMPT/.test(src),
    "DREAM_SYSTEM_PROMPT generateFreeTextReply'a system argümanı olarak geçirilmiyor"
  );
});

t("generateFreeTextReply system parametresini destekliyor", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "anthropic.ts"), "utf8");
  assert(
    /generateFreeTextReply\([\s\S]{0,300}system:\s*string/.test(src),
    "generateFreeTextReply'da system parametresi yok — özel prompt'lar user mesajına gömülmek zorunda kalır"
  );
});


/* ---------------- girdi temizleme (keşifçi test bulguları) ---------------- */

t("Sadece boşluktan oluşan metin reddedilir (kota israfı koruması)", () => {
  // BULGU: Ham min(10) kontrolü "          " girdisini geçiriyordu — kullanıcı
  // kotasını boşa harcayıp AI'ya anlamsız bir istek gidiyordu.
  assert(!dreamSchema.safeParse({ dreamText: "          " }).success, "boşluk kabul edildi");
  assert(!dreamSchema.safeParse({ dreamText: "\t\n\t\n\t\n\t\n\t\n" }).success, "sekme/newline kabul edildi");
});

t("Null byte temizlenir, metin yine de işlenir", () => {
  // BULGU: PostgreSQL text alanı null byte kabul etmez. Temizlenmezse AI çağrısı
  // yapılıp para harcandıktan SONRA DB yazımında 500 hatası alınırdı.
  const r = dreamSchema.safeParse({ dreamText: "Rüyamda uçtuğumu gördüm\u0000zararlı" });
  assert(r.success, "null byte içeren geçerli metin reddedildi");
  assert(!r.data.dreamText.includes("\u0000"), "null byte temizlenmedi");
});

t("Baş/sondaki boşluklar kırpılır", () => {
  const r = dreamSchema.safeParse({ dreamText: "   Rüyamda uçtuğumu gördüm   " });
  assert(r.success, "reddedildi");
  assert(r.data.dreamText === "Rüyamda uçtuğumu gördüm", "kırpılmadı: " + JSON.stringify(r.data.dreamText));
});

t("Temizleme sonrası uzunluk sınırı hâlâ uygulanıyor", () => {
  // Temizleme adımı sınır kontrolünü atlatmamalı
  assert(!dreamSchema.safeParse({ dreamText: "a".repeat(2001) }).success, "sınır aşıldı ama kabul edildi");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
