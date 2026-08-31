/**
 * Dağıtım öncesi denetim.
 *
 *   npm run preflight
 *
 * Yayına çıkmadan önce yapılandırmanın eksik veya tehlikeli olup olmadığını kontrol eder.
 * Yanlış yapılandırma genellikle kod hatası gibi görünmeyen ama kullanıcıya ulaşan
 * sorunlara yol açar: premium açılmaz, bildirim gitmez, şifre sıfırlama e-postası
 * hiç gönderilmez. Bunların hepsi burada önceden yakalanabilir.
 *
 * Çıkış kodu 1 ise yayına çıkmadan düzeltilmesi gereken bir sorun var demektir.
 */

import "dotenv/config";

type Level = "error" | "warn" | "ok" | "info";

interface Finding {
  level: Level;
  area: string;
  message: string;
  fix?: string;
}

const findings: Finding[] = [];
const isProduction = process.env.NODE_ENV === "production";

function add(level: Level, area: string, message: string, fix?: string) {
  findings.push({ level, area, message, fix });
}

/* ------------------------------ zorunlu ayarlar ------------------------------ */

function checkCore() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    add("error", "Veritabanı", "DATABASE_URL tanımlı değil.", "postgresql://... adresini .env dosyasına ekle");
  } else if (!dbUrl.startsWith("postgres")) {
    add("error", "Veritabanı", "DATABASE_URL bir PostgreSQL adresi değil.");
  } else if (isProduction && /localhost|127\.0\.0\.1/.test(dbUrl)) {
    add("warn", "Veritabanı", "Production'da localhost veritabanı kullanılıyor.");
  } else {
    add("ok", "Veritabanı", "DATABASE_URL tanımlı.");
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    add("error", "Kimlik", "JWT_SECRET tanımlı değil — sunucu başlamaz.");
  } else if (secret.length < 32) {
    add("error", "Kimlik", `JWT_SECRET çok kısa (${secret.length} karakter).`, "En az 32 karakterlik rastgele bir değer kullan: openssl rand -base64 48");
  } else if (/change-this|secret|test|example/i.test(secret)) {
    add("error", "Kimlik", "JWT_SECRET örnek/varsayılan bir değere benziyor.", "Gerçek rastgele bir değerle değiştir");
  } else {
    add("ok", "Kimlik", "JWT_SECRET güçlü görünüyor.");
  }

  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!anthropic) {
    add("error", "Yapay zekâ", "ANTHROPIC_API_KEY tanımlı değil — hiçbir yorum üretilemez.");
  } else if (!anthropic.startsWith("sk-ant-")) {
    add("warn", "Yapay zekâ", "ANTHROPIC_API_KEY beklenen biçimde değil (sk-ant- ile başlamalı).");
  } else {
    add("ok", "Yapay zekâ", "ANTHROPIC_API_KEY tanımlı.");
  }

  const cors = process.env.CORS_ORIGIN;
  if (isProduction && (!cors || cors === "*")) {
    add("warn", "Güvenlik", "Production'da CORS_ORIGIN='*' — her siteden istek kabul ediliyor.", "Uygulamanın origin'iyle sınırla");
  } else if (cors) {
    add("ok", "Güvenlik", `CORS_ORIGIN=${cors}`);
  }
}

/* ------------------------------ abonelik ------------------------------ */

function checkSubscriptions() {
  const apple = ["APPLE_ISSUER_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "APPLE_BUNDLE_ID"];
  const appleMissing = apple.filter((k) => !process.env[k]);
  const google = ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_PACKAGE_NAME"];
  const googleMissing = google.filter((k) => !process.env[k]);

  if (appleMissing.length === apple.length && googleMissing.length === google.length) {
    add(
      isProduction ? "error" : "warn",
      "Abonelik",
      "Ne Apple ne Google doğrulaması yapılandırılmış — HİÇ KİMSE premium olamaz.",
      "En az bir mağazayı yapılandır (bkz. .env.example)"
    );
  } else {
    if (appleMissing.length === 0) {
      add("ok", "Abonelik", "Apple doğrulaması yapılandırılmış.");
      const env = process.env.APPLE_ENVIRONMENT || "sandbox";
      if (isProduction && env !== "production") {
        add("error", "Abonelik", `APPLE_ENVIRONMENT='${env}' — production'da gerçek satın almalar doğrulanamaz.`);
      }
      if (process.env.APPLE_PRIVATE_KEY && !process.env.APPLE_PRIVATE_KEY.includes("PRIVATE KEY")) {
        add("warn", "Abonelik", "APPLE_PRIVATE_KEY bir .p8 anahtarına benzemiyor.");
      }
    } else if (appleMissing.length < apple.length) {
      add("error", "Abonelik", `Apple yapılandırması eksik: ${appleMissing.join(", ")}`);
    }

    if (googleMissing.length === 0) {
      add("ok", "Abonelik", "Google doğrulaması yapılandırılmış.");
      try {
        JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
      } catch {
        add("error", "Abonelik", "GOOGLE_SERVICE_ACCOUNT_JSON geçerli bir JSON değil.");
      }
    } else if (googleMissing.length < google.length) {
      add("error", "Abonelik", `Google yapılandırması eksik: ${googleMissing.join(", ")}`);
    }
  }

  // Webhook'lar olmadan iptaller geç fark edilir
  if (!process.env.APPLE_ROOT_CA_PEM && appleMissing.length === 0) {
    add("warn", "Abonelik", "APPLE_ROOT_CA_PEM yok — Apple bildirimleri doğrulanamaz, iptaller geç fark edilir.");
  }
  if (!process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT && googleMissing.length === 0) {
    add("warn", "Abonelik", "GOOGLE_PUBSUB_SERVICE_ACCOUNT yok — Play bildirimleri işlenemez.");
  }
}

/* ------------------------------ e-posta ------------------------------ */

function checkEmail() {
  const p = (process.env.EMAIL_PROVIDER || "console").toLowerCase();
  if (p === "console") {
    add(
      isProduction ? "error" : "warn",
      "E-posta",
      "EMAIL_PROVIDER='console' — şifre sıfırlama e-postaları GÖNDERİLMEZ, sadece loglanır.",
      "Production için 'resend' seç ve RESEND_API_KEY tanımla"
    );
  } else if (p === "resend" && !process.env.RESEND_API_KEY) {
    add("error", "E-posta", "EMAIL_PROVIDER='resend' ama RESEND_API_KEY yok.");
  } else {
    add("ok", "E-posta", `Sağlayıcı: ${p}`);
  }

  const resetUrl = process.env.PASSWORD_RESET_URL;
  if (!resetUrl) {
    add("warn", "E-posta", "PASSWORD_RESET_URL yok — sıfırlama bağlantısı örnek adrese gider.");
  } else if (/ornek\.com|example\.com/.test(resetUrl)) {
    add("error", "E-posta", "PASSWORD_RESET_URL hâlâ örnek adres.", "https://SENIN-BACKEND/sifre-sifirla olarak ayarla");
  } else if (isProduction && !resetUrl.startsWith("https://")) {
    add("error", "E-posta", "PASSWORD_RESET_URL https değil — token açık ağdan geçer.");
  } else {
    add("ok", "E-posta", "Şifre sıfırlama adresi tanımlı.");
  }
}

/* ------------------------------ diğer ------------------------------ */

function checkOperational() {
  const schedulerOff = process.env.DISABLE_NOTIFICATION_SCHEDULER === "true";
  if (schedulerOff && !process.env.CRON_SECRET) {
    add("error", "Bildirimler", "Dahili zamanlayıcı kapalı ama CRON_SECRET yok — hiç bildirim gönderilmez.", "CRON_SECRET tanımla veya zamanlayıcıyı aç");
  } else if (schedulerOff) {
    add("ok", "Bildirimler", "Harici cron ile çalışacak şekilde yapılandırılmış.");
  } else if (!process.env.CRON_SECRET) {
    add("info", "Bildirimler", "Dahili zamanlayıcı kullanılıyor (tek sunucu için uygun).");
  }
  if (!process.env.ANALYTICS_SECRET) {
    add("info", "Analytics", "ANALYTICS_SECRET yok — metrik özeti ucu kapalı.");
  }
  if (!process.env.GEOCODER_USER_AGENT) {
    add("warn", "Geocoding", "GEOCODER_USER_AGENT yok — Nominatim kullanım şartları tanımlayıcı bir User-Agent ister.");
  }
}

/* ------------------------------ canlı bağlantı testleri ------------------------------ */

async function checkConnectivity() {
  // Veritabanı
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import("../src/lib/prisma");
      await prisma.$queryRaw`SELECT 1`;
      add("ok", "Bağlantı", "Veritabanına bağlanıldı.");

      const pending = await prisma.$queryRawUnsafe<any[]>(
        `SELECT to_regclass('public.users') AS t`
      ).catch(() => null);
      if (pending && !pending[0]?.t) {
        add("error", "Bağlantı", "Tablolar yok — migration uygulanmamış.", "npx prisma migrate deploy");
      }
      await prisma.$disconnect();
    } catch (err: any) {
      const msg = String(err?.message || "");
      // En sık karşılaşılan iki durumu ayırt et; ham Prisma mesajı yeni başlayan için anlaşılmaz
      if (/did not initialize|prisma generate/i.test(msg)) {
        add("error", "Bağlantı", "Prisma istemcisi üretilmemiş.", "npx prisma generate");
      } else if (/ECONNREFUSED|ENOTFOUND|timeout/i.test(msg)) {
        add("error", "Bağlantı", "Veritabanı sunucusuna ulaşılamıyor.", "DATABASE_URL adresini ve sunucunun çalıştığını kontrol et");
      } else {
        add("error", "Bağlantı", `Veritabanına bağlanılamadı: ${msg.slice(0, 120)}`);
      }
    }
  }

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.status === 401) {
        add("error", "Bağlantı", "Anthropic API anahtarı reddedildi (401).");
      } else if (res.ok || res.status === 400) {
        // 400 de kabul: anahtar geçerli, istek biçimi önemli değil
        add("ok", "Bağlantı", "Anthropic API'ye ulaşıldı.");
      } else {
        add("warn", "Bağlantı", `Anthropic beklenmeyen yanıt: ${res.status}`);
      }
    } catch (err: any) {
      add("warn", "Bağlantı", `Anthropic'e ulaşılamadı: ${err?.message?.slice(0, 80)}`);
    }
  }
}

/* ------------------------------ rapor ------------------------------ */

const ICON: Record<Level, string> = { error: "✗", warn: "!", ok: "✓", info: "·" };

async function main() {
  console.log("\nAstro — dağıtım öncesi denetim");
  console.log(`Ortam: ${process.env.NODE_ENV || "development"}\n`);

  checkCore();
  checkSubscriptions();
  checkEmail();
  checkOperational();
  await checkConnectivity();

  const order: Level[] = ["error", "warn", "ok", "info"];
  for (const level of order) {
    const group = findings.filter((f) => f.level === level);
    if (!group.length) continue;
    for (const f of group) {
      console.log(`${ICON[f.level]} [${f.area}] ${f.message}`);
      if (f.fix) console.log(`    → ${f.fix}`);
    }
    console.log("");
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;

  console.log(`${errors} hata, ${warns} uyarı\n`);

  if (errors > 0) {
    console.log("Yayına çıkmadan önce hataların düzeltilmesi gerekiyor.\n");
    process.exit(1);
  }
  if (warns > 0) {
    console.log("Hata yok. Uyarıları gözden geçir.\n");
  } else {
    console.log("Yapılandırma hazır görünüyor.\n");
  }
}

main();
