import crypto from "crypto";
import { verifyAppleNotification, appleNotificationToStatus, WebhookVerificationError } from "../src/lib/webhook-apple";
import { parseGoogleNotification, googleNotificationToStatus } from "../src/lib/webhook-google";

let pass = 0, fail = 0;
function t(name: string, fn: () => void) {
  try { fn(); console.log("PASS:", name); pass++; }
  catch (e: any) { console.log("FAIL:", name, "-", e.message); fail++; }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function expectThrow(fn: () => void, msg: string) {
  try { fn(); throw new Error("hata atmalıydı: " + msg); }
  catch (e: any) { if (e.message.startsWith("hata atmalıydı")) throw e; }
}

function b64url(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Apple: saldırgan senaryoları ---

t("Bozuk JWS formatı reddedilir", () => {
  expectThrow(() => verifyAppleNotification("sadece.iki-parca"), "format");
});

t("x5c olmayan bildirim reddedilir", () => {
  const jws = `${b64url({ alg: "ES256" })}.${b64url({ notificationType: "SUBSCRIBED" })}.AAAA`;
  expectThrow(() => verifyAppleNotification(jws), "x5c yok");
});

t("Saldırganın kendi ürettiği sertifika zinciri reddedilir", () => {
  // Saldırgan kendi self-signed sertifikasını üretip x5c'ye koyuyor.
  // Apple Root CA'ya bağlanmadığı için reddedilmeli.
  const fakeCerts = ["ZmFrZQ==", "ZmFrZTI="];
  const jws = `${b64url({ alg: "ES256", x5c: fakeCerts })}.${b64url({
    notificationType: "SUBSCRIBED",
  })}.AAAA`;
  expectThrow(() => verifyAppleNotification(jws), "sahte zincir");
});

t("Geçerli imza ama yanlış root -> reddedilir", () => {
  // Gerçek bir ES256 anahtar çiftiyle imzalanmış ama Apple Root CA'ya bağlanmayan bildirim
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const header = b64url({ alg: "ES256", x5c: ["ZmFrZQ=="] });
  const payload = b64url({ notificationType: "SUBSCRIBED" });
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey, dsaEncoding: "ieee-p1363",
  });
  const jws = `${header}.${payload}.${sig.toString("base64url")}`;
  expectThrow(() => verifyAppleNotification(jws), "yanlış root");
});

// --- Apple: durum eşleme ---

t("EXPIRED -> expired", () => assert(appleNotificationToStatus("EXPIRED") === "expired", "yanlış"));
t("REVOKE -> cancelled", () => assert(appleNotificationToStatus("REVOKE") === "cancelled", "yanlış"));
t("DID_RENEW -> active", () => assert(appleNotificationToStatus("DID_RENEW") === "active", "yanlış"));
t("SUBSCRIBED/INITIAL_BUY -> trial", () => assert(appleNotificationToStatus("SUBSCRIBED", "INITIAL_BUY") === "trial", "yanlış"));
t("Grace period -> erişim sürer (active)", () =>
  assert(appleNotificationToStatus("DID_FAIL_TO_RENEW", "GRACE_PERIOD") === "active", "yanlış"));
t("Grace period olmayan renew hatası -> expired", () =>
  assert(appleNotificationToStatus("DID_FAIL_TO_RENEW") === "expired", "yanlış"));
t("İptal (dönem sonuna kadar erişim) durum değiştirmez", () =>
  assert(appleNotificationToStatus("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED") === null, "yanlış"));

// --- Google ---

t("Google Pub/Sub mesajı çözümlenir", () => {
  const inner = { subscriptionNotification: { notificationType: 13, purchaseToken: "tok_123", subscriptionId: "premium_monthly" } };
  const body = { message: { data: Buffer.from(JSON.stringify(inner)).toString("base64") } };
  const n = parseGoogleNotification(body);
  assert(n.notificationType === 13, "tip yanlış");
  assert(n.purchaseToken === "tok_123", "token yanlış");
});

t("Google data alanı yoksa hata", () => {
  expectThrow(() => parseGoogleNotification({ message: {} }), "data yok");
});

t("Google EXPIRED(13) -> expired", () => assert(googleNotificationToStatus(13) === "expired", "yanlış"));
t("Google REVOKED(12) -> cancelled", () => assert(googleNotificationToStatus(12) === "cancelled", "yanlış"));
t("Google RENEWED(2) -> active", () => assert(googleNotificationToStatus(2) === "active", "yanlış"));
t("Google GRACE(6) -> erişim sürer", () => assert(googleNotificationToStatus(6) === "active", "yanlış"));
t("Google CANCELED(3) durum değiştirmez", () => assert(googleNotificationToStatus(3) === null, "yanlış"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
