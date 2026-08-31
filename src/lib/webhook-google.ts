import { OAuth2Client } from "google-auth-library";

/**
 * Google Play Real-time Developer Notifications (RTDN) doğrulaması.
 * https://developer.android.com/google/play/billing/rtdn-reference
 *
 * Google, bildirimleri Pub/Sub üzerinden push subscription olarak gönderir.
 * Pub/Sub push isteği `Authorization: Bearer <OIDC token>` header'ı taşır;
 * bu token'ın Google tarafından imzalandığı ve beklenen service account'a
 * ait olduğu doğrulanmalıdır.
 *
 * Gerekli env:
 *   GOOGLE_PUBSUB_SERVICE_ACCOUNT — Pub/Sub push subscription'daki service account e-postası
 *   GOOGLE_PUBSUB_AUDIENCE          — push endpoint URL'i (audience olarak yapılandırıldıysa)
 */

export class WebhookVerificationError extends Error {}

const oauthClient = new OAuth2Client();

export interface GoogleNotification {
  notificationType: number | null;
  purchaseToken: string | null;
  subscriptionId: string | null;
  raw: any;
}

/** Pub/Sub push isteğinin gerçekten Google'dan geldiğini doğrular. */
export async function verifyGooglePushAuth(authorizationHeader?: string) {
  const expectedAccount = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
  if (!expectedAccount) {
    throw new WebhookVerificationError(
      "GOOGLE_PUBSUB_SERVICE_ACCOUNT tanımlı değil. Doğrulanmamış bildirim işlenmez."
    );
  }
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new WebhookVerificationError("Authorization header eksik.");
  }
  const token = authorizationHeader.slice(7);

  let payload: any;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_PUBSUB_AUDIENCE || undefined,
    });
    payload = ticket.getPayload();
  } catch (err: any) {
    throw new WebhookVerificationError(`OIDC token doğrulanamadı: ${err?.message}`);
  }

  if (payload?.email !== expectedAccount || payload?.email_verified !== true) {
    throw new WebhookVerificationError("Bildirim beklenen service account'tan gelmiyor.");
  }
}

/** Pub/Sub mesaj gövdesinden Play bildirimini çıkarır. */
export function parseGoogleNotification(body: any): GoogleNotification {
  const data = body?.message?.data;
  if (!data) {
    throw new WebhookVerificationError("Pub/Sub mesajında data alanı yok.");
  }
  const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  const sub = decoded?.subscriptionNotification;

  return {
    notificationType: sub?.notificationType ?? null,
    purchaseToken: sub?.purchaseToken ?? null,
    subscriptionId: sub?.subscriptionId ?? null,
    raw: decoded,
  };
}

/**
 * Google bildirim tipini bizim abonelik durumumuza çevirir.
 * https://developer.android.com/google/play/billing/rtdn-reference#sub
 */
export function googleNotificationToStatus(
  type: number | null
): "active" | "trial" | "expired" | "cancelled" | null {
  switch (type) {
    case 1: // SUBSCRIPTION_RECOVERED
    case 2: // SUBSCRIPTION_RENEWED
    case 4: // SUBSCRIPTION_PURCHASED
    case 7: // SUBSCRIPTION_RESTARTED
      return "active";
    case 6: // SUBSCRIPTION_IN_GRACE_PERIOD — erişim sürer
      return "active";
    case 13: // SUBSCRIPTION_EXPIRED
      return "expired";
    case 12: // SUBSCRIPTION_REVOKED
      return "cancelled";
    case 3: // SUBSCRIPTION_CANCELED — dönem sonuna kadar erişim sürer,
      return null; // currentPeriodEnd zaten sınırlıyor
    default:
      return null;
  }
}
