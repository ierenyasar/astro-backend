import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Free tier limitleri (madde 18). Bu kontrol BACKEND'de yapılır — client'ın gönderdiği
 * "premium: true" gibi bir alana asla güvenilmez (madde 22).
 */
export const FREE_LIMITS = {
  /** Free kullanıcı günde kaç FARKLI kategoride yorum üretebilir (cache'ten gelenler sayılmaz) */
  readingsPerDay: 1,
  /** Free kullanıcı günde kaç Ask the Stars mesajı gönderebilir */
  chatMessagesPerDay: 5,
  /** Free kullanıcı uyum analizini kullanabilir mi */
  compatibilityEnabled: false,
  /** Free'de zaten kapalı; alan tutarlılık için burada duruyor */
  compatibilityPerDay: 0,
};

/** Premium kullanıcılar için de sınırsız değil — abuse/maliyet tavanı (madde 23). */
export const PREMIUM_LIMITS = {
  readingsPerDay: 30,
  chatMessagesPerDay: 200,
  compatibilityEnabled: true,
  /**
   * Premium bile sınırsız değil (madde 23) — her istek bir AI çağrısı demek.
   * Sınırsız bırakılırsa premium bir hesap günde yüzlerce çağrı yapıp
   * maliyeti patlatabilirdi.
   */
  compatibilityPerDay: 15,
};

/**
 * `db` parametresi opsiyoneldir; varsayılan olarak global prisma kullanılır.
 * Kota kontrolünü bir transaction/lock içinde çalıştırmak isteyenler (bkz. lock.ts)
 * `tx` client'ını buraya geçirir — böylece kontrol ve sonraki yazma işlemi
 * aynı bağlantı/transaction üzerinden atomik yapılabilir.
 */
export async function isPremium(userId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  const sub = await db.subscription.findFirst({
    where: {
      userId,
      status: { in: ["trial", "active"] },
      OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  return !!sub;
}

export async function getLimits(userId: string, db: Prisma.TransactionClient = prisma) {
  return (await isPremium(userId, db)) ? PREMIUM_LIMITS : FREE_LIMITS;
}

function startOfToday() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  premium: boolean;
}

/** Bugün üretilmiş (AI çağrısı yapılmış) reading sayısını kontrol eder. */
export async function checkReadingQuota(
  userId: string,
  db: Prisma.TransactionClient = prisma
): Promise<QuotaResult> {
  const premium = await isPremium(userId, db);
  const limits = premium ? PREMIUM_LIMITS : FREE_LIMITS;
  const used = await db.reading.count({
    where: { userId, readingDate: startOfToday() },
  });
  return { allowed: used < limits.readingsPerDay, used, limit: limits.readingsPerDay, premium };
}

/** Bugün üretilmiş uyum analizi sayısını kontrol eder. */
export async function checkCompatibilityQuota(
  userId: string,
  db: Prisma.TransactionClient = prisma
): Promise<QuotaResult> {
  const premium = await isPremium(userId, db);
  const limits = premium ? PREMIUM_LIMITS : FREE_LIMITS;
  const used = await db.compatibilityCheck.count({
    where: { userId, createdAt: { gte: startOfToday() } },
  });
  return { allowed: used < limits.compatibilityPerDay, used, limit: limits.compatibilityPerDay, premium };
}

/** Bugün gönderilmiş kullanıcı chat mesajı sayısını kontrol eder. */
export async function checkChatQuota(
  userId: string,
  db: Prisma.TransactionClient = prisma
): Promise<QuotaResult> {
  const premium = await isPremium(userId, db);
  const limits = premium ? PREMIUM_LIMITS : FREE_LIMITS;
  const used = await db.chatMessage.count({
    where: {
      role: "user",
      createdAt: { gte: startOfToday() },
      chatSession: { userId },
    },
  });
  return { allowed: used < limits.chatMessagesPerDay, used, limit: limits.chatMessagesPerDay, premium };
}
