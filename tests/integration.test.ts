/**
 * Entegrasyon testleri — GERÇEK PostgreSQL gerektirir.
 *
 * Çalıştırmadan önce:
 *   1) Test veritabanı oluştur (üretim DB'sini KULLANMA — testler veri siler):
 *        createdb astro_test
 *   2) Şemayı uygula:
 *        DATABASE_URL="postgresql://.../astro_test" npx prisma migrate deploy
 *   3) Testleri çalıştır:
 *        DATABASE_URL="postgresql://.../astro_test" npx tsx tests/integration.test.ts
 *
 * AI çağrısı yapan uçlar (readings, chat, compatibility) burada test EDİLMEZ —
 * gerçek Anthropic API'ye istek atarak hem para harcar hem yavaşlar. Bu testler
 * auth, yetkilendirme ve kullanıcı izolasyonuna odaklanır; asıl güvenlik yüzeyi budur.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";

import authRoutes from "../src/routes/auth";
import userRoutes from "../src/routes/user";
import astrologyRoutes from "../src/routes/astrology";
import readingsRoutes from "../src/routes/readings";
import chatRoutes from "../src/routes/chat";
import subscriptionRoutes from "../src/routes/subscription";
import compatibilityRoutes from "../src/routes/compatibility";

const prisma = new PrismaClient();

let pass = 0,
  fail = 0;
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
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

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: "*" });
  await app.register(jwt, { secret: process.env.JWT_SECRET || "test-secret-for-integration-tests" });
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(astrologyRoutes);
  await app.register(readingsRoutes);
  await app.register(chatRoutes);
  await app.register(subscriptionRoutes);
  await app.register(compatibilityRoutes);
  return app;
}

async function cleanup() {
  // Sıra önemli: foreign key bağımlılıkları
  await prisma.chatMessage.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.favorite.deleteMany({});
  await prisma.reading.deleteMany({});
  await prisma.astrologyChart.deleteMany({});
  await prisma.birthData.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.subscription.deleteMany({});
  await prisma.compatibilityCheck.deleteMany({});
  await prisma.user.deleteMany({});
}

async function main() {
  const app = await buildApp();
  await cleanup();

  const inject = (opts: any) => app.inject(opts);
  const authed = (token: string, opts: any) =>
    app.inject({ ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${token}` } });

  /* ---------------- auth ---------------- */

  let tokenA = "";
  let tokenB = "";

  await t("Anonim hesap açılabilir ve token döner", async () => {
    const res = await inject({ method: "POST", url: "/auth/anonymous" });
    assert(res.statusCode === 201, `beklenen 201, gelen ${res.statusCode}`);
    tokenA = res.json().token;
    assert(!!tokenA, "token yok");

    const res2 = await inject({ method: "POST", url: "/auth/anonymous" });
    tokenB = res2.json().token;
    assert(tokenA !== tokenB, "iki anonim hesap aynı token aldı");
  });

  await t("Kısa şifreyle kayıt reddedilir", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "a@b.com", password: "kisa" },
    });
    assert(res.statusCode === 400, `beklenen 400, gelen ${res.statusCode}`);
  });

  await t("Aynı e-posta iki kez kaydedilemez", async () => {
    const p = { email: "dup@test.com", password: "gucluSifre123" };
    const first = await inject({ method: "POST", url: "/auth/register", payload: p });
    assert(first.statusCode === 201, "ilk kayıt başarısız");
    const second = await inject({ method: "POST", url: "/auth/register", payload: p });
    assert(second.statusCode === 409, `beklenen 409, gelen ${second.statusCode}`);
  });

  await t("Yanlış şifreyle giriş reddedilir", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "dup@test.com", password: "yanlisSifre123" },
    });
    assert(res.statusCode === 401, `beklenen 401, gelen ${res.statusCode}`);
  });

  await t("Şifre düz metin olarak SAKLANMAZ", async () => {
    const user = await prisma.user.findUnique({ where: { email: "dup@test.com" } });
    assert(!!user, "kullanıcı yok");
    assert(user!.passwordHash !== "gucluSifre123", "şifre düz metin saklanmış");
    assert(user!.passwordHash.startsWith("$2"), "bcrypt hash değil");
  });

  /* ---------------- yetkilendirme ---------------- */

  await t("Token olmadan korumalı uca erişilemez", async () => {
    const res = await inject({ method: "GET", url: "/user/profile" });
    assert(res.statusCode === 401, `beklenen 401, gelen ${res.statusCode}`);
  });

  await t("Geçersiz token reddedilir", async () => {
    const res = await authed("uydurma.token.degeri", { method: "GET", url: "/user/profile" });
    assert(res.statusCode === 401, `beklenen 401, gelen ${res.statusCode}`);
  });

  await t("Başka bir secret ile imzalanmış token reddedilir", async () => {
    const jwtLib = require("jsonwebtoken");
    const forged = jwtLib.sign({ userId: "someone" }, "saldirganin-secreti");
    const res = await authed(forged, { method: "GET", url: "/user/profile" });
    assert(res.statusCode === 401, "sahte token kabul edildi");
  });

  /* ---------------- kullanıcı izolasyonu ---------------- */

  await t("Kullanıcı A'nın profili B'ye sızmaz", async () => {
    await authed(tokenA, { method: "PUT", url: "/user/profile", payload: { firstName: "Ayse" } });
    await authed(tokenB, { method: "PUT", url: "/user/profile", payload: { firstName: "Burak" } });

    const a = await authed(tokenA, { method: "GET", url: "/user/profile" });
    const b = await authed(tokenB, { method: "GET", url: "/user/profile" });
    assert(a.json().profile.firstName === "Ayse", "A yanlış profil aldı");
    assert(b.json().profile.firstName === "Burak", "B yanlış profil aldı");
  });

  await t("Doğum haritası kullanıcıya özel", async () => {
    await authed(tokenA, {
      method: "POST",
      url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });
    await authed(tokenB, {
      method: "POST",
      url: "/astrology/chart",
      payload: { birthDate: "1990-02-14", birthTime: "06:00", birthTimeKnown: true, birthCity: "Ankara" },
    });

    const a = await authed(tokenA, { method: "GET", url: "/astrology/chart" });
    const b = await authed(tokenB, { method: "GET", url: "/astrology/chart" });
    assert(a.json().chart.sunSign === "Leo", `A: beklenen Leo, gelen ${a.json().chart.sunSign}`);
    assert(b.json().chart.sunSign === "Aquarius", `B: beklenen Aquarius, gelen ${b.json().chart.sunSign}`);
  });

  await t("A'nın yorumu B'nin geçmişinde görünmez", async () => {
    const userA = await prisma.profile.findFirst({ where: { firstName: "Ayse" } });
    await prisma.reading.create({
      data: {
        userId: userA!.userId,
        category: "daily",
        content: { energy: "", insight: "A'ya ait gizli yorum", advice: "" },
        readingDate: new Date(Date.UTC(2020, 0, 1)),
      },
    });

    const hist = await authed(tokenB, { method: "GET", url: "/readings/history" });
    const found = JSON.stringify(hist.json()).includes("gizli yorum");
    assert(!found, "A'nın yorumu B'ye sızdı");
  });

  await t("A, B'nin yorumunu favorileyemez", async () => {
    const userA = await prisma.profile.findFirst({ where: { firstName: "Ayse" } });
    const reading = await prisma.reading.findFirst({ where: { userId: userA!.userId } });

    const res = await authed(tokenB, { method: "POST", url: `/readings/${reading!.id}/favorite` });
    assert(res.statusCode === 404, `beklenen 404, gelen ${res.statusCode}`);
  });

  await t("A, B'nin sohbet mesajlarını okuyamaz", async () => {
    const userB = await prisma.profile.findFirst({ where: { firstName: "Burak" } });
    const session = await prisma.chatSession.create({ data: { userId: userB!.userId } });
    await prisma.chatMessage.create({
      data: { chatSessionId: session.id, role: "user", content: "B'nin özel mesajı" },
    });

    const res = await authed(tokenA, { method: "GET", url: `/ai/chat/${session.id}/messages` });
    assert(res.statusCode === 404, `beklenen 404, gelen ${res.statusCode}`);
  });

  /* ---------------- abonelik güvenliği ---------------- */

  await t("Client 'premium: true' iddiasıyla premium olamaz", async () => {
    const res = await authed(tokenA, {
      method: "POST",
      url: "/subscription/verify",
      payload: { provider: "apple", purchaseToken: "sahte-token", premium: true, isPremium: true },
    });
    assert(res.statusCode !== 200, `sahte satın alma kabul edildi (${res.statusCode})`);

    const status = await authed(tokenA, { method: "GET", url: "/subscription" });
    assert(status.json().isPremium === false, "kullanıcı premium oldu");
  });

  await t("Doğrulanmamış webhook abonelik durumunu değiştiremez", async () => {
    const res = await inject({
      method: "POST",
      url: "/subscription/webhook/apple",
      payload: { signedPayload: "sahte.imzasiz.payload" },
    });
    assert(res.statusCode === 401, `beklenen 401, gelen ${res.statusCode}`);
  });

  /* ---------------- anonim hesabı e-postaya bağlama ---------------- */

  await t("Anonim hesap e-postaya bağlanınca userId DEĞİŞMEZ", async () => {
    const anon = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = anon.json().token;
    const originalId = anon.json().userId;

    // Hesaba veri ve abonelik ekle
    await authed(token, { method: "PUT", url: "/user/profile", payload: { firstName: "Deniz" } });
    await prisma.subscription.create({
      data: {
        userId: originalId,
        provider: "apple",
        status: "active",
        providerTransactionId: `tx_${Date.now()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    const res = await authed(token, {
      method: "POST",
      url: "/auth/link-email",
      payload: { email: "baglanan@test.com", password: "guclusifre123" },
    });
    assert(res.statusCode === 200, `beklenen 200, gelen ${res.statusCode}`);

    // KRİTİK: aynı hesap güncellenmeli, yeni hesap açılmamalı
    const user = await prisma.user.findUnique({ where: { email: "baglanan@test.com" } });
    assert(user!.id === originalId, "yeni hesap açılmış — abonelik ve veri kaybolurdu");
    assert(user!.isAnonymous === false, "isAnonymous güncellenmemiş");

    // Abonelik korunmuş olmalı
    const sub = await prisma.subscription.findFirst({ where: { userId: originalId } });
    assert(!!sub, "ABONELİK KAYBOLDU");

    // Eski token hâlâ geçerli olmalı (aynı userId)
    const me = await authed(token, { method: "GET", url: "/auth/me" });
    assert(me.statusCode === 200 && me.json().isAnonymous === false, "token geçersizleşti");
  });

  await t("Bağlanan hesaba başka cihazdan giriş yapılabilir", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "baglanan@test.com", password: "guclusifre123" },
    });
    assert(res.statusCode === 200, `giriş başarısız (${res.statusCode})`);

    // Giriş yapan token aynı hesabın verisine erişmeli
    const profile = await authed(res.json().token, { method: "GET", url: "/user/profile" });
    assert(profile.json().profile?.firstName === "Deniz", "veriler gelmedi");
  });

  await t("Zaten bağlı hesap tekrar bağlanamaz", async () => {
    const login = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "baglanan@test.com", password: "guclusifre123" },
    });
    const res = await authed(login.json().token, {
      method: "POST",
      url: "/auth/link-email",
      payload: { email: "baska@test.com", password: "guclusifre123" },
    });
    assert(res.statusCode === 409, `beklenen 409, gelen ${res.statusCode}`);
  });

  await t("Başkasına ait e-posta bağlanamaz", async () => {
    const anon = await inject({ method: "POST", url: "/auth/anonymous" });
    const res = await authed(anon.json().token, {
      method: "POST",
      url: "/auth/link-email",
      payload: { email: "baglanan@test.com", password: "guclusifre123" },
    });
    assert(res.statusCode === 409, `beklenen 409, gelen ${res.statusCode}`);
    assert(res.json().shouldLogin === true, "istemciye giriş yapması söylenmeli");
  });

  await t("Anonim hesaba e-postasıyla giriş yapılamaz", async () => {
    // Anonim hesapların sahte e-postası vardır; bunlarla giriş kapalı olmalı
    const anon = await inject({ method: "POST", url: "/auth/anonymous" });
    const user = await prisma.user.findUnique({ where: { id: anon.json().userId } });
    const res = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user!.email, password: "herhangi" },
    });
    assert(res.statusCode === 401, "anonim hesaba giriş yapılabildi");
  });

  await t("Giriş sırasında BOŞ anonim hesap temizlenir", async () => {
    const anon = await inject({ method: "POST", url: "/auth/anonymous" });
    const orphanId = anon.json().userId;

    await inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "baglanan@test.com",
        password: "guclusifre123",
        discardToken: anon.json().token,
      },
    });

    const still = await prisma.user.count({ where: { id: orphanId } });
    assert(still === 0, "boş anonim hesap temizlenmedi");
  });

  await t("Verisi OLAN anonim hesap giriş sırasında silinmez", async () => {
    const anon = await inject({ method: "POST", url: "/auth/anonymous" });
    const keepId = anon.json().userId;
    await prisma.reading.create({
      data: { userId: keepId, category: "daily", content: {}, readingDate: new Date() },
    });

    await inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "baglanan@test.com",
        password: "guclusifre123",
        discardToken: anon.json().token,
      },
    });

    const still = await prisma.user.count({ where: { id: keepId } });
    assert(still === 1, "veri içeren hesap silindi — VERİ KAYBI");
  });

  await t("Sahte discardToken ile başkasının hesabı silinemez", async () => {
    const victim = await inject({ method: "POST", url: "/auth/anonymous" });
    const victimId = victim.json().userId;

    // Saldırgan kendi uydurduğu token'ı gönderiyor
    const jwtLib = require("jsonwebtoken");
    const forged = jwtLib.sign({ userId: victimId }, "saldirganin-secreti");

    await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "baglanan@test.com", password: "guclusifre123", discardToken: forged },
    });

    const still = await prisma.user.count({ where: { id: victimId } });
    assert(still === 1, "GÜVENLİK: sahte token ile başkasının hesabı silindi");
  });

  /* ---------------- kota yarış durumu (concurrency) ---------------- */

  await t("Paralel istekler free kullanıcının kotasını AŞAMAZ", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("     (ANTHROPIC_API_KEY yok — AI gerektiren yarış testi atlandı)");
      return;
    }

    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;
    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });

    // Free limit = 1/gün. Aynı anda 4 FARKLI kategori isteği gönderiyoruz.
    // Kilit yoksa hepsi "henüz limite ulaşmadın" görüp AI çağrısı yapabilirdi.
    const categories = ["daily", "love", "career", "money"];
    const responses = await Promise.all(
      categories.map((cat) => authed(token, { method: "POST", url: `/readings/${cat}` }))
    );

    const succeeded = responses.filter((r) => r.statusCode === 200).length;
    const quotaBlocked = responses.filter((r) => r.statusCode === 402).length;

    assert(succeeded === 1, `beklenen 1 başarılı üretim, gelen ${succeeded} — KOTA AŞILDI (yarış durumu)`);
    assert(quotaBlocked === categories.length - 1, `beklenen ${categories.length - 1} engelleme, gelen ${quotaBlocked}`);

    const stored = await prisma.reading.count({ where: { userId: u.json().userId } });
    assert(stored === 1, `DB'de ${stored} yorum var, 1 olmalıydı`);
  });

  /* ---------------- doğum bilgisi güncelleme ---------------- */

  await t("Doğum bilgisi değişince harita yeniden hesaplanır", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;

    await authed(token, {
      method: "POST",
      url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });
    const before = await authed(token, { method: "GET", url: "/astrology/chart" });
    assert(before.json().chart.sunSign === "Leo", "ilk harita yanlış");

    // Kullanıcı tarihi düzeltiyor
    const upd = await authed(token, {
      method: "POST",
      url: "/astrology/chart",
      payload: { birthDate: "1990-02-14", birthTime: "06:00", birthTimeKnown: true, birthCity: "Ankara" },
    });
    assert(upd.statusCode === 200, `güncelleme başarısız (${upd.statusCode})`);

    const after = await authed(token, { method: "GET", url: "/astrology/chart" });
    assert(after.json().chart.sunSign === "Aquarius", `harita güncellenmedi: ${after.json().chart.sunSign}`);

    // Tek kayıt kalmalı — her güncellemede yeni satır oluşmamalı
    const count = await prisma.birthData.count({ where: { userId: u.json().userId } });
    assert(count === 1, `${count} doğum kaydı var, 1 olmalı`);
  });

  await t("Doğum saati kaldırılınca yükselen silinir", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;

    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });
    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: null, birthTimeKnown: false, birthCity: "Istanbul" },
    });

    const res = await authed(token, { method: "GET", url: "/astrology/chart" });
    assert(res.json().chart.risingSign === null, "saat kaldırıldı ama yükselen duruyor");
  });

  await t("Bilinmeyen şehir anlamlı hata döndürür", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const res = await authed(u.json().token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2000-01-01", birthTimeKnown: false, birthCity: "Xyzzyx Qwerty" },
    });
    assert(res.statusCode === 400, `beklenen 400, gelen ${res.statusCode}`);
    assert(!!res.json().error, "hata mesajı yok");
  });

  await t("Günlük puanlar hesaplanıyor ve 1-5 arasında", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;
    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });

    const res = await authed(token, { method: "GET", url: "/astrology/daily-scores" });
    assert(res.statusCode === 200, `beklenen 200, gelen ${res.statusCode}`);
    const sc = res.json().scores;
    for (const k of ["energy", "love", "career", "money"]) {
      assert(sc[k] >= 1 && sc[k] <= 5, `${k} aralık dışı: ${sc[k]}`);
    }
  });

  /* ---------------- uyum analizi ---------------- */

  await t("Free kullanıcı uyum analizine erişemez", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;
    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });

    const res = await authed(token, {
      method: "POST", url: "/compatibility",
      payload: { partnerName: "Test", partnerBirthDate: "1999-11-03" },
    });
    assert(res.statusCode === 402, `beklenen 402, gelen ${res.statusCode}`);
    assert(res.json().upgradeRequired === true, "upgradeRequired bayrağı yok");
  });

  await t("Uyum puanları partnere göre değişir (hash değil, harita)", async () => {
    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;
    const userId = u.json().userId;

    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });
    await prisma.subscription.create({
      data: {
        userId, provider: "apple", status: "active",
        providerTransactionId: `tx_comp_${Date.now()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    // AI çağrısı gerektiği için anahtar yoksa bu test atlanır
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("     (ANTHROPIC_API_KEY yok — uyum AI kısmı atlandı)");
      return;
    }

    const r1 = await authed(token, {
      method: "POST", url: "/compatibility",
      payload: { partnerName: "Ali", partnerBirthDate: "1999-11-03", partnerBirthTime: "08:15" },
    });
    const r2 = await authed(token, {
      method: "POST", url: "/compatibility",
      payload: { partnerName: "Ali", partnerBirthDate: "1995-04-12", partnerBirthTime: "14:00" },
    });

    assert(r1.statusCode === 201 && r2.statusCode === 201, "uyum analizi başarısız");
    const s1 = JSON.stringify(r1.json().check.scores);
    const s2 = JSON.stringify(r2.json().check.scores);
    assert(s1 !== s2, "farklı partnerler aynı puanı aldı — hesap haritaya bağlı değil");
  });

  /* ---------------- uyum analizi kotası ---------------- */

  await t("Uyum analizi kota mesajı 'upgradeRequired: false' döner (zaten premium)", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("     (ANTHROPIC_API_KEY yok — AI gerektiren test atlandı)");
      return;
    }

    const u = await inject({ method: "POST", url: "/auth/anonymous" });
    const token = u.json().token;
    const userId = u.json().userId;

    await authed(token, {
      method: "POST", url: "/astrology/chart",
      payload: { birthDate: "2002-07-28", birthTime: "19:30", birthTimeKnown: true, birthCity: "Istanbul" },
    });
    await prisma.subscription.create({
      data: {
        userId, provider: "apple", status: "active",
        providerTransactionId: `tx_capquota_${Date.now()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    // Günlük tavanı doldur (premium limiti kadar sahte kayıt ekleyerek — gerçek
    // AI çağrısı yapmadan hızlıca test etmek için doğrudan DB'ye yazıyoruz)
    const { PREMIUM_LIMITS } = require("../src/lib/limits");
    for (let i = 0; i < PREMIUM_LIMITS.compatibilityPerDay; i++) {
      await prisma.compatibilityCheck.create({
        data: { userId, partnerName: `p${i}`, partnerBirthData: {}, scores: {} },
      });
    }

    const res = await authed(token, {
      method: "POST", url: "/compatibility",
      payload: { partnerName: "Test", partnerBirthDate: "1999-11-03" },
    });

    assert(res.statusCode === 402, `beklenen 402, gelen ${res.statusCode}`);
    assert(
      res.json().upgradeRequired === false,
      "premium kullanıcıya yanlışlıkla 'yükselt' mesajı gösteriliyor"
    );
  });

  /* ---------------- hesap silme (KVKK/GDPR) ---------------- */

  await t("Hesap silindiğinde tüm veriler silinir", async () => {
    const userB = await prisma.profile.findFirst({ where: { firstName: "Burak" } });
    const userId = userB!.userId;

    const res = await authed(tokenB, { method: "DELETE", url: "/user/account" });
    assert(res.statusCode === 200, `beklenen 200, gelen ${res.statusCode}`);

    const leftovers = await Promise.all([
      prisma.user.count({ where: { id: userId } }),
      prisma.profile.count({ where: { userId } }),
      prisma.birthData.count({ where: { userId } }),
      prisma.chatSession.count({ where: { userId } }),
      prisma.reading.count({ where: { userId } }),
    ]);
    assert(
      leftovers.every((n) => n === 0),
      `silinmemiş kayıt var: ${leftovers.join(",")}`
    );
  });

  await cleanup();
  await app.close();
  await prisma.$disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(async (err) => {
  console.error("Test çalıştırılamadı:", err.message);
  console.error("\nGerçek bir PostgreSQL bağlantısı gerekli. Yukarıdaki kurulum adımlarına bak.");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
