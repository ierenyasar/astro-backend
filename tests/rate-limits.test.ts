import { installPrismaMock } from "./mock-prisma";
installPrismaMock();

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";

/**
 * Kimliksiz uçların dedike rate limit'i test edilir.
 *
 * Bu üç uç özellikle risklidir çünkü hiçbir kimlik doğrulama gerektirmeden
 * DB yazımı ve/veya CPU-yoğun işlem (bcrypt.hash) tetikliyor:
 *   - /auth/anonymous ve /auth/register: her çağrı bcrypt.hash() çalıştırır
 *     (bilinçli olarak yavaş bir fonksiyon) + DB'ye User satırı yazar.
 *   - /astrology/cities: yerleşik listede yoksa dış bir servise (Nominatim)
 *     istek atabilir — spam, dış API kötüye kullanımı veya bizim o servisin
 *     hız sınırına takılıp TÜM kullanıcıların şehir aramasını yavaşlatmasına
 *     yol açabilir.
 *
 * Genel 100/dk limiti bu uçlar için yeterince sıkı değildir; dedike, daha
 * düşük limitler gerekir.
 */

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
  const authRoutes = require("../src/routes/auth").default;
  const astrologyRoutes = require("../src/routes/astrology").default;
  const subscriptionRoutes = require("../src/routes/subscription").default;

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "test-secret-yeterince-uzun-1234567890" });
  // Global limiti gevşek tutuyoruz ki testte sadece ROUTE'A ÖZEL limit ölçülsün
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(authRoutes);
  await app.register(astrologyRoutes);
  await app.register(subscriptionRoutes);
  return app;
}

async function main() {
  const app = await buildApp();

  await t("/auth/anonymous dedike limitte (20/dk) durur", async () => {
    let blocked = 0,
      ok = 0;
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/anonymous" });
      if (res.statusCode === 429) blocked++;
      else ok++;
    }
    assert(ok === 20, `beklenen 20 başarılı, gelen ${ok}`);
    assert(blocked === 2, `beklenen 2 engelleme, gelen ${blocked}`);
  });

  await t("/astrology/cities dedike limitte (30/dk) durur", async () => {
    let blocked = 0,
      ok = 0;
    for (let i = 0; i < 32; i++) {
      const res = await app.inject({ method: "GET", url: `/astrology/cities?q=xyz${i}` });
      if (res.statusCode === 429) blocked++;
      else ok++;
    }
    assert(ok === 30, `beklenen 30 başarılı, gelen ${ok}`);
    assert(blocked === 2, `beklenen 2 engelleme, gelen ${blocked}`);
  });

  await t("/auth/register dedike limitte (10/15dk) durur", async () => {
    let blocked = 0,
      ok = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: `ratelimit${i}@test.com`, password: "guclusifre123" },
      });
      if (res.statusCode === 429) blocked++;
      else ok++;
    }
    assert(ok === 10, `beklenen 10 başarılı, gelen ${ok}`);
    assert(blocked === 2, `beklenen 2 engelleme, gelen ${blocked}`);
  });

  await t("/subscription/webhook/apple dedike limitte (60/dk) durur", async () => {
    let blocked = 0,
      ok = 0;
    for (let i = 0; i < 62; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/subscription/webhook/apple",
        payload: { signedPayload: "gecersiz.imza.denemesi" },
      });
      if (res.statusCode === 429) blocked++;
      else ok++;
    }
    assert(ok === 60, `beklenen 60 başarılı (401 dahil), gelen ${ok}`);
    assert(blocked === 2, `beklenen 2 engelleme, gelen ${blocked}`);
  });

  await t("/subscription/webhook/google dedike limitte (60/dk) durur", async () => {
    let blocked = 0,
      ok = 0;
    for (let i = 0; i < 62; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/subscription/webhook/google",
        payload: {},
      });
      if (res.statusCode === 429) blocked++;
      else ok++;
    }
    assert(ok === 60, `beklenen 60 başarılı (401 dahil), gelen ${ok}`);
    assert(blocked === 2, `beklenen 2 engelleme, gelen ${blocked}`);
  });

  await app.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
