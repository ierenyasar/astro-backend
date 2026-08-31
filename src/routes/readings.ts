import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { generateStructuredReading } from "../lib/anthropic";
import { checkReadingQuota } from "../lib/limits";
import { signByName } from "../lib/astrology";
import { checkAiOutput, countCliches } from "../lib/safety";
import { withUserLock } from "../lib/lock";
import {
  dailyReadingPrompt,
  loveReadingPrompt,
  careerReadingPrompt,
  moneyReadingPrompt,
  weeklyReadingPrompt,
  monthlyReadingPrompt,
  AstrologyContext,
} from "../prompts";

const CATEGORY_PROMPTS: Record<string, (ctx: AstrologyContext) => string> = {
  daily: dailyReadingPrompt,
  love: loveReadingPrompt,
  career: careerReadingPrompt,
  money: moneyReadingPrompt,
  weekly: weeklyReadingPrompt,
  monthly: monthlyReadingPrompt,
};

const categoryParam = z.enum(["daily", "love", "career", "money", "weekly", "monthly"]);

function todayDateOnly() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Kullanıcının kayıtlı chart'ından AI prompt context'i kurar. */
export async function buildContext(userId: string): Promise<AstrologyContext | null> {
  const [profile, birthData] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    prisma.birthData.findUnique({ where: { userId }, include: { chart: true } }),
  ]);
  if (!birthData?.chart) return null;

  const sun = signByName(birthData.chart.sunSign);
  const planets = (birthData.chart.planets ?? null) as Record<string, { sign: string }> | null;

  return {
    name: profile?.firstName || "",
    sunSign: birthData.chart.sunSign,
    moonSign: birthData.chart.moonSign,
    risingSign: birthData.chart.risingSign,
    element: sun.element,
    ruler: sun.ruler,
    focusArea: profile?.focusArea,
    venusSign: planets?.venus?.sign ?? null,
    marsSign: planets?.mars?.sign ?? null,
    mercurySign: planets?.mercury?.sign ?? null,
  };
}

export default async function readingsRoutes(app: FastifyInstance) {
  app.post("/readings/:category", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const catParsed = categoryParam.safeParse((req.params as any).category);
    if (!catParsed.success) {
      return reply.code(400).send({ error: "Geçersiz kategori." });
    }
    const category = catParsed.data;
    const readingDate = todayDateOnly();

    // 1) Cache: aynı gün + aynı kategori zaten üretilmişse AI çağrısı YAPMA (madde 23-24).
    //    Cache hit kotadan da düşmez — kullanıcı kendi yorumunu tekrar açabilmeli.
    const existing = await prisma.reading.findUnique({
      where: { userId_category_readingDate: { userId, category, readingDate } },
    });
    if (existing) {
      return reply.send({ reading: existing, cached: true });
    }

    const ctx = await buildContext(userId);
    if (!ctx) {
      return reply.code(400).send({ error: "Önce doğum haritası oluşturulmalı (POST /astrology/chart)." });
    }

    /**
     * 2) Kota kontrolü + üretim + kayıt AYNI KULLANICI KİLİDİ altında.
     *
     * Neden: kota kontrolü ("bugün kaç yorum ürettin?") ile kaydın yazılması
     * arasında zaman farkı var. Bu ikisi arasına aynı kullanıcıdan paralel bir
     * istek girerse (örn. "daily" ve "love" aynı anda açılırsa), ikisi de
     * "henüz limite ulaşmadın" görüp AI çağrısı yapabilirdi — free kullanıcı
     * günde 1 yorum hakkına sahipken 2-3 yorum üretebilirdi. Advisory lock aynı
     * kullanıcının isteklerini sıraya sokar; farklı kullanıcılar birbirini beklemez.
     *
     * Ödünleşim: AI çağrısı (saniyeler sürebilir) lock içinde kaldığı için bir
     * bağlantıyı o süre boyunca meşgul eder. Bu uygulamanın ölçeğinde (kullanıcı
     * başına günde birkaç istek) kabul edilebilir; çok yüksek eşzamanlılıkta
     * rezervasyon satırı deseniyle (önce boş satır yaz, sonra doldur) kısaltılabilir.
     */
    let outcome: { status: "ok"; reading: unknown } | { status: "quota_exceeded"; quota: any } | { status: "unsafe" };
    try {
      outcome = await withUserLock(userId, async (tx) => {
        const quota = await checkReadingQuota(userId, tx);
        if (!quota.allowed) {
          return { status: "quota_exceeded" as const, quota };
        }

        const content = await generateStructuredReading(CATEGORY_PROMPTS[category](ctx));

        // Yasak iddia kontrolü — yorum DB'ye yazılmadan önce (madde 9, 42)
        const combined = [content.energy, content.insight, content.advice].join(" ");
        const outputCheck = checkAiOutput(combined);
        if (!outputCheck.safe) {
          req.log.warn({ reason: outputCheck.reason, category }, "Yorum güvenlik kontrolünden geçemedi");
          return { status: "unsafe" as const };
        }

        const clicheCount = countCliches(combined);
        if (clicheCount > 0) {
          req.log.info({ clicheCount, category }, "Yorumda klişe kalıp tespit edildi");
        }

        const reading = await tx.reading.create({
          data: {
            userId,
            category,
            // Cast gerekli: content {energy, insight, advice} şeklinde tipli bir nesne,
            // Prisma'nın Json alanı index signature'ı olmadan bunu kabul etmez.
            content: content as any,
            readingDate,
            modelVersion: "claude-sonnet-4-6",
          },
        });

        return { status: "ok" as const, reading };
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: "Yorumun şu anda oluşturulamadı. Lütfen tekrar dene." });
    }

    if (outcome.status === "quota_exceeded") {
      const { quota } = outcome;
      return reply.code(402).send({
        error: quota.premium
          ? "Günlük kullanım limitine ulaşıldı."
          : "Yıldızların sana söyleyecek daha çok şeyi var.",
        upgradeRequired: !quota.premium,
        used: quota.used,
        limit: quota.limit,
      });
    }
    if (outcome.status === "unsafe") {
      // Kaydetme ve kota harcama: kullanıcı hatalı bir üretim yüzünden hakkını kaybetmemeli
      return reply.code(503).send({ error: "Yorumun şu anda oluşturulamadı. Lütfen tekrar dene." });
    }

    return reply.send({ reading: outcome.reading, cached: false });
  });

  /**
   * Bugün ZATEN üretilmiş yorumlar.
   *
   * Ana ekran önizlemesi için kullanılır. Üretim tetiklemez, kota harcamaz —
   * aksi halde kullanıcı uygulamayı her açtığında günlük hakkı tükenirdi.
   */
  app.get("/readings/today", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const readings = await prisma.reading.findMany({
      where: { userId, readingDate: todayDateOnly() },
    });
    return reply.send({ readings });
  });

  app.get("/readings/history", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const readings = await prisma.reading.findMany({
      where: { userId },
      orderBy: { readingDate: "desc" },
      take: 50,
    });
    return reply.send({ readings });
  });

  app.post("/readings/:id/favorite", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const { id } = req.params as { id: string };

    const reading = await prisma.reading.findFirst({ where: { id, userId } });
    if (!reading) {
      return reply.code(404).send({ error: "Yorum bulunamadı." });
    }

    const existing = await prisma.favorite.findFirst({ where: { userId, readingId: id } });
    if (existing) {
      return reply.send({ favorite: existing, alreadyFavorited: true });
    }

    const favorite = await prisma.favorite.create({ data: { userId, readingId: id } });
    return reply.code(201).send({ favorite });
  });

  app.get("/readings/favorites", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const favorites = await prisma.favorite.findMany({
      where: { userId, readingId: { not: null } },
      include: { reading: true },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({ favorites });
  });
}
