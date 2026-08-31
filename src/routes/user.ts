import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";

/**
 * Uzunluk sınırları bilinçlidir: firstName her AI prompt'una (readings/chat/compatibility)
 * doğrudan gömülür (bkz. buildContext). Sınırsız bırakılırsa kullanıcı devasa bir isim
 * göndererek her sonraki AI çağrısını şişirip gereksiz token maliyeti oluşturabilirdi.
 */
const profileSchema = z.object({
  firstName: z.string().min(1).max(50, "İsim en fazla 50 karakter olabilir"),
  gender: z.string().max(30).optional(),
  relationshipStatus: z.string().max(30).optional(),
  focusArea: z.string().max(30).optional(),
});

export default async function userRoutes(app: FastifyInstance) {
  app.get("/user/profile", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const profile = await prisma.profile.findUnique({ where: { userId } });
    const birthData = await prisma.birthData.findUnique({ where: { userId }, include: { chart: true } });
    return reply.send({ profile, birthData });
  });

  app.put("/user/profile", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const profile = await prisma.profile.upsert({
      where: { userId },
      update: parsed.data,
      create: { userId, ...parsed.data },
    });

    return reply.send({ profile });
  });

  /**
   * Kullanıcının tüm verilerini dışa aktarır (KVKK / GDPR veri taşınabilirliği, madde 41).
   * Şifre hash'i gibi hassas alanlar DIŞARIDA bırakılır.
   */
  app.get("/user/export", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;

    const [user, profile, birthData, readings, sessions, favorites, subscriptions, compat] =
      await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, createdAt: true } }),
        prisma.profile.findUnique({ where: { userId } }),
        prisma.birthData.findUnique({ where: { userId }, include: { chart: true } }),
        prisma.reading.findMany({ where: { userId }, orderBy: { readingDate: "desc" } }),
        prisma.chatSession.findMany({ where: { userId }, include: { messages: true } }),
        prisma.favorite.findMany({ where: { userId } }),
        prisma.subscription.findMany({ where: { userId } }),
        prisma.compatibilityCheck.findMany({ where: { userId } }),
      ]);

    if (!user) {
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    return reply.send({
      exportedAt: new Date().toISOString(),
      user,
      profile,
      birthData,
      readings,
      chatSessions: sessions,
      favorites,
      subscriptions,
      compatibilityChecks: compat,
    });
  });

  // Hesap ve tüm ilişkili verileri kalıcı olarak siler (madde 41 — kullanıcı hesabını tamamen silebilmeli)
  app.delete("/user/account", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    // İlişkili kayıtlar Prisma schema'daki onDelete: Cascade ile silinir.
    // Push token'ları da cascade ile gider — aksi halde silinen hesaba bildirim gitmeye devam ederdi.
    await prisma.user.delete({ where: { id: userId } });
    req.log.info({ userId }, "Hesap ve tüm verileri silindi");
    return reply.send({ deleted: true });
  });
}
