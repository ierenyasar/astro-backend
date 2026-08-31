import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import path from "path";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import astrologyRoutes from "./routes/astrology";
import readingsRoutes from "./routes/readings";
import chatRoutes from "./routes/chat";
import compatibilityRoutes from "./routes/compatibility";
import subscriptionRoutes from "./routes/subscription";
import notificationRoutes from "./routes/notifications";
import analyticsRoutes from "./routes/analytics";
import { startNotificationScheduler, runDailyNotificationJob } from "./jobs/daily-notifications";

async function main() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET tanımlı değil. .env dosyanı kontrol et (bkz. .env.example).");
  }

  const app = Fastify({
    logger: true,
    // Hiçbir uç büyük gövdeye ihtiyaç duymuyor (en büyüğü ~2000 karakterlik chat mesajı).
    // Fastify'ın örtük varsayılanı (1MB) yerine niyeti açıkça belirtiyoruz.
    bodyLimit: 256 * 1024, // 256 KB
  });

  await app.register(cors, { origin: process.env.CORS_ORIGIN || "*" });
  await app.register(jwt, { secret: process.env.JWT_SECRET });

  // Genel abuse koruması — kullanıcı bazlı daha sıkı limitler ileride her route'a özel eklenebilir (madde 22)
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  /**
   * Şifre sıfırlama sayfası. E-postadaki bağlantı buraya gelir.
   *
   * `public/` altındaki dosyalar statik olarak sunulur. Ayrı bir web sitesi
   * kurmak istemezsen PASSWORD_RESET_URL'i buraya işaret ettirmen yeterli:
   *   PASSWORD_RESET_URL="https://SENIN-BACKEND/sifre-sifirla"
   */
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    // API rotalarıyla çakışmasın diye dizin listelemesi kapalı
    index: false,
    list: false,
  });

  app.get("/sifre-sifirla", async (_req, reply) => {
    return reply.sendFile("sifre-sifirla.html");
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(astrologyRoutes);
  await app.register(readingsRoutes);
  await app.register(chatRoutes);
  await app.register(compatibilityRoutes);
  await app.register(subscriptionRoutes);
  await app.register(notificationRoutes);
  await app.register(analyticsRoutes);

  /**
   * Harici cron tetikleyicisi (Railway/Render/Fly cron, AWS EventBridge vb.).
   * Çok instance'lı kurulumda dahili zamanlayıcı yerine bunu kullan
   * (DISABLE_NOTIFICATION_SCHEDULER=true ile dahili olanı kapat).
   *
   * CRON_SECRET ile korunur — bu uç kimlik doğrulaması olmadan açık bırakılmamalı.
   */
  app.post("/internal/cron/daily-notifications", async (req, reply) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: "CRON_SECRET tanımlı değil." });
    }
    if (req.headers["x-cron-secret"] !== secret) {
      return reply.code(401).send({ error: "Yetkisiz." });
    }
    const result = await runDailyNotificationJob();
    return reply.send(result);
  });

  startNotificationScheduler(app.log);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Astro backend http://localhost:${port} adresinde çalışıyor`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
