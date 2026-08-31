import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { generateFreeTextReply } from "../lib/anthropic";
import { compatibilityPrompt } from "../prompts";
import { computeChart, computeSynastry, signByName, GeocodingError } from "../lib/astrology";
import { checkAiOutput } from "../lib/safety";
import { getLimits, checkCompatibilityQuota } from "../lib/limits";
import { withUserLock } from "../lib/lock";
import { buildContext } from "./readings";

const compatibilitySchema = z.object({
  partnerName: z.string().min(1).max(60),
  partnerBirthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG formatında olmalı"),
  /** Bilinmiyorsa yükselen ve ev bazlı karşılaştırma yapılmaz */
  partnerBirthTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  partnerBirthCity: z.string().min(1).max(100, "Şehir adı çok uzun").optional(),
});

export default async function compatibilityRoutes(app: FastifyInstance) {
  app.post("/compatibility", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = compatibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { partnerName, partnerBirthDate, partnerBirthTime, partnerBirthCity } = parsed.data;

    // Uyum analizi premium özelliktir (madde 18)
    const limits = await getLimits(userId);
    if (!limits.compatibilityEnabled) {
      return reply.code(402).send({
        error: "Uyum analizi Premium ile açılıyor.",
        upgradeRequired: true,
      });
    }

    const ctx = await buildContext(userId);
    if (!ctx) {
      return reply.code(400).send({ error: "Önce doğum haritası oluşturulmalı (POST /astrology/chart)." });
    }

    // Kullanıcının kendi harita dereceleri
    const birthData = await prisma.birthData.findUnique({
      where: { userId },
      include: { chart: true },
    });
    const ownDegrees = (birthData?.chart?.degrees ?? null) as { sun?: number; moon?: number } | null;
    const ownPlanets = (birthData?.chart?.planets ?? {}) as Record<string, { degree: number }>;

    if (ownDegrees?.sun == null || ownDegrees?.moon == null) {
      return reply.code(409).send({
        error: "Harita verin güncellenmeli. Doğum bilgilerini tekrar kaydet.",
        needsRecompute: true,
      });
    }

    // Partnerin haritasını hesapla (lock dışında — geocoding ağ isteği içerebilir,
    // kilidi gereksiz uzun tutmamak için sayım+üretimden önce yapılır)
    let partnerChart;
    try {
      partnerChart = await computeChart({
        birthDate: new Date(partnerBirthDate + "T00:00:00Z"),
        birthTime: partnerBirthTime ?? null,
        birthTimeKnown: !!partnerBirthTime,
        // Saat bilinmiyorsa konumun etkisi ihmal edilebilir; verilmezse İstanbul referans alınır
        birthCity: partnerBirthCity || "istanbul",
      });
    } catch (err) {
      if (err instanceof GeocodingError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "Partner haritası hesaplanamadı." });
    }

    // GERÇEK sinastri: iki haritanın gezegenleri arasındaki açılar
    const scores = computeSynastry(
      { sun: ownDegrees.sun, moon: ownDegrees.moon, planets: ownPlanets },
      { sun: partnerChart.sunDegree, moon: partnerChart.moonDegree, planets: partnerChart.planets || {} }
    );
    const partnerSun = signByName(partnerChart.sunSign);

    /**
     * Kota kontrolü + AI üretimi + kayıt AYNI KULLANICI KİLİDİ altında.
     *
     * Premium bile sınırsız değil (madde 23) — her istek bir AI çağrısı demek.
     * Kilit olmadan, kota kontrolü ile kaydın yazılması arasındaki boşluğa
     * paralel istekler girip günlük tavanı aşabilirdi (aynı sınıf hata,
     * readings.ts ve chat.ts'te de düzeltildi — bkz. lib/lock.ts).
     */
    let outcome:
      | { status: "ok"; check: unknown }
      | { status: "quota_exceeded"; quota: any }
      | { status: "unsafe" };
    try {
      outcome = await withUserLock(userId, async (tx) => {
        const quota = await checkCompatibilityQuota(userId, tx);
        if (!quota.allowed) {
          return { status: "quota_exceeded" as const, quota };
        }

        const aiSummary = await generateFreeTextReply(
          compatibilityPrompt(ctx, { name: partnerName, sunSign: partnerSun.tr })
        );

        const outputCheck = checkAiOutput(aiSummary);
        if (!outputCheck.safe) {
          req.log.warn({ reason: outputCheck.reason }, "Uyum yorumu güvenlik kontrolünden geçemedi");
          return { status: "unsafe" as const };
        }

        const check = await tx.compatibilityCheck.create({
          data: {
            userId,
            partnerName,
            // Partnerin doğum bilgisi saklanır; kullanıcı hesabını silerse cascade ile gider
            partnerBirthData: {
              birthDate: partnerBirthDate,
              birthTime: partnerBirthTime ?? null,
              sunSign: partnerChart.sunSign,
              moonSign: partnerChart.moonSign,
            },
            scores,
            aiSummary,
          },
        });

        return { status: "ok" as const, check };
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: "Uyum analizi şu anda oluşturulamadı. Lütfen tekrar dene." });
    }

    if (outcome.status === "quota_exceeded") {
      const { quota } = outcome;
      return reply.code(402).send({
        error: "Bugünlük uyum analizi hakkın doldu. Yarın tekrar deneyebilirsin.",
        upgradeRequired: false,
        used: quota.used,
        limit: quota.limit,
      });
    }
    if (outcome.status === "unsafe") {
      return reply.code(503).send({ error: "Uyum analizi şu anda oluşturulamadı. Lütfen tekrar dene." });
    }

    return reply.code(201).send({
      check: outcome.check,
      partnerSunSign: partnerChart.sunSign,
      // Saat bilinmiyorsa hesabın sınırı kullanıcıya söylenmeli
      note: partnerBirthTime
        ? null
        : "Partnerin doğum saati bilinmediği için Ay konumu yaklaşık, yükselen hesaplanmadı.",
      disclaimer: "Bu sonuçlar bilimsel kesinlik taşımaz, eğlence ve kişisel içgörü amaçlıdır.",
    });
  });

  /** Geçmiş uyum analizleri. */
  app.get("/compatibility/history", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const checks = await prisma.compatibilityCheck.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return reply.send({ checks });
  });
}
