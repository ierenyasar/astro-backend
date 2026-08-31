import { sanitizeProperties, EVENT_NAMES, EVENTS } from "../src/lib/analytics-events";

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

/* ---------------- gizlilik: kişisel veri sızmamalı ---------------- */

t("Doğum tarihi analitiğe sızmaz", () => {
  const out = sanitizeProperties({ birthDate: "2002-07-28", category: "daily" });
  assert(!("birthDate" in out), "doğum tarihi sızdı");
  assert(out.category === "daily", "zararsız alan düştü");
});

t("Doğum saati ve yeri sızmaz", () => {
  const out = sanitizeProperties({
    birthTime: "19:30",
    birthCity: "Istanbul",
    birthPlace: "Istanbul, TR",
  });
  assert(Object.keys(out).length === 0, `sızan alanlar: ${Object.keys(out)}`);
});

t("Koordinatlar sızmaz", () => {
  const out = sanitizeProperties({ latitude: 41.0082, longitude: 28.9784 });
  assert(Object.keys(out).length === 0, "koordinat sızdı");
});

t("İsim ve e-posta sızmaz", () => {
  const out = sanitizeProperties({ name: "Elif", firstName: "Elif", email: "e@x.com" });
  assert(Object.keys(out).length === 0, `sızan: ${Object.keys(out)}`);
});

t("Partner adı sızmaz", () => {
  const out = sanitizeProperties({ partnerName: "Ahmet", score: 87 });
  assert(!("partnerName" in out), "partner adı sızdı");
  assert(out.score === 87, "skor düştü");
});

t("Token ve şifre sızmaz", () => {
  const out = sanitizeProperties({ token: "abc", password: "x", authToken: "y" });
  assert(Object.keys(out).length === 0, `sızan: ${Object.keys(out)}`);
});

t("Kullanıcının sohbet mesajı sızmaz", () => {
  const out = sanitizeProperties({ message: "Eski sevgilimi düşünüyorum", content: "..." });
  assert(Object.keys(out).length === 0, "mesaj içeriği sızdı");
});

t("Uzun serbest metin sızmaz", () => {
  const out = sanitizeProperties({ note: "a".repeat(200) });
  assert(!("note" in out), "uzun metin sızdı");
});

t("Kısa metin geçer", () => {
  const out = sanitizeProperties({ note: "kisa" });
  assert(out.note === "kisa", "kısa metin düştü");
});

t("Anahtar büyük/küçük harften kaçamaz", () => {
  const out = sanitizeProperties({ BirthDate: "2002-07-28", USER_EMAIL: "a@b.c" });
  assert(Object.keys(out).length === 0, `sızan: ${Object.keys(out)}`);
});

t("Gömülü anahtar adı da yakalanır", () => {
  const out = sanitizeProperties({ userBirthDateValue: "2002-07-28", partner_name_full: "X" });
  assert(Object.keys(out).length === 0, `sızan: ${Object.keys(out)}`);
});

t("Zararsız metrikler korunur", () => {
  const out = sanitizeProperties({
    sunSign: "Leo",
    category: "love",
    isPremium: false,
    step: 3,
    durationMs: 1200,
  });
  assert(Object.keys(out).length === 5, `beklenmedik şekilde düşen alan var: ${JSON.stringify(out)}`);
});

t("null/undefined çökertmez", () => {
  assert(Object.keys(sanitizeProperties(null)).length === 0, "null hata verdi");
  assert(Object.keys(sanitizeProperties(undefined)).length === 0, "undefined hata verdi");
});

/* ---------------- event şeması tutarlılığı ---------------- */

t("Event adları benzersiz", () => {
  const unique = new Set(EVENT_NAMES);
  assert(unique.size === EVENT_NAMES.length, "mükerrer event adı var");
});

t("Event adları snake_case", () => {
  for (const n of EVENT_NAMES) {
    assert(/^[a-z][a-z0-9_]*$/.test(n), `geçersiz format: ${n}`);
  }
});

t("Huni metrikleri için gerekli eventler tanımlı", () => {
  // Bu eventler olmadan onboarding tamamlanma ve paywall dönüşümü hesaplanamaz
  const required = [
    EVENTS.ONBOARDING_STARTED,
    EVENTS.ONBOARDING_COMPLETED,
    EVENTS.PAYWALL_VIEWED,
    EVENTS.SUBSCRIPTION_STARTED,
    EVENTS.TRIAL_STARTED,
    EVENTS.QUOTA_EXHAUSTED,
  ];
  for (const r of required) {
    assert(EVENT_NAMES.includes(r), `eksik event: ${r}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
