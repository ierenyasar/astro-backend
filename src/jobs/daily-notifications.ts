import { prisma } from "../lib/prisma";
import { sendPushToUsers, pickDailyMessage, isLocalHourNow, alreadySentToday } from "../lib/push";

/**
 * Günlük hatırlatma işi.
 *
 * Saatte bir çalışır ve o an YEREL saati kullanıcının tercih ettiği saate eşit olan
 * cihazlara bildirim gönderir. Böylece herkes kendi sabahında bildirim alır.
 *
 * Spam koruması (madde 17):
 *   - Kullanıcıya günde en fazla 1 hatırlatma gönderilir.
 *   - Kullanıcı bugün uygulamayı açıp yorumunu zaten okuduysa bildirim GÖNDERİLMEZ.
 *   - Bildirimi kapatan kullanıcılar tamamen hariç tutulur.
 */

function todayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function runDailyNotificationJob(now = new Date()) {
  const tokens = await prisma.pushToken.findMany({
    where: { enabled: true, failCount: { lt: 3 } },
  });

  // 1) Şu an yerel saati eşleşenler
  type TokenRow = { userId: string; timezone: string | null; hourLocal: number; lastSentAt: Date | null };
  const dueTokens = (tokens as TokenRow[]).filter(
    (t) => isLocalHourNow(t.timezone, t.hourLocal, now) && !alreadySentToday(t.lastSentAt, t.timezone, now)
  );
  if (!dueTokens.length) {
    return { candidates: 0, skippedAlreadyRead: 0, sent: 0, disabled: 0 };
  }

  const userIds: string[] = [...new Set(dueTokens.map((t) => t.userId))];

  // 2) Bugün yorumunu zaten okuyanları çıkar — okumuş kullanıcıyı dürtmek spam olur
  const alreadyRead = await prisma.reading.findMany({
    where: { userId: { in: userIds }, readingDate: todayUTC() },
    select: { userId: true },
  });
  const readSet = new Set((alreadyRead as { userId: string }[]).map((r) => r.userId));
  const targetUserIds = userIds.filter((id) => !readSet.has(id));

  if (!targetUserIds.length) {
    return { candidates: userIds.length, skippedAlreadyRead: readSet.size, sent: 0, disabled: 0 };
  }

  const message = pickDailyMessage();
  const result = await sendPushToUsers(targetUserIds, {
    ...message,
    data: { type: "daily_reading" },
  });

  // Bildirim kaydı (geçmiş/analitik için)
  await prisma.notification.createMany({
    data: targetUserIds.map((userId) => ({
      userId,
      type: "daily_reading",
      title: message.title,
      body: message.body,
      sentAt: new Date(),
    })),
  });

  return {
    candidates: userIds.length,
    skippedAlreadyRead: readSet.size,
    sent: result.sent,
    disabled: result.disabled,
  };
}

/**
 * Zamanlayıcıyı başlatır. Basit setInterval kullanır; tek sunucu için yeterlidir.
 *
 * ÖLÇEKLENME NOTU: Birden fazla sunucu instance'ı çalıştırıldığında her biri aynı işi
 * tetikler ve kullanıcı mükerrer bildirim alır. Çok instance'lı kurulumda bunu ayrı bir
 * worker'a taşı veya dağıtık kilit (Redis) kullan. Alternatif: platformun cron
 * mekanizmasını (Railway/Render/Fly cron, AWS EventBridge) kullanıp `/internal/cron/daily`
 * ucunu çağır.
 */
export function startNotificationScheduler(log?: { info: (o: unknown, m?: string) => void }) {
  if (process.env.DISABLE_NOTIFICATION_SCHEDULER === "true") {
    log?.info({}, "Bildirim zamanlayıcısı devre dışı (DISABLE_NOTIFICATION_SCHEDULER)");
    return null;
  }

  const HOUR = 60 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      const result = await runDailyNotificationJob();
      if (result.sent > 0 || result.candidates > 0) {
        log?.info(result, "Günlük bildirim işi tamamlandı");
      }
    } catch (err) {
      log?.info({ err }, "Günlük bildirim işi başarısız");
    }
  }, HOUR);

  // Node'un kapanmasını engellemesin
  timer.unref?.();
  return timer;
}
