import crypto from "crypto";

/**
 * Apple App Store Server Notifications V2 imza doğrulaması.
 * https://developer.apple.com/documentation/appstoreservernotifications
 *
 * Apple, bildirimi `signedPayload` adlı bir JWS olarak POST eder. Bu JWS'in header'ında
 * `x5c` alanında bir sertifika zinciri bulunur. Doğrulama adımları:
 *   1) x5c zincirini parse et
 *   2) Zincirin kökünün Apple Root CA olduğunu doğrula
 *   3) Zincirdeki her sertifikanın bir üstü tarafından imzalandığını doğrula
 *   4) Leaf sertifikanın public key'i ile JWS imzasını doğrula
 *
 * İmza doğrulanmadan HİÇBİR abonelik durumu güncellenmez.
 */

export class WebhookVerificationError extends Error {}

/**
 * Apple Root CA - G3 sertifikası (PEM).
 * https://www.apple.com/certificateauthority/ adresinden indirilir.
 * Env ile override edilebilir: APPLE_ROOT_CA_PEM
 */
function appleRootCA(): string | null {
  return process.env.APPLE_ROOT_CA_PEM?.replace(/\\n/g, "\n") ?? null;
}

function b64urlToBuffer(input: string) {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function derToPem(der: Buffer) {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  originalTransactionId: string | null;
  expiresDate: Date | null;
  productId: string | null;
  raw: any;
}

/**
 * signedPayload'ı doğrular ve içindeki bildirim verisini döndürür.
 * Doğrulama başarısızsa WebhookVerificationError fırlatır.
 */
export function verifyAppleNotification(signedPayload: string): AppleNotification {
  const parts = signedPayload.split(".");
  if (parts.length !== 3) {
    throw new WebhookVerificationError("Geçersiz JWS formatı.");
  }

  const header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8"));
  const x5c: string[] = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new WebhookVerificationError("Sertifika zinciri (x5c) eksik.");
  }

  const certs = x5c.map((c) => new crypto.X509Certificate(derToPem(Buffer.from(c, "base64"))));

  // 1) Zincirin her halkası bir üstü tarafından imzalanmış olmalı
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new WebhookVerificationError(`Sertifika zinciri kırık (${i}).`);
    }
  }

  // 2) Zincirin kökü Apple Root CA olmalı
  const rootPem = appleRootCA();
  if (!rootPem) {
    throw new WebhookVerificationError(
      "APPLE_ROOT_CA_PEM tanımlı değil. Apple Root CA olmadan bildirim doğrulanamaz."
    );
  }
  const root = new crypto.X509Certificate(rootPem);
  const chainRoot = certs[certs.length - 1];
  if (chainRoot.fingerprint256 !== root.fingerprint256 && !chainRoot.verify(root.publicKey)) {
    throw new WebhookVerificationError("Sertifika zinciri Apple Root CA'ya bağlanmıyor.");
  }

  // 3) Sertifikaların geçerlilik tarihleri
  const now = Date.now();
  for (const cert of certs) {
    if (new Date(cert.validTo).getTime() < now || new Date(cert.validFrom).getTime() > now) {
      throw new WebhookVerificationError("Zincirde süresi geçmiş sertifika var.");
    }
  }

  // 4) Leaf sertifikanın public key'i ile JWS imzasını doğrula (ES256)
  const leaf = certs[0];
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = b64urlToBuffer(parts[2]);

  const verified = crypto.verify(
    "sha256",
    signingInput,
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  if (!verified) {
    throw new WebhookVerificationError("JWS imzası doğrulanamadı.");
  }

  // İmza doğrulandı — payload'ı çöz
  const payload = JSON.parse(b64urlToBuffer(parts[1]).toString("utf8"));
  const txInfo = payload?.data?.signedTransactionInfo
    ? JSON.parse(b64urlToBuffer(payload.data.signedTransactionInfo.split(".")[1]).toString("utf8"))
    : null;

  return {
    notificationType: payload.notificationType,
    subtype: payload.subtype,
    originalTransactionId: txInfo?.originalTransactionId ?? null,
    expiresDate: txInfo?.expiresDate ? new Date(Number(txInfo.expiresDate)) : null,
    productId: txInfo?.productId ?? null,
    raw: payload,
  };
}

/**
 * Apple bildirim tipini bizim abonelik durumumuza çevirir.
 * https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 */
export function appleNotificationToStatus(
  notificationType: string,
  subtype?: string
): "active" | "trial" | "expired" | "cancelled" | null {
  switch (notificationType) {
    case "SUBSCRIBED":
      return subtype === "INITIAL_BUY" ? "trial" : "active";
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      return "active";
    case "DID_CHANGE_RENEWAL_STATUS":
      // AUTO_RENEW_DISABLED: kullanıcı iptal etti ama dönem sonuna kadar erişimi sürer.
      // Durumu "cancelled" yapmıyoruz; currentPeriodEnd zaten erişimi sınırlıyor.
      return null;
    case "EXPIRED":
      return "expired";
    case "REVOKE":
      return "cancelled";
    case "DID_FAIL_TO_RENEW":
      // GRACE_PERIOD alt tipinde erişim devam eder
      return subtype === "GRACE_PERIOD" ? "active" : "expired";
    default:
      return null;
  }
}
