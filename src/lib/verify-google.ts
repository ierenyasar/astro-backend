import { GoogleAuth } from "google-auth-library";
import { VerificationError, VerificationConfigError, VerifiedSubscription } from "./verify-apple";

/**
 * Google Play Developer API ile abonelik doğrulama (purchases.subscriptionsv2).
 * https://developer.android.com/google/play/billing/getting-ready#verify
 *
 * Gerekli env değişkenleri:
 *   GOOGLE_SERVICE_ACCOUNT_JSON — service account key JSON'unun tamamı (tek satır string)
 *   GOOGLE_PACKAGE_NAME          — örn. com.example.astroapp
 *
 * Service account'a Play Console > Users and permissions üzerinden
 * "View financial data" ve "Manage orders and subscriptions" yetkisi verilmelidir.
 */

let auth: GoogleAuth | null = null;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !process.env.GOOGLE_PACKAGE_NAME) {
    throw new VerificationConfigError(
      "Google doğrulaması yapılandırılmamış. GOOGLE_SERVICE_ACCOUNT_JSON ve GOOGLE_PACKAGE_NAME env değişkenlerini tanımla."
    );
  }
  if (!auth) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new VerificationConfigError("GOOGLE_SERVICE_ACCOUNT_JSON geçerli bir JSON değil.");
    }
    auth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return auth;
}

/**
 * purchaseToken ile aboneliğin GÜNCEL durumunu Google'dan sorgular.
 * Client'ın gönderdiği durum bilgisine güvenilmez.
 */
export async function verifyGoogleSubscription(purchaseToken: string): Promise<VerifiedSubscription> {
  const packageName = process.env.GOOGLE_PACKAGE_NAME!;
  const client = await getAuth().getClient();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName
  )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  let body: any;
  try {
    const res = await client.request<any>({ url });
    body = res.data;
  } catch (err: any) {
    if (err?.response?.status === 404 || err?.response?.status === 410) {
      return { valid: false, productId: null, transactionId: null, expiresAt: null, isTrial: false };
    }
    throw new VerificationError(`Google doğrulama isteği başarısız: ${err?.message ?? "bilinmeyen hata"}`);
  }

  // subscriptionState: SUBSCRIPTION_STATE_ACTIVE | IN_GRACE_PERIOD | ON_HOLD | CANCELED | EXPIRED | PENDING
  const state: string = body?.subscriptionState ?? "";
  const activeStates = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"];

  const line = body?.lineItems?.[0];
  const expiresAt = line?.expiryTime ? new Date(line.expiryTime) : null;

  return {
    valid: activeStates.includes(state) && (!expiresAt || expiresAt > new Date()),
    productId: line?.productId ?? null,
    transactionId: body?.latestOrderId ?? purchaseToken,
    expiresAt,
    isTrial: !!line?.offerDetails?.offerId,
    raw: { subscriptionState: state },
  };
}
