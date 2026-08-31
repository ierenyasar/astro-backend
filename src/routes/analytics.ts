import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { EVENT_NAMES, sanitizeProperties } from "../lib/analytics-events";

const eventSchema = z.object({
  name: z.string().min(1).max(64),
  properties: z.record(z.unknown()).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().max(32).optional(),
  /** İstemci offline'ken biriktirdiği eventin gerçek zamanı */
  occurredAt: z.string().datetime().optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

export default async function analyticsRoutes(app: FastifyInstance) {
  /**
   * Event gönderimi (toplu).
   *
   * Analitik asla kullanıcı akışını bozmamalı: geçersiz event adı gelse bile
   * istek 200 döner, sadece o event atlanır. İstemci tarafında bir hata
   * yüzünden kullanıcının uygulaması bozulmaz.
   */
  app.post("/analytics/events", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const known = parsed.data.events.filter((e) => EVENT_NAMES.includes(e.name));
    const unknown = parsed.data.events.length - known.length;
    if (unknown > 0) {
      // Şemada olmayan event adı: muhtemelen yazım hatası veya güncellenmemiş istemci
      req.log.warn({ unknown }, "Tanımsız analytics event adı atlandı");
    }

    if (known.length) {
      await prisma.analyticsEvent.createMany({
        data: known.map((e) => ({
          userId,
          name: e.name,
          properties: sanitizeProperties(e.properties) as any,
          platform: e.platform,
          appVersion: e.appVersion,
          ...(e.occurredAt ? { createdAt: new Date(e.occurredAt) } : {}),
        })),
      });
    }

    return reply.send({ accepted: known.length, skipped: unknown });
  });

  /**
   * Temel metrik özeti (iç kullanım).
   * ANALYTICS_SECRET ile korunur — kullanıcı verisi toplamı herkese açık olmamalı.
   */
  app.get("/internal/analytics/summary", async (req, reply) => {
    const secret = process.env.ANALYTICS_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: "ANALYTICS_SECRET tanımlı değil." });
    }
    if (req.headers["x-analytics-secret"] !== secret) {
      return reply.code(401).send({ error: "Yetkisiz." });
    }

    const days = Math.min(Number((req.query as any)?.days) || 7, 90);
    const since = new Date(Date.now() - days * 86400000);

    const [byName, activeUsers, totalUsers, premiumUsers] = await Promise.all([
      prisma.analyticsEvent.groupBy({
        by: ["name"],
        where: { createdAt: { gte: since } },
        _count: { name: true },
      }),
      prisma.analyticsEvent
        .findMany({
          where: { createdAt: { gte: since }, userId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
        })
        .then((r: { userId: string | null }[]) => r.length),
      prisma.user.count(),
      prisma.subscription.count({
        where: {
          status: { in: ["trial", "active"] },
          OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }],
        },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byName as { name: string; _count: { name: number } }[]) {
      counts[row.name] = row._count.name;
    }

    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

    return reply.send({
      periodDays: days,
      totalUsers,
      activeUsers,
      premiumUsers,
      eventCounts: counts,
      // Ürün için asıl önemli olanlar: huni kayıpları ve dönüşüm
      funnels: {
        onboardingCompletionRate: pct(
          counts["onboarding_completed"] ?? 0,
          counts["onboarding_started"] ?? 0
        ),
        paywallToPurchaseRate: pct(
          (counts["subscription_started"] ?? 0) + (counts["trial_started"] ?? 0),
          counts["paywall_viewed"] ?? 0
        ),
        quotaToPaywallRate: pct(counts["paywall_viewed"] ?? 0, counts["quota_exhausted"] ?? 0),
        premiumShare: pct(premiumUsers, totalUsers),
      },
    });
  });
}
