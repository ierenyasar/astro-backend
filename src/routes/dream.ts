import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { generateFreeTextReply } from "../lib/gemini";
import { DREAM_SYSTEM_PROMPT, dreamAnalysisPrompt } from "../prompts";
import { checkAiOutput, checkUserMessage } from "../lib/safety";
import { checkDreamAnalysisQuota } from "../lib/limits";
import { withUserLock } from "../lib/lock";

/**
 * Rüya metni uzunluk sınırı — chat mesajıyla aynı (2000 karakter). Hem AI prompt'una
 * gömülen bir alan olduğu için sınırsız bırakılırsa maliyet riski taşır (bkz.
 * input-bounds.test.ts'teki genel prensip), hem de anlamlı bir rüya anlatısı
 * için fazlasıyla yeterli.
 */
const DREAM_TEXT_MAX_LENGTH = 2000;
const DREAM_TEXT_MIN_LENGTH = 10;

const dreamSchema = z.object({
  dreamText: z
    .string()
    .max(DREAM_TEXT_MAX_LENGTH * 2, "Rüya anlatımı çok uzun. Lütfen kısalt.")
    /**
     * Temizleme ADIMI, uzunluk kontrolünden ÖNCE gelir:
     *
     * 1. Null byte ve kontrol karakterleri kaldırılır — PostgreSQL'in `text` tipi
     *    null byte (\u0000) kabul etmez. Temizlenmezse AI çağrısı yapılıp para
     *    harcandıktan SONRA veritabanı yazımında 500 hatası alınırdı.
     * 2. trim() — "          " gibi sadece boşluktan oluşan bir girdi ham hâlde
     *    min(10) kontrolünü geçip kotayı boşa harcardı.
     */
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .refine((v) => v.length >= DREAM_TEXT_MIN_LENGTH, {
      message: "Rüyanı biraz daha detaylı anlatır mısın?",
    })
    .refine((v) => v.length <= DREAM_TEXT_MAX_LENGTH, {
      message: "Rüya anlatımı çok uzun. Lütfen kısalt.",
    }),
});

interface DreamAiResponse {
  symbols?: string;
  interpretation?: string;
  reflection?: string;
}

export default async function dreamRoutes(app: FastifyInstance) {
  app.post(
    "/readings/dream-analysis",
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { userId } = req.user as AuthPayload;

      const parsed = dreamSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }
      const { dreamText } = parsed.data;

      /**
       * Girdi güvenlik kontrolü ÖNCE gelir (aynı chat.ts'teki desen). Kullanıcı
       * rüya anlatımında kriz/kendine zarar verme sinyali veriyorsa AI'ya hiç
       * gidilmez, kotadan düşülmez — destekleyici bir yanıt döner.
       */
      const safety = checkUserMessage(dreamText);
      if (safety.blocked) {
        req.log.warn({ category: safety.category }, "Rüya analizinde güvenlik filtresi devreye girdi");
        return reply.send({
          symbols: null,
          interpretation: safety.response,
          reflection: null,
          safetyIntervention: safety.category,
        });
      }

      /**
       * Rüya analizi hem free hem premium'da AÇIK (free: 1/gün, premium: 10/gün).
       * Erişim kontrolü tamamen KOTA üzerinden — ayrı bir "enabled" kontrolü
       * ölü kod olurdu (her iki katmanda da true).
       */

      const profile = await prisma.profile.findUnique({ where: { userId } });

      let outcome:
        | { status: "ok"; dream: unknown; aiResult: DreamAiResponse }
        | { status: "quota_exceeded"; quota: any }
        | { status: "unsafe" };

      try {
        outcome = await withUserLock(userId, async (tx) => {
          const quota = await checkDreamAnalysisQuota(userId, tx);
          if (!quota.allowed) {
            return { status: "quota_exceeded" as const, quota };
          }

          const raw = await generateFreeTextReply(
            dreamAnalysisPrompt(dreamText, profile?.firstName),
            [],
            DREAM_SYSTEM_PROMPT
          );

          let aiResult: DreamAiResponse;
          try {
            const cleaned = raw.replace(/```json|```/g, "").trim();
            aiResult = JSON.parse(cleaned);
          } catch {
            aiResult = { interpretation: raw };
          }

          const combined = [aiResult.symbols, aiResult.interpretation, aiResult.reflection]
            .filter(Boolean)
            .join(" ");
          const check = checkAiOutput(combined);
          if (!check.safe) {
            req.log.warn({ reason: check.reason }, "Rüya analizi güvenlik kontrolünden geçemedi");
            return { status: "unsafe" as const };
          }

          const dream = await tx.dreamAnalysis.create({
            data: { userId, dreamText, interpretation: aiResult as any },
          });

          return { status: "ok" as const, dream, aiResult };
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({ error: "Rüyan şu anda yorumlanamadı. Lütfen tekrar dene." });
      }

      if (outcome.status === "quota_exceeded") {
        const { quota } = outcome;
        // Free kullanıcıya yükseltme öner (premium'da 10 hak), premium'a yarını işaret et
        return reply.code(402).send({
          error: quota.premium
            ? "Bugünlük rüya analizi hakkın doldu. Yarın tekrar deneyebilirsin."
            : "Bugünlük ücretsiz rüya analizi hakkın doldu. Premium ile günde 10 rüya yorumlatabilirsin.",
          upgradeRequired: !quota.premium,
          used: quota.used,
          limit: quota.limit,
        });
      }
      if (outcome.status === "unsafe") {
        return reply.code(503).send({ error: "Rüyan şu anda yorumlanamadı. Lütfen tekrar dene." });
      }

      const { dream, aiResult } = outcome;
      return reply.code(201).send({
        id: (dream as any).id,
        symbols: aiResult.symbols,
        interpretation: aiResult.interpretation,
        reflection: aiResult.reflection,
        disclaimer: "Bu yorum kişisel bir bakış açısıdır, kesin bir öngörü değildir.",
      });
    }
  );

  /** Geçmiş rüya analizleri. */
  app.get("/readings/dream-analysis/history", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const dreams = await prisma.dreamAnalysis.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return reply.send({ dreams });
  });
}
