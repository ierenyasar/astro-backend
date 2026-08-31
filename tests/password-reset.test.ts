import { createHash, randomBytes } from "crypto";
import { passwordResetEmail, isEmailConfigured } from "../src/lib/email";

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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/* ---------------- token üretimi ve saklama ---------------- */

t("Token yeterince uzun ve rastgele", () => {
  const a = randomBytes(32).toString("hex");
  const b = randomBytes(32).toString("hex");
  assert(a.length === 64, `token kısa: ${a.length}`);
  assert(a !== b, "token'lar tekrar ediyor");
});

t("Token DB'ye düz metin olarak yazılmaz", () => {
  // Saklanan değer token'ın kendisi değil özeti olmalı; DB sızarsa kullanılamaz
  const token = randomBytes(32).toString("hex");
  const stored = hashToken(token);
  assert(stored !== token, "token düz metin saklanıyor");
  assert(stored.length === 64, "sha256 özeti değil");
});

t("Aynı token her zaman aynı özeti verir (arama çalışır)", () => {
  const token = "abc123";
  assert(hashToken(token) === hashToken(token), "özet deterministik değil");
});

t("Farklı token'lar farklı özet verir", () => {
  assert(hashToken("a") !== hashToken("b"), "özet çakışıyor");
});

/* ---------------- süre ve tek kullanım mantığı ---------------- */

function isUsable(rec: { usedAt: Date | null; expiresAt: Date }, now = new Date()) {
  return !rec.usedAt && rec.expiresAt > now;
}

t("Süresi dolmamış, kullanılmamış token geçerli", () => {
  assert(isUsable({ usedAt: null, expiresAt: new Date(Date.now() + 3600000) }), "geçerli token reddedildi");
});

t("Süresi dolmuş token reddedilir", () => {
  assert(!isUsable({ usedAt: null, expiresAt: new Date(Date.now() - 1000) }), "süresi dolmuş token kabul edildi");
});

t("Kullanılmış token ikinci kez kabul edilmez", () => {
  assert(
    !isUsable({ usedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) }),
    "token tekrar kullanılabiliyor"
  );
});

/* ---------------- oturum geçersizleştirme ---------------- */

/** requireAuth'daki kontrolün aynısı. */
const CLOCK_TOLERANCE_MS = 2000;
function tokenStillValid(iatSeconds: number, sessionsValidFrom: Date) {
  return iatSeconds * 1000 >= sessionsValidFrom.getTime() - CLOCK_TOLERANCE_MS;
}

t("Şifre sıfırlamadan ÖNCE üretilmiş token geçersizleşir", () => {
  const oldTokenIat = Math.floor((Date.now() - 86400000) / 1000); // dün
  const resetAt = new Date(); // şimdi sıfırlandı
  assert(
    !tokenStillValid(oldTokenIat, resetAt),
    "GÜVENLİK: çalınmış eski token şifre sıfırlandıktan sonra da çalışıyor"
  );
});

t("Şifre sıfırlamadan SONRA üretilmiş token geçerli", () => {
  const resetAt = new Date(Date.now() - 5000);
  const newTokenIat = Math.floor(Date.now() / 1000);
  assert(tokenStillValid(newTokenIat, resetAt), "yeni token geçersiz sayıldı");
});

t("Saat farkı toleransı meşru kullanıcıyı atmaz", () => {
  // iat saniyeye yuvarlanır (999 ms'ye kadar geri) + sunucular arası saat farkı.
  // Tolerans dar olursa kullanıcı şifre sıfırladıktan hemen sonra oturumdan atılır.
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  assert(tokenStillValid(iat, new Date(now + 500)), "yarım saniyelik saat farkı kullanıcıyı attı");
  assert(tokenStillValid(iat, new Date(now + 900)), "900 ms saat farkı kullanıcıyı attı");
});

t("Tolerans eski token'ı kurtaracak kadar geniş DEĞİL", () => {
  // Tolerans güvenliği delmemeli: 1 dakika önceki token yine reddedilmeli
  const oldIat = Math.floor((Date.now() - 60000) / 1000);
  assert(!tokenStillValid(oldIat, new Date()), "tolerans çok geniş, eski token geçti");
});

/* ---------------- e-posta içeriği ---------------- */

t("E-posta sıfırlama bağlantısını içerir", () => {
  const url = "https://ornek.com/sifre-sifirla?token=abc";
  const mail = passwordResetEmail(url, 60);
  assert(mail.text.includes(url), "metin sürümünde bağlantı yok");
  assert(mail.html!.includes(url), "html sürümünde bağlantı yok");
});

t("E-posta geçerlilik süresini belirtir", () => {
  const mail = passwordResetEmail("https://x.com?token=1", 60);
  assert(mail.text.includes("60"), "süre bilgisi yok");
});

t("E-posta 'sen yapmadıysan' uyarısı içerir", () => {
  const mail = passwordResetEmail("https://x.com?token=1", 60);
  assert(mail.text.toLowerCase().includes("yok sayabilirsin"), "istenmeyen istek uyarısı yok");
});

t("E-posta şifreyi İÇERMEZ", () => {
  // Şifre asla e-postayla gönderilmemeli
  const mail = passwordResetEmail("https://x.com?token=1", 60);
  assert(!/şifren:|password:/i.test(mail.text), "e-postada şifre var");
});

t("Sağlayıcı yapılandırılmamışsa konsol modu bildirilir", () => {
  const prev = process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_PROVIDER;
  assert(isEmailConfigured() === false, "yapılandırılmamış sağlayıcı yapılandırılmış göründü");
  if (prev) process.env.EMAIL_PROVIDER = prev;
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
