import fs from "fs";
import path from "path";
import { EVENT_NAMES } from "../src/lib/analytics-events";

/**
 * Analytics event tutarlılığı.
 *
 * Bu hata sınıfı SESSİZDİR: mobilde tanımsız bir sabit kullanılırsa
 * `EVENTS.FOO` → undefined → `track(undefined)` çağrılır ve event hiç gönderilmez.
 * Hata mesajı çıkmaz, uygulama çalışmaya devam eder — sadece veri kaybolur.
 * Bir kez yaşandı (notification_opened), tekrarlanmasın diye burada kontrol ediliyor.
 *
 * Mobil proje ayrı bir klasörde olduğu için yolu env ile değiştirilebilir;
 * bulunamazsa test atlanır (backend tek başına da çalışabilmeli).
 */

const MOBILE_ROOT =
  process.env.MOBILE_PROJECT_PATH || path.join(__dirname, "..", "..", "astro-app-expo");

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

const analyticsPath = path.join(MOBILE_ROOT, "services", "analytics.js");
const appPath = path.join(MOBILE_ROOT, "App.js");

if (!fs.existsSync(analyticsPath) || !fs.existsSync(appPath)) {
  console.log("Mobil proje bulunamadı, event tutarlılık testi atlandı.");
  console.log(`Aranan yol: ${MOBILE_ROOT}`);
  console.log("\n0 passed, 0 failed");
  process.exit(0);
}

const analyticsSrc = fs.readFileSync(analyticsPath, "utf8");
const appSrc = fs.readFileSync(appPath, "utf8");

/** services/analytics.js içindeki EVENTS sabitleri: ANAHTAR: "değer" */
function mobileEvents(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s{2}([A-Z][A-Z0-9_]*):\s*"([a-z0-9_]+)",?$/gm;
  let m;
  while ((m = re.exec(analyticsSrc))) out[m[1]] = m[2];
  return out;
}

/** App.js içinde kullanılan EVENTS.X isimleri */
function usedInApp(): string[] {
  const re = /EVENTS\.([A-Z][A-Z0-9_]*)/g;
  const found = new Set<string>();
  let m;
  while ((m = re.exec(appSrc))) found.add(m[1]);
  return [...found];
}

const mobile = mobileEvents();
const used = usedInApp();

t("Mobil event listesi boş değil", () => {
  assert(Object.keys(mobile).length > 10, `sadece ${Object.keys(mobile).length} event bulundu`);
});

t("App.js'de kullanılan her event tanımlı", () => {
  const missing = used.filter((name) => !(name in mobile));
  assert(
    missing.length === 0,
    `tanımsız event kullanılıyor (sessizce kaybolur): ${missing.join(", ")}`
  );
});

t("Mobil event değerleri backend şemasında var", () => {
  const unknown = Object.entries(mobile)
    .filter(([, value]) => !EVENT_NAMES.includes(value))
    .map(([key, value]) => `${key}="${value}"`);
  assert(
    unknown.length === 0,
    `backend bu eventleri tanımıyor, gönderilse de kaydedilmez: ${unknown.join(", ")}`
  );
});

t("Event değerleri snake_case", () => {
  for (const [key, value] of Object.entries(mobile)) {
    assert(/^[a-z][a-z0-9_]*$/.test(value), `${key} geçersiz biçimde: "${value}"`);
  }
});

t("Aynı değer iki sabite atanmamış", () => {
  const values = Object.values(mobile);
  const dupes = values.filter((v, i) => values.indexOf(v) !== i);
  assert(dupes.length === 0, `mükerrer event değeri: ${[...new Set(dupes)].join(", ")}`);
});

t("Huni için gerekli eventler mobilde kullanılıyor", () => {
  // Bunlar App.js'de çağrılmazsa dönüşüm oranları hesaplanamaz
  const required = [
    "ONBOARDING_STARTED",
    "ONBOARDING_COMPLETED",
    "PAYWALL_VIEWED",
    "QUOTA_EXHAUSTED",
    "PURCHASE_STARTED",
  ];
  const notUsed = required.filter((r) => !used.includes(r));
  assert(notUsed.length === 0, `huni eventi hiç gönderilmiyor: ${notUsed.join(", ")}`);
});

/* ---------------- stil referansları ---------------- */

/**
 * React Native'de tanımsız bir stile referans (`styles.foo` → undefined)
 * hata vermez, sessizce yok sayılır. Bileşen stilsiz çizilir ve bu ancak
 * gözle bakınca fark edilir. Bir kez yaşandı (retryButton, noticeBox).
 */
t("Kullanılan tüm stiller tanımlı", () => {
  const used = [...new Set([...appSrc.matchAll(/styles\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]))];
  const styleBlock = appSrc.slice(appSrc.indexOf("StyleSheet.create("));
  const defined = new Set(
    [...styleBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])
  );
  const missing = used.filter((u) => !defined.has(u));
  assert(
    missing.length === 0,
    `tanımsız stil kullanılıyor (sessizce yok sayılır): ${missing.join(", ")}`
  );
});

t("Tanımlı ama kullanılmayan stil yok", () => {
  // Madde 45: kullanılmayan kod bırakma
  const styleBlock = appSrc.slice(appSrc.indexOf("StyleSheet.create("));
  const defined = [...styleBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
  const unused = defined.filter((d) => !new RegExp(`styles\\.${d}\\b`).test(appSrc));
  assert(unused.length === 0, `kullanılmayan stil: ${unused.join(", ")}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
