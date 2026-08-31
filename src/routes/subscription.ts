import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import {
  verifyAppleSubscription,
  VerificationError,
  VerificationConfigError,
  VerifiedSubscription,
} from "../lib/verify-apple";
import { verifyGoogleSubscription } from "../lib/verify-google";
import { verifyAppleNotification, appleNotificationToStatus } from "../lib/webhook-apple";
import { verifyGooglePushAuth, parseGoogleNotification, googleNotificationToStatus } from "../lib/webhook-google";

/**
 * purchaseToken uzunluğu sınırlıdır: bu değer Apple/Google'ın API'sine URL parçası
 * olarak gönderilir (bkz. verify-apple.ts, verify-google.ts) ve DB'ye
 * providerTransactionId olarak yazılır. Gerçek token'lar birkaç yüz karakteri
 * geçmez; sınırsız bırakılırsa hem dış API isteğini bozabilir hem DB'yi şişirebilir.
 */
const verifySchema = z.object({
  provider: z.enum(["apple", "google"]),
  // Apple: originalTransactionId, Google: purchaseToken
  purchaseToken: z.string().min(1).max(1000, "Geçersiz satın alma token'ı"),
});

export default async function subscriptionRoutes(app: FastifyInstance) {
  app.get("/subscription", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const subscription = await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const active =
      !!subscription &&
      ["trial", "active"].includes(subscription.status) &&
      (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > new Date());

    return reply.send({ subscription, isPremium: active });
  });

  /**
   * Satın alma doğrulama.
   *
   * GÜVENLİK: Abonelik durumu SADECE Apple/Google'ın sunucusundan gelen yanıta göre
   * belirlenir. Client'ın "premium: true" gibi bir iddiası hiçbir şekilde dikkate alınmaz.
   * Ayrıca aynı purchaseToken başka bir kullanıcıya bağlanmışsa reddedilir (hesap paylaşımı
   * ile premium çoğaltmayı engeller).
   */
  app.post("/subscription/verify", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { provider, purchaseToken } = parsed.data;

    let result: VerifiedSubscription;
    try {
      result =
        provider === "apple"
          ? await verifyAppleSubscription(purchaseToken)
          : await verifyGoogleSubscription(purchaseToken);
    } catch (err) {
      if (err instanceof VerificationConfigError) {
        req.log.error({ err }, "Satın alma doğrulaması yapılandırılmamış");
        return reply.code(503).send({ error: "Satın alma doğrulaması şu anda kullanılamıyor." });
      }
      if (err instanceof VerificationError) {
        req.log.warn({ err }, "Satın alma doğrulaması başarısız");
        return reply.code(502).send({ error: "Satın alman doğrulanamadı. Lütfen tekrar dene." });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "Beklenmeyen bir hata oluştu." });
    }

    if (!result.valid) {
      return reply.code(402).send({ error: "Aktif bir abonelik bulunamadı.", isPremium: false });
    }

    const transactionId = result.transactionId ?? purchaseToken;

    // Aynı satın alma başka bir hesaba bağlıysa reddet
    const owned = await prisma.subscription.findFirst({
      where: { providerTransactionId: transactionId, NOT: { userId } },
    });
    if (owned) {
      return reply.code(409).send({ error: "Bu satın alma başka bir hesaba bağlı." });
    }

    const status = result.isTrial ? "trial" : "active";

    const existing = await prisma.subscription.findFirst({
      where: { userId, providerTransactionId: transactionId },
    });

    const subscription = existing
      ? await prisma.subscription.update({
          where: { id: existing.id },
          data: { status, currentPeriodEnd: result.expiresAt },
        })
      : await prisma.subscription.create({
          data: {
            userId,
            provider,
            status,
            providerTransactionId: transactionId,
            currentPeriodEnd: result.expiresAt,
          },
        });

    return reply.send({ subscription, isPremium: true });
  });

  /**
   * Apple App Store Server Notifications V2.
   *
   * İmza (x5c sertifika zinciri + JWS) doğrulanmadan HİÇBİR abonelik durumu güncellenmez.
   * Bu endpoint auth gerektirmez — kimlik doğrulaması imzanın kendisidir.
   */
  /**
   * İmza doğrulaması (X.509 sertifika zinciri + ES256) CPU-yoğun bir işlemdir ve
   * GEÇERSİZLİĞİ TESPİT ETMEK İÇİN BİLE çalıştırılması gerekir — yani "önce
   * doğrula sonra reddet" akışı kimlik doğrulaması gibi ucuza savuşturulamaz.
   * Dedike limit olmadan, saldırgan rastgele gövdelerle spam atarak sunucuyu
   * sürekli sertifika ayrıştırma/imza doğrulama yaptırıp CPU tüketebilirdi.
   * Gerçek Apple trafiği çok düşük hacimlidir; 60/dk cömert ama sınırlı.
   */
  app.post("/subscription/webhook/apple", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { signedPayload } = (req.body ?? {}) as { signedPayload?: string };
    if (!signedPayload) {
      return reply.code(400).send({ error: "signedPayload eksik." });
    }

    let notification;
    try {
      notification = verifyAppleNotification(signedPayload);
    } catch (err) {
      req.log.warn({ err }, "Apple bildirimi doğrulanamadı — yok sayıldı");
      // 200 dönmüyoruz: Apple tekrar denesin, ama durum da güncellenmiyor
      return reply.code(401).send({ error: "Bildirim doğrulanamadı." });
    }

    const status = appleNotificationToStatus(notification.notificationType, notification.subtype);
    await applyNotification({
      transactionId: notification.originalTransactionId,
      status,
      expiresAt: notification.expiresDate,
      log: req.log,
      source: `apple:${notification.notificationType}`,
    });

    return reply.code(200).send({ received: true });
  });

  /**
   * Google Play Real-time Developer Notifications (Pub/Sub push).
   *
   * Pub/Sub'ın OIDC token'ı doğrulanır; beklenen service account'tan gelmeyen
   * istekler reddedilir. Bildirimdeki purchaseToken ile abonelik durumu güncellenir.
   */
  /** Aynı risk: OIDC token doğrulaması CPU/ağ maliyetlidir (bkz. yukarıdaki not). */
  app.post("/subscription/webhook/google", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    try {
      await verifyGooglePushAuth(req.headers.authorization);
    } catch (err) {
      req.log.warn({ err }, "Google bildirimi doğrulanamadı — yok sayıldı");
      return reply.code(401).send({ error: "Bildirim doğrulanamadı." });
    }

    let notification;
    try {
      notification = parseGoogleNotification(req.body);
    } catch (err) {
      req.log.warn({ err }, "Google bildirimi çözümlenemedi");
      // Pub/Sub sonsuz retry yapmasın diye 200 dönüyoruz — mesaj bozuk, tekrar denemek çözmez
      return reply.code(200).send({ received: true, ignored: true });
    }

    const status = googleNotificationToStatus(notification.notificationType);
    await applyNotification({
      transactionId: notification.purchaseToken,
      status,
      expiresAt: null, // Google bildirimde expiry taşımaz; bir sonraki verify'da güncellenir
      log: req.log,
      source: `google:${notification.notificationType}`,
    });

    return reply.code(200).send({ received: true });
  });

  /** Doğrulanmış bir bildirimi ilgili aboneliğe uygular. */
  async function applyNotification(params: {
    transactionId: string | null;
    status: "active" | "trial" | "expired" | "cancelled" | null;
    expiresAt: Date | null;
    log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
    source: string;
  }) {
    const { transactionId, status, expiresAt, log, source } = params;

    if (!transactionId) {
      log.warn({ source }, "Bildirimde transactionId yok — atlandı");
      return;
    }
    if (!status) {
      log.info({ source }, "Bu bildirim tipi durum değişikliği gerektirmiyor");
      return;
    }

    const subscription = await prisma.subscription.findFirst({
      where: { providerTransactionId: transactionId },
    });
    if (!subscription) {
      // Kullanıcı henüz /subscription/verify çağırmamış olabilir; bu normal.
      log.info({ source }, "Bildirime karşılık gelen abonelik kaydı bulunamadı");
      return;
    }

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status, ...(expiresAt ? { currentPeriodEnd: expiresAt } : {}) },
    });
    log.info({ source, status }, "Abonelik durumu bildirimle güncellendi");
  }
}
