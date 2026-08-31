import { isLocalHourNow, alreadySentToday, pickDailyMessage } from "../src/lib/push";

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

/* ---------------- saat dilimi doğruluğu ---------------- */

t("İstanbul'da sabah 9 doğru tespit edilir", () => {
  // 06:00 UTC = 09:00 Istanbul (UTC+3)
  const now = new Date("2026-03-15T06:30:00Z");
  assert(isLocalHourNow("Europe/Istanbul", 9, now) === true, "9 olmalıydı");
});

t("İstanbul saati 9 değilken gönderilmez", () => {
  const now = new Date("2026-03-15T12:00:00Z"); // 15:00 Istanbul
  assert(isLocalHourNow("Europe/Istanbul", 9, now) === false, "gönderilmemeliydi");
});

t("New York kullanıcısı kendi sabahında bildirim alır", () => {
  // 13:00 UTC = 09:00 New York (EDT, UTC-4)
  const now = new Date("2026-06-15T13:30:00Z");
  assert(isLocalHourNow("America/New_York", 9, now) === true, "NY sabahı yakalanmadı");
});

t("Aynı anda farklı saat dilimleri farklı sonuç verir", () => {
  // Bu, herkese aynı UTC saatinde göndermenin neden yanlış olduğunu gösterir
  const now = new Date("2026-06-15T06:30:00Z");
  const istanbul = isLocalHourNow("Europe/Istanbul", 9, now); // 09:30 -> true
  const newYork = isLocalHourNow("America/New_York", 9, now); // 02:30 -> false
  assert(istanbul === true, "İstanbul 9 olmalı");
  assert(newYork === false, "NY gecenin 2'sinde bildirim alacaktı");
});

t("Geçersiz timezone çökertmez, UTC'ye düşer", () => {
  const now = new Date("2026-03-15T09:15:00Z");
  assert(isLocalHourNow("Mars/Olympus_Mons", 9, now) === true, "UTC fallback çalışmadı");
});

t("timezone null ise UTC varsayılır", () => {
  const now = new Date("2026-03-15T09:15:00Z");
  assert(isLocalHourNow(null, 9, now) === true, "null timezone hatalı");
});

t("Kullanıcı bildirim saatini değiştirebilir", () => {
  const now = new Date("2026-03-15T18:30:00Z"); // 21:30 Istanbul
  assert(isLocalHourNow("Europe/Istanbul", 21, now) === true, "21:00 tercihi çalışmadı");
  assert(isLocalHourNow("Europe/Istanbul", 9, now) === false, "9 tercihi yanlış eşleşti");
});

/* ---------------- spam koruması ---------------- */

t("Hiç gönderilmemişse bugün gönderilmemiş sayılır", () => {
  assert(alreadySentToday(null, "Europe/Istanbul") === false, "null yanlış yorumlandı");
});

t("Bugün gönderilmişse tekrar gönderilmez", () => {
  const now = new Date("2026-03-15T06:30:00Z");
  const sentEarlier = new Date("2026-03-15T06:00:00Z");
  assert(alreadySentToday(sentEarlier, "Europe/Istanbul", now) === true, "mükerrer bildirim gidecekti");
});

t("Dün gönderilmişse bugün tekrar gönderilir", () => {
  const now = new Date("2026-03-15T06:30:00Z");
  const yesterday = new Date("2026-03-14T06:00:00Z");
  assert(alreadySentToday(yesterday, "Europe/Istanbul", now) === false, "dünkü gönderim bugünü blokladı");
});

t("Gün sınırı YEREL saate göre hesaplanır", () => {
  // 2026-03-15 22:00 UTC = 2026-03-16 01:00 Istanbul → Istanbul'da yeni gün
  const nowUtc = new Date("2026-03-15T22:30:00Z");
  const sentAt = new Date("2026-03-15T06:00:00Z"); // Istanbul'da 15 Mart 09:00
  assert(
    alreadySentToday(sentAt, "Europe/Istanbul", nowUtc) === false,
    "Istanbul'da gün değişti ama UTC gününe bakılmış"
  );
});

/* ---------------- mesaj çeşitliliği ---------------- */

t("Bildirim metinleri sabit değil (tekrar etmiyor)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) seen.add(pickDailyMessage().title);
  assert(seen.size > 1, "her seferinde aynı metin gönderiliyor");
});

t("Her mesajda başlık ve gövde dolu", () => {
  for (let i = 0; i < 30; i++) {
    const m = pickDailyMessage();
    assert(!!m.title && !!m.body, "boş bildirim metni");
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
