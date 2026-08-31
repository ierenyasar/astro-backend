/**
 * Analytics event tanımları (madde 30).
 *
 * Tek doğruluk kaynağı: mobil uygulama ve backend aynı isimleri kullanır.
 * Yeni event eklerken buraya ekle — serbest string göndermek, zamanla
 * "paywall_view" / "paywall_viewed" / "viewPaywall" gibi üç ayrı isme yol açar
 * ve veriyi kullanılamaz hale getirir.
 */

export const EVENTS = {
  // yaşam döngüsü
  APP_OPENED: "app_opened",

  // onboarding hunisi — her adım ayrı, nerede kaybettiğimizi görmek için
  ONBOARDING_STARTED: "onboarding_started",
  ONBOARDING_STEP: "onboarding_step",
  ONBOARDING_COMPLETED: "onboarding_completed",

  // içerik
  DAILY_READING_OPENED: "daily_reading_opened",
  LOVE_READING_OPENED: "love_reading_opened",
  CAREER_READING_OPENED: "career_reading_opened",
  MONEY_READING_OPENED: "money_reading_opened",
  READING_OPENED: "reading_opened",
  READING_SAVED: "reading_saved",
  READING_SHARED: "reading_shared",

  // sohbet
  CHAT_STARTED: "chat_started",
  CHAT_MESSAGE_SENT: "chat_message_sent",

  // özellikler
  BIRTH_CHART_OPENED: "birth_chart_opened",
  COMPATIBILITY_STARTED: "compatibility_started",
  COMPATIBILITY_COMPLETED: "compatibility_completed",

  // para
  PAYWALL_VIEWED: "paywall_viewed",
  PAYWALL_DISMISSED: "paywall_dismissed",
  PURCHASE_STARTED: "purchase_started",
  TRIAL_STARTED: "trial_started",
  SUBSCRIPTION_STARTED: "subscription_started",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  PURCHASE_FAILED: "purchase_failed",
  QUOTA_EXHAUSTED: "quota_exhausted",

  // bildirimler
  NOTIFICATION_PERMISSION_GRANTED: "notification_permission_granted",
  NOTIFICATION_PERMISSION_DENIED: "notification_permission_denied",
  NOTIFICATION_OPENED: "notification_opened",
  NOTIFICATIONS_DISABLED: "notifications_disabled",

  // hesap
  ACCOUNT_DELETED: "account_deleted",
  DATA_EXPORTED: "data_exported",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const EVENT_NAMES: string[] = Object.values(EVENTS);

/**
 * Event property'lerinde ASLA saklanmaması gerekenler.
 *
 * Doğum tarihi/saati/yeri kişisel veridir (madde 41) ve analitik veride işi yoktur —
 * burç adı gibi türetilmiş, kimliği belirlemeyen bilgiler yeterlidir.
 */
const BLOCKED_PROPERTY_KEYS = [
  "birthdate",
  "birthtime",
  "birthplace",
  "birthcity",
  "latitude",
  "longitude",
  "email",
  "password",
  "token",
  "name",
  "firstname",
  "partnername",
  "message",
  "content",
];

/** Hassas alanları temizler. Bilinmeyen anahtarlar geçer, bilinen riskli olanlar düşer. */
export function sanitizeProperties(props: Record<string, unknown> | undefined | null) {
  if (!props) return {};
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    const lower = key.toLowerCase();
    if (BLOCKED_PROPERTY_KEYS.some((blocked) => lower.includes(blocked))) continue;

    // Uzun serbest metinler de düşer — kullanıcı sorusu vb. sızmasın
    if (typeof value === "string" && value.length > 120) continue;

    clean[key] = value;
  }
  return clean;
}
