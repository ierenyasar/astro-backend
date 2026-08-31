import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { sendPushToUsers } from "../lib/push";

const registerSchema = z.object({
  token: z.string().min(1).max(300, "Geçersiz token"),
  platform: z.enum(["ios", "android"]).optional(),
  timezone: z.string().max(50).optional(),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  hourLocal: z.number().int().min(0).max(23).optional(),
  timezone: z.string().max(50).optional(),
});

export default async function notificationRoutes(app: FastifyInstance) {
  /** Cihaz push token'ını kaydeder veya günceller. */
  app.post("/notifications/register", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { token, platform, timezone } = parsed.data;

    // Aynı token başka bir hesaba kayıtlıysa (cihaz el değiştirdi, kullanıcı çıkış yaptı)
    // token yeni kullanıcıya taşınır — aksi halde eski kullanıcının bildirimleri
    // yeni kullanıcının cihazına düşerdi.
    const existing = await prisma.pushToken.findUnique({ where: { token } });

    const pushToken = existing
      ? await prisma.pushToken.update({
          where: { token },
          data: { userId, platform, timezone, enabled: true, failCount: 0 },
        })
      : await prisma.pushToken.create({
          data: { userId, token, platform, timezone },
        });

    return reply.code(201).send({ pushToken });
  });

  /** Kullanıcının bildirim ayarlarını getirir. */
  app.get("/notifications/settings", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const tokens = await prisma.pushToken.findMany({ where: { userId } });
    const primary = tokens[0] ?? null;

    return reply.send({
      enabled: primary?.enabled ?? false,
      hourLocal: primary?.hourLocal ?? 9,
      timezone: primary?.timezone ?? null,
      deviceCount: tokens.length,
    });
  });

  /** Bildirim ayarlarını günceller (kullanıcı kapatabilmeli — madde 17). */
  app.put("/notifications/settings", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    await prisma.pushToken.updateMany({
      where: { userId },
      data: parsed.data,
    });

    return reply.send({ ...parsed.data, updated: true });
  });

  /**
   * Toplu bildirim gönderimi (yönetim ucu).
   *
   * Duyuru, kampanya veya bilgilendirme göndermek için. ADMIN_SECRET ile korunur —
   * kullanıcı token'ı yeterli DEĞİL, aksi halde herhangi bir kullanıcı tüm kitleye
   * bildirim gönderebilirdi.
   *
   * Varsayılan olarak yalnızca bir ÖNİZLEME döndürür (kaç kişiye gideceği).
   * Gerçekten göndermek için `confirm: true` gerekir — yanlışlıkla tüm kullanıcılara
   * mesaj atmayı zorlaştırmak için bilinçli iki adımlı.
   */
  app.post("/internal/notifications/broadcast", {
    config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
  }, async (req, reply) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: "ADMIN_SECRET tanımlı değil." });
    }
    if (req.headers["x-admin-secret"] !== secret) {
      return reply.code(401).send({ error: "Yetkisiz." });
    }

    const parsed = z
      .object({
        title: z.string().min(1).max(80),
        body: z.string().min(1).max(180),
        /** "all" | "premium" | "free" */
        audience: z.enum(["all", "premium", "free"]).default("all"),
        /** Bildirime tıklayınca açılacak ekran (uygulama data.screen'e bakar) */
        screen: z.string().max(40).optional(),
        confirm: z.boolean().default(false),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { title, body, audience, screen, confirm } = parsed.data;

    // Bildirimi kapatmış kullanıcılar hiçbir koşulda dahil edilmez
    const tokens = await prisma.pushToken.findMany({
      where: { enabled: true, failCount: { lt: 3 } },
      select: { userId: true },
    });
    let userIds: string[] = Array.from(
      new Set((tokens as { userId: string }[]).map((t) => t.userId))
    );

    if (audience !== "all") {
      const premiumSubs = await prisma.subscription.findMany({
        where: {
          userId: { in: userIds },
          status: { in: ["trial", "active"] },
          OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }],
        },
        select: { userId: true },
      });
      const premiumSet = new Set((premiumSubs as { userId: string }[]).map((s) => s.userId));
      userIds = userIds.filter((id) =>
        audience === "premium" ? premiumSet.has(id) : !premiumSet.has(id)
      );
    }

    if (!confirm) {
      return reply.send({
        preview: true,
        wouldSendTo: userIds.length,
        audience,
        title,
        body,
        note: "Göndermek için aynı isteği confirm: true ile tekrarla.",
      });
    }

    const result = await sendPushToUsers(userIds, {
      title,
      body,
      data: { type: "broadcast", ...(screen ? { screen } : {}) },
    });

    await prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: "broadcast",
        title,
        body,
        sentAt: new Date(),
      })),
    });

    req.log.info({ audience, targeted: userIds.length, ...result }, "Toplu bildirim gönderildi");
    return reply.send({ sent: result.sent, disabled: result.disabled, targeted: userIds.length });
  });

  /** Kendine test bildirimi gönderir — yayın öncesi doğrulama için. */
  app.post("/notifications/test", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const result = await sendPushToUsers([userId], {
      title: "Test bildirimi ✦",
      body: "Bildirimler çalışıyor.",
      data: { type: "test" },
    });
    if (result.sent === 0) {
      return reply.code(400).send({
        error: "Bildirim gönderilemedi. Cihaz kayıtlı mı ve bildirimlere izin verilmiş mi kontrol et.",
      });
    }
    return reply.send({ sent: result.sent });
  });

  /** Cihazı bildirim listesinden çıkarır (çıkış yapma / cihaz silme). */
  app.delete("/notifications/register", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const { token } = (req.body ?? {}) as { token?: string };

    if (token) {
      await prisma.pushToken.deleteMany({ where: { userId, token } });
    } else {
      await prisma.pushToken.deleteMany({ where: { userId } });
    }
    return reply.send({ deleted: true });
  });
}
