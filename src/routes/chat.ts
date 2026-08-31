import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { generateFreeTextReply, summarizeConversation } from "../lib/anthropic";
import { checkChatQuota } from "../lib/limits";
import { chatPrompt } from "../prompts";
import { checkUserMessage, checkAiOutput, countCliches } from "../lib/safety";
import { buildContext } from "./readings";
import { withUserLock } from "../lib/lock";

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  chatSessionId: z.string().uuid().optional(),
});

const MAX_RECENT_MESSAGES = 10;   // AI'ya gönderilecek son mesaj sayısı (madde 38)
const SUMMARIZE_THRESHOLD = 24;   // bu sayıyı aşınca eski mesajlar özetlenir

export default async function chatRoutes(app: FastifyInstance) {
  app.post("/ai/chat", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { message, chatSessionId } = parsed.data;

    /**
     * Güvenlik kontrolü her şeyden ÖNCE gelir.
     *
     * Kriz veya sağlık içerikli bir mesajda:
     *  - AI'ya hiç gidilmez (astroloji cevabı vermek zararlı olurdu)
     *  - Kotadan düşülmez (kullanıcı destek istediği için cezalandırılmamalı)
     *  - Mesaj yine de kaydedilir ki sohbet akışı kopmasın
     */
    const safety = checkUserMessage(message);
    if (safety.blocked) {
      let session = chatSessionId
        ? await prisma.chatSession.findFirst({ where: { id: chatSessionId, userId } })
        : null;
      if (!session) {
        session = await prisma.chatSession.create({ data: { userId } });
      }

      await prisma.chatMessage.createMany({
        data: [
          { chatSessionId: session.id, role: "user", content: message },
          { chatSessionId: session.id, role: "assistant", content: safety.response! },
        ],
      });

      req.log.warn({ category: safety.category }, "Güvenlik filtresi devreye girdi");
      return reply.send({
        chatSessionId: session.id,
        reply: safety.response,
        safetyIntervention: safety.category,
      });
    }

    const ctx = await buildContext(userId);
    if (!ctx) {
      return reply.code(400).send({ error: "Önce doğum haritası oluşturulmalı (POST /astrology/chart)." });
    }

    /**
     * Kota kontrolü + kullanıcı mesajının kaydı AYNI KİLİT altında.
     *
     * Neden: sayım ile kayıt arasındaki boşluğa paralel bir istek girerse, ikisi
     * de "henüz limite ulaşmadın" görüp mesaj gönderebilirdi. AI çağrısı burada
     * DEĞİL — sadece hızlı sayım+ekleme işlemi kilit altında, bağlantı uzun süre
     * meşgul edilmiyor (readings.ts'teki ödünleşimin aksine, bkz. oradaki not).
     */
    const lockOutcome = await withUserLock(userId, async (tx) => {
      const quota = await checkChatQuota(userId, tx);
      if (!quota.allowed) {
        return { status: "quota_exceeded" as const, quota };
      }

      let session = chatSessionId
        ? await tx.chatSession.findFirst({ where: { id: chatSessionId, userId } })
        : null;
      if (!session) {
        session = await tx.chatSession.create({ data: { userId } });
      }

      await tx.chatMessage.create({
        data: { chatSessionId: session.id, role: "user", content: message },
      });

      return { status: "ok" as const, session };
    });

    if (lockOutcome.status === "quota_exceeded") {
      const { quota } = lockOutcome;
      return reply.code(402).send({
        error: quota.premium
          ? "Günlük mesaj limitine ulaşıldı."
          : "Bugünlük yıldızlara sorabileceklerin doldu.",
        upgradeRequired: !quota.premium,
        used: quota.used,
        limit: quota.limit,
      });
    }

    const session = lockOutcome.session;

    // Son N mesajı context olarak al (sonsuz history gönderilmez)
    const recent = await prisma.chatMessage.findMany({
      where: { chatSessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_MESSAGES,
    });
    const recentAsc = (recent as { role: "user" | "assistant"; content: string; id: string }[]).reverse();

    let replyText: string;
    try {
      // Prompt injection önlemi: kullanıcı metni system prompt'a değil, user prompt'una veri olarak gömülür
      replyText = await generateFreeTextReply(
        chatPrompt(ctx, message, session.summary),
        recentAsc.slice(0, -1).map((m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content }))
      );
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: "Yıldızlara şu an ulaşılamıyor. Lütfen tekrar dene." });
    }

    // Model yasak bir iddiada bulunduysa kullanıcıya gösterme
    const outputCheck = checkAiOutput(replyText);
    if (!outputCheck.safe) {
      req.log.warn({ reason: outputCheck.reason }, "AI çıktısı güvenlik kontrolünden geçemedi");
      replyText =
        "Bu konuda sana güvenle bir şey söyleyemiyorum. Başka bir soru sormak ister misin?";
    }

    const clicheCount = countCliches(replyText);
    if (clicheCount > 0) {
      // Engellemiyoruz, ölçüyoruz — kalite zamanla izlensin (madde 36)
      req.log.info({ clicheCount }, "AI yanıtında klişe kalıp tespit edildi");
    }

    await prisma.chatMessage.create({
      data: { chatSessionId: session.id, role: "assistant", content: replyText },
    });

    // Konuşma uzadıysa eski mesajları özetle ve session.summary'ye yaz (madde 38)
    const messageCount = await prisma.chatMessage.count({ where: { chatSessionId: session.id } });
    if (messageCount >= SUMMARIZE_THRESHOLD) {
      const older = await prisma.chatMessage.findMany({
        where: { chatSessionId: session.id },
        orderBy: { createdAt: "asc" },
        take: messageCount - MAX_RECENT_MESSAGES,
      });
      if (older.length) {
        try {
          const summary = await summarizeConversation(
            older.map((m: { role: string; content: string }) => `${m.role === "user" ? "Kullanıcı" : "Astrolog"}: ${m.content}`).join("\n"),
            session.summary
          );
          await prisma.$transaction([
            prisma.chatSession.update({ where: { id: session.id }, data: { summary } }),
            prisma.chatMessage.deleteMany({ where: { id: { in: older.map((m: { id: string }) => m.id) } } }),
          ]);
        } catch (err) {
          req.log.warn({ err }, "Konuşma özetlenemedi, mesajlar korundu");
        }
      }
    }

    // Güncel kota bilgisini istemciye bildir (UI'da "3/5 mesaj kaldı" gibi göstermek için)
    const freshQuota = await checkChatQuota(userId);
    return reply.send({
      chatSessionId: session.id,
      reply: replyText,
      quota: { used: freshQuota.used, limit: freshQuota.limit },
    });
  });

  app.get("/ai/chat/:sessionId/messages", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const { sessionId } = req.params as { sessionId: string };

    const session = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) {
      return reply.code(404).send({ error: "Sohbet bulunamadı." });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { chatSessionId: sessionId },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({ messages, summary: session.summary });
  });
}
