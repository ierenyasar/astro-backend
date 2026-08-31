import jwt from "jsonwebtoken";

/**
 * Apple App Store Server API ile abonelik doğrulama.
 * https://developer.apple.com/documentation/appstoreserverapi
 *
 * Gerekli env değişkenleri:
 *   APPLE_ISSUER_ID       — App Store Connect > Integrations > In-App Purchase (Issuer ID)
 *   APPLE_KEY_ID           — aynı sayfadaki private key'in Key ID'si
 *   APPLE_PRIVATE_KEY       — .p8 dosyasının içeriği (satır sonları \n olarak escape edilmiş)
 *   APPLE_BUNDLE_ID          — örn. com.example.astroapp
 *   APPLE_ENVIRONMENT         — "sandbox" | "production" (varsayılan: sandbox)
 */

const APPLE_HOSTS = {
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
  production: "https://api.storekit.itunes.apple.com",
};

export class VerificationError extends Error {}
export class VerificationConfigError extends Error {}

function appleConfig() {
  const { APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID } = process.env;
  if (!APPLE_ISSUER_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !APPLE_BUNDLE_ID) {
    throw new VerificationConfigError(
      "Apple doğrulaması yapılandırılmamış. APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY ve APPLE_BUNDLE_ID env değişkenlerini tanımla."
    );
  }
  const env = (process.env.APPLE_ENVIRONMENT || "sandbox") as keyof typeof APPLE_HOSTS;
  return {
    issuerId: APPLE_ISSUER_ID,
    keyId: APPLE_KEY_ID,
    privateKey: APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    bundleId: APPLE_BUNDLE_ID,
    host: APPLE_HOSTS[env] ?? APPLE_HOSTS.sandbox,
  };
}

/** App Store Server API çağrıları için kısa ömürlü ES256 JWT üretir. */
function appleAuthToken() {
  const cfg = appleConfig();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: cfg.issuerId,
      iat: now,
      exp: now + 15 * 60,
      aud: "appstoreconnect-v1",
      bid: cfg.bundleId,
    },
    cfg.privateKey,
    { algorithm: "ES256", keyid: cfg.keyId }
  );
}

/**
 * JWS (signed transaction) payload'ını decode eder.
 *
 * NOT: Burada payload sadece decode ediliyor; imza doğrulaması Apple'ın sunucusundan
 * gelen yanıta güvenildiği için atlanıyor (veriyi zaten Apple'ın kendi API'sinden
 * HTTPS üzerinden aldık). Eğer client'tan gelen bir JWS'i doğrudan doğrulayacaksan
 * Apple'ın x5c sertifika zincirini doğrulaman ZORUNLUDUR.
 */
function decodeJWSPayload(jws: string): any {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new VerificationError("Geçersiz JWS formatı.");
  return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
}

export interface VerifiedSubscription {
  valid: boolean;
  productId: string | null;
  transactionId: string | null;
  expiresAt: Date | null;
  isTrial: boolean;
  raw?: unknown;
}

/**
 * originalTransactionId ile aboneliğin GÜNCEL durumunu Apple'dan sorgular.
 * Client'ın gönderdiği hiçbir durum bilgisine güvenilmez — tek doğruluk kaynağı Apple'dır.
 */
export async function verifyAppleSubscription(originalTransactionId: string): Promise<VerifiedSubscription> {
  const cfg = appleConfig();
  const token = appleAuthToken();

  const res = await fetch(`${cfg.host}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    return { valid: false, productId: null, transactionId: null, expiresAt: null, isTrial: false };
  }
  if (!res.ok) {
    throw new VerificationError(`Apple doğrulama isteği başarısız (${res.status}).`);
  }

  const body = (await res.json()) as any;
  const item = body?.data?.[0]?.lastTransactions?.[0];
  if (!item?.signedTransactionInfo) {
    return { valid: false, productId: null, transactionId: null, expiresAt: null, isTrial: false };
  }

  const payload = decodeJWSPayload(item.signedTransactionInfo);
  const expiresAt = payload.expiresDate ? new Date(Number(payload.expiresDate)) : null;

  // status: 1 = active, 2 = expired, 3 = billing retry, 4 = grace period, 5 = revoked
  const active = item.status === 1 || item.status === 4;

  return {
    valid: active && (!expiresAt || expiresAt > new Date()),
    productId: payload.productId ?? null,
    transactionId: payload.originalTransactionId ?? originalTransactionId,
    expiresAt,
    isTrial: payload.offerType === 1,
    raw: { status: item.status },
  };
}
