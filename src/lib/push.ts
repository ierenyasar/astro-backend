import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";

/**
 * Prisma gecikmeli (lazy) yüklenir: bu modüldeki zamanlama yardımcıları
 * (isLocalHourNow, alreadySentToday, pickDailyMessage) tamamen saf fonksiyonlardır
 * ve DB'ye ihtiyaç duymaz — testlerde bağımsız çalışabilmeleri gerekir.
 */
async function db() {
  const mod = await import("./prisma");
  return mod.prisma;
}

/**
 * Expo Push API üzerinden bildirim gönderimi.
 *
 * Tasarım notları:
 * - Geçersiz hale gelen token'lar (uygulama silinmiş, izin kaldırılmış) otomatik
 *   devre dışı bırakılır. Aksi halde ölü token'lara sürekli gönderim denenir.
 * - Bildirimler kullanıcının YEREL saatine göre gönderilir. Herkese aynı UTC saatinde
 *   göndermek, kullanıcının gecesinin ortasına denk gelebilir.
 * - Aynı kullanıcıya günde birden fazla hatırlatma gönderilmez (spam koruması, madde 17).
 */

const expo = new Expo({
  // accessToken opsiyonel; Expo hesabında "enhanced security" açıksa gerekir
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

const MAX_FAILURES = 3;

/** Bildirim metinleri — tekrar etmemesi için rastgele seçilir (madde 17). */
const DAILY_MESSAGES = [
  { title: "Yıldızların sana bir mesajı var ✨", body: "Bugünkü yorumun hazır." },
  { title: "Günün haritası çıktı 🌙", body: "Bugün seni ne bekliyor, bir bak." },
  { title: "Bugünkü enerjin ✨", body: "Kozmik içgörün seni bekliyor." },
  { title: "Gökyüzü bugün ne diyor? 🔮", body: "Kişisel yorumun hazırlandı." },
];

export function pickDailyMessage() {
  return DAILY_MESSAGES[Math.floor(Math.random() * DAILY_MESSAGES.length)];
}

/** Bir kullanıcının aktif cihaz token'larını getirir. */
async function activeTokensFor(userId: string) {
  const prisma = await db();
  return prisma.pushToken.findMany({
    where: { userId, enabled: true, failCount: { lt: MAX_FAILURES } },
  });
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Belirli kullanıcılara bildirim gönderir.
 * Dönüş: kaç bildirim gönderildi, kaç token devre dışı bırakıldı.
 */
export async function sendPushToUsers(userIds: string[], payload: PushPayload) {
  if (!userIds.length) return { sent: 0, disabled: 0 };

  const prisma = await db();
  const tokens = await prisma.pushToken.findMany({
    where: { userId: { in: userIds }, enabled: true, failCount: { lt: MAX_FAILURES } },
  });

  return sendToTokens(tokens, payload);
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  const tokens = await activeTokensFor(userId);
  return sendToTokens(tokens, payload);
}

async function sendToTokens(
  tokens: { id: string; token: string }[],
  payload: PushPayload
) {
  const prisma = await db();
  const valid = tokens.filter((t) => Expo.isExpoPushToken(t.token));

  // Format olarak geçersiz token'ları hemen devre dışı bırak
  const invalidIds = tokens.filter((t) => !Expo.isExpoPushToken(t.token)).map((t) => t.id);
  if (invalidIds.length) {
    await prisma.pushToken.updateMany({
      where: { id: { in: invalidIds } },
      data: { enabled: false },
    });
  }

  if (!valid.length) return { sent: 0, disabled: invalidIds.length };

  const messages: ExpoPushMessage[] = valid.map((t) => ({
    to: t.token,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];
  const chunkTokenIds: string[][] = [];

  let offset = 0;
  for (const chunk of chunks) {
    const ids = valid.slice(offset, offset + chunk.length).map((t) => t.id);
    offset += chunk.length;
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res);
      chunkTokenIds.push(ids);
    } catch (err) {
      // Ağ hatası — token'ı suçlama, bir sonraki turda tekrar denenecek
      console.error("Push chunk gönderilemedi:", err);
      chunkTokenIds.push(ids);
      tickets.push(...ids.map(() => ({ status: "error" as const, message: "network" } as any)));
    }
  }

  // Ticket'ları değerlendir: DeviceNotRegistered ise token'ı kalıcı olarak kapat
  const flatIds = chunkTokenIds.flat();
  let disabled = invalidIds.length;
  let sent = 0;

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i] as any;
    const tokenId = flatIds[i];
    if (!tokenId) continue;

    if (ticket.status === "ok") {
      sent++;
      await prisma.pushToken.update({
        where: { id: tokenId },
        data: { failCount: 0, lastSentAt: new Date() },
      });
    } else if (ticket.details?.error === "DeviceNotRegistered") {
      // Uygulama silinmiş veya token geçersiz — tekrar denemenin anlamı yok
      await prisma.pushToken.update({ where: { id: tokenId }, data: { enabled: false } });
      disabled++;
    } else {
      const t = await prisma.pushToken.update({
        where: { id: tokenId },
        data: { failCount: { increment: 1 } },
      });
      if (t.failCount >= MAX_FAILURES) disabled++;
    }
  }

  return { sent, disabled };
}

/**
 * Kullanıcının yerel saatinin, tercih ettiği bildirim saatiyle eşleşip eşleşmediğini kontrol eder.
 * timezone bilinmiyorsa UTC varsayılır.
 */
export function isLocalHourNow(timezone: string | null, hourLocal: number, now = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      hour12: false,
    });
    const localHour = parseInt(formatter.format(now), 10);
    return localHour === hourLocal;
  } catch {
    // Geçersiz timezone — UTC'ye düş
    return now.getUTCHours() === hourLocal;
  }
}

/** Kullanıcıya bugün zaten bildirim gönderilmiş mi? (spam koruması) */
export function alreadySentToday(lastSentAt: Date | null, timezone: string | null, now = new Date()) {
  if (!lastSentAt) return false;
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" }).format(d);
  try {
    return fmt(lastSentAt) === fmt(now);
  } catch {
    return lastSentAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  }
}
