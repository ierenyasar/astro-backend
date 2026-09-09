import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { generateVisionReading } from "../lib/gemini";
import { COFFEE_SYSTEM_PROMPT, coffeeFortunePrompt } from "../prompts";
import { checkAiOutput } from "../lib/safety";
import { checkCoffeeFortuneQuota } from "../lib/limits";
import { withUserLock } from "../lib/lock";

/**
 * Kabul edilen görsel türleri. Sadece bunlar — rastgele MIME type'lara izin
 * vermek hem gereksiz saldırı yüzeyi açar hem Anthropic'in vision API'sinin
 * desteklemediği bir formatı kabul edip anlamsız hataya yol açabilir.
 */
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

/**
 * Görsel BAŞINA base64 string uzunluğu sınırı. Base64 kodlaması ham veriyi
 * ~%33 büyütür, yani bu sınır kabaca ~1.8MB'lık bir görsele karşılık gelir —
 * mobil tarafta zaten sıkıştırılıp küçültülmüş bir fotoğraf için fazlasıyla
 * yeterli (bkz. services/coffeeFortune.js), aşırı büyük yüklemeleri engeller.
 */
const MAX_IMAGE_BASE64_LENGTH = 2_500_000;

/** Tek bir fal isteğinde kaç fotoğraf kabul edilir — geleneksel Türk kahve
 * falında fincanın farklı açılardan (bazen tabakla birlikte) incelenmesi
 * yaygındır, ama sınırsız fotoğraf hem gereksiz maliyet hem kötüye kullanım
 * riski taşır. */
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 4;

const coffeeFortuneSchema = z.object({
  images: z
    .array(
      z.object({
        image: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH, "Görsel çok büyük. Lütfen daha küçük bir fotoğraf dene."),
        mediaType: z.enum(ALLOWED_MEDIA_TYPES),
      })
    )
    .min(MIN_PHOTOS, `En az ${MIN_PHOTOS} fotoğraf gerekli.`)
    .max(MAX_PHOTOS, `En fazla ${MAX_PHOTOS} fotoğraf gönderebilirsin.`),
});

/** "data:image/jpeg;base64,...." önekini temizler — istemci bazen bunu dahil eder. */
function stripDataUrlPrefix(base64: string): string {
  const match = base64.match(/^data:image\/[a-z]+;base64,(.+)$/s);
  return match ? match[1] : base64;
}

interface CoffeeAiResponse {
  valid: boolean;
  reason?: string;
  symbols?: string;
  interpretation?: string;
  closing?: string;
}

export default async function coffeeRoutes(app: FastifyInstance) {
  app.post(
    "/readings/coffee-fortune",
    {
      preHandler: [requireAuth],
      // Global sınır (256KB) görsel yüklemesi için yetersiz — 4 fotoğrafa kadar
      // (her biri ~1.8MB) + JSON overhead'i karşılayacak şekilde büyütülür.
      bodyLimit: 11_000_000,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { userId } = req.user as AuthPayload;

      const parsed = coffeeFortuneSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }

      /**
       * Kahve falı hem free hem premium'da AÇIK (free: 1/gün, premium: 5/gün).
       * Erişim kontrolü tamamen KOTA üzerinden yapılır — ayrı bir "enabled"
       * kontrolü ölü kod olurdu (her iki katmanda da true).
       */

      const images = parsed.data.images.map((img) => ({
        base64: stripDataUrlPrefix(img.image),
        mediaType: img.mediaType as MediaType,
      }));

      const profile = await prisma.profile.findUnique({ where: { userId } });

      /**
       * Kota kontrolü + AI üretimi + kayıt AYNI KULLANICI KİLİDİ altında
       * (bkz. lib/lock.ts — readings.ts/compatibility.ts'teki aynı desen).
       *
       * ÖNEMLİ: Geçersiz bir fotoğraf (fincan değil, bulanık vs.) BİLE kotadan
       * düşer — çünkü AI çağrısı zaten yapılmış ve gerçek bir maliyeti olmuştur.
       * Kotayı sadece "başarılı" fallara ayırmak, sınırsız geçersiz deneme
       * göndererek maliyeti atlatmanın bir yolu olurdu.
       */
      let outcome:
        | { status: "ok"; fortune: unknown; aiResult: CoffeeAiResponse }
        | { status: "quota_exceeded"; quota: any }
        | { status: "unsafe" };

      try {
        outcome = await withUserLock(userId, async (tx) => {
          const quota = await checkCoffeeFortuneQuota(userId, tx);
          if (!quota.allowed) {
            return { status: "quota_exceeded" as const, quota };
          }

          const raw = await generateVisionReading(
            COFFEE_SYSTEM_PROMPT,
            coffeeFortunePrompt(profile?.firstName, images.length),
            images
          );

          let aiResult: CoffeeAiResponse;
          try {
            const cleaned = raw.replace(/```json|```/g, "").trim();
            aiResult = JSON.parse(cleaned);
          } catch {
            // Model JSON dışı bir şey döndürdü — güvenli tarafta kal, geçersiz say
            aiResult = { valid: false, reason: "Fal şu anda okunamadı, lütfen tekrar dene." };
          }

          // Geçerli bir yorumsa güvenlik filtresinden geçir (madde 9, 42)
          if (aiResult.valid) {
            const combined = [aiResult.symbols, aiResult.interpretation, aiResult.closing]
              .filter(Boolean)
              .join(" ");
            const check = checkAiOutput(combined);
            if (!check.safe) {
              req.log.warn({ reason: check.reason }, "Kahve falı güvenlik kontrolünden geçemedi");
              return { status: "unsafe" as const };
            }
          }

          // Görsel HİÇBİR ZAMAN saklanmaz — sadece üretilen yorum metni (bkz. schema.prisma notu)
          const fortune = await tx.coffeeFortune.create({
            data: { userId, interpretation: aiResult as any },
          });

          return { status: "ok" as const, fortune, aiResult };
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({ error: "Fal şu anda okunamadı. Lütfen tekrar dene." });
      }

      if (outcome.status === "quota_exceeded") {
        const { quota } = outcome;
        /**
         * FREE kullanıcı limitine takıldıysa yükseltme öneriyoruz — premium'da
         * günde 5 hakkı olacak, "yarın gel" demek hem yanıltıcı olurdu hem de
         * net bir dönüşüm kaybı. PREMIUM kullanıcı takıldıysa yükseltecek bir
         * şey yok, gerçekten yarını beklemesi gerekiyor.
         */
        return reply.code(402).send({
          error: quota.premium
            ? "Bugünlük kahve falı hakkın doldu. Yarın tekrar deneyebilirsin."
            : "Bugünlük ücretsiz kahve falı hakkın doldu. Premium ile günde 5 fal baktırabilirsin.",
          upgradeRequired: !quota.premium,
          used: quota.used,
          limit: quota.limit,
        });
      }
      if (outcome.status === "unsafe") {
        return reply.code(503).send({ error: "Fal şu anda okunamadı. Lütfen tekrar dene." });
      }

      const { fortune, aiResult } = outcome;
      if (!aiResult.valid) {
        // Fincan tanınamadı — kullanıcıya nazikçe tekrar dene mesajı
        return reply.code(200).send({
          valid: false,
          reason: aiResult.reason || "Fincanın içini net göremedim, tekrar çeker misin?",
        });
      }

      return reply.code(201).send({
        valid: true,
        id: (fortune as any).id,
        symbols: aiResult.symbols,
        interpretation: aiResult.interpretation,
        closing: aiResult.closing,
        disclaimer: "Bu yorum eğlence amaçlıdır, kesin bir öngörü değildir.",
      });
    }
  );

  /** Geçmiş kahve falları. */
  app.get("/readings/coffee-fortune/history", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const fortunes = await prisma.coffeeFortune.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    // Geçersiz (fincan tanınmayan) denemeleri geçmişte gösterme — kullanıcı için gürültü
    const valid = fortunes.filter((f: { interpretation: unknown }) => (f.interpretation as any)?.valid);
    return reply.send({ fortunes: valid });
  });
}
