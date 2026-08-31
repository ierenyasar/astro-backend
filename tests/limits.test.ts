import { installPrismaMock, mockPrisma } from "./mock-prisma";

// limits.ts'i yüklemeden ÖNCE prisma mock'unu kur
installPrismaMock();

const { checkReadingQuota, checkChatQuota, checkCompatibilityQuota, isPremium, FREE_LIMITS, PREMIUM_LIMITS } = require("../src/lib/limits");

let pass = 0,
  fail = 0;

async function t(name: string, fn: () => void | Promise<void>) {
  mockPrisma.resetAll();
  try {
    await fn();
    console.log("PASS:", name);
    pass++;
  } catch (e: any) {
    console.log("FAIL:", name, "-", e.message);
    fail++;
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function today() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function seedReading(userId: string, category: string, date = today()) {
  await mockPrisma.reading.create({ data: { userId, category, readingDate: date, content: {} } });
}

async function seedChatMessage(userId: string, sessionId: string, role: "user" | "assistant") {
  await mockPrisma.chatMessage.create({
    data: {
      chatSessionId: sessionId,
      role,
      content: "x",
      createdAt: new Date(),
      // ilişki üzerinden filtreleme için mock'a yardımcı alan
      __chatSession: { userId },
    },
  });
}

async function main() {
  /* ---------------- premium tespiti ---------------- */

  await t("Aboneliği olmayan kullanıcı premium değil", async () => {
    assert((await isPremium("u1")) === false, "premium çıktı");
  });

  await t("Aktif abonelik premium sayılır", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    assert((await isPremium("u1")) === true, "premium değil");
  });

  await t("Trial da premium sayılır", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "trial", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    assert((await isPremium("u1")) === true, "premium değil");
  });

  await t("Süresi geçmiş abonelik premium DEĞİL", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() - 86400000) },
    });
    assert((await isPremium("u1")) === false, "süresi geçmiş abonelik premium sayıldı");
  });

  await t("İptal edilmiş abonelik premium DEĞİL", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "cancelled", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    assert((await isPremium("u1")) === false, "iptal edilmiş abonelik premium sayıldı");
  });

  await t("Expired abonelik premium DEĞİL", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "expired", currentPeriodEnd: null },
    });
    assert((await isPremium("u1")) === false, "expired premium sayıldı");
  });

  await t("BAŞKA kullanıcının aboneliği premium yapmaz", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u2", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    assert((await isPremium("u1")) === false, "başkasının aboneliği sızdı");
  });

  /* ---------------- reading kotası ---------------- */

  await t("Free kullanıcı ilk yorumu üretebilir", async () => {
    const q = await checkReadingQuota("u1");
    assert(q.allowed === true, "izin verilmedi");
    assert(q.limit === FREE_LIMITS.readingsPerDay, "limit yanlış");
  });

  await t("Free kullanıcı günlük limiti aşamaz", async () => {
    for (let i = 0; i < FREE_LIMITS.readingsPerDay; i++) {
      await seedReading("u1", `cat${i}`);
    }
    const q = await checkReadingQuota("u1");
    assert(q.allowed === false, "limit aşıldığı halde izin verildi");
  });

  await t("Dünkü yorumlar bugünün kotasını doldurmaz", async () => {
    const yesterday = new Date(today().getTime() - 86400000);
    for (let i = 0; i < 10; i++) await seedReading("u1", `cat${i}`, yesterday);
    const q = await checkReadingQuota("u1");
    assert(q.allowed === true, "dünkü yorumlar bugünü bloklamış");
  });

  await t("BAŞKA kullanıcının yorumları kotayı etkilemez", async () => {
    for (let i = 0; i < 10; i++) await seedReading("u2", `cat${i}`);
    const q = await checkReadingQuota("u1");
    assert(q.allowed === true, "başka kullanıcının yorumları kotaya sayıldı");
    assert(q.used === 0, `used ${q.used} olmamalı`);
  });

  await t("Premium kullanıcı daha yüksek limite sahip", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    for (let i = 0; i < FREE_LIMITS.readingsPerDay + 3; i++) await seedReading("u1", `cat${i}`);
    const q = await checkReadingQuota("u1");
    assert(q.allowed === true, "premium free limitinde takıldı");
    assert(q.limit === PREMIUM_LIMITS.readingsPerDay, "premium limiti uygulanmadı");
  });

  await t("Premium de sınırsız DEĞİL (maliyet tavanı)", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    for (let i = 0; i < PREMIUM_LIMITS.readingsPerDay; i++) await seedReading("u1", `cat${i}`);
    const q = await checkReadingQuota("u1");
    assert(q.allowed === false, "premium tavanı yok — maliyet riski");
  });

  /* ---------------- chat kotası ---------------- */

  await t("Free kullanıcı chat limitine kadar mesaj atabilir", async () => {
    await seedChatMessage("u1", "s1", "user");
    const q = await checkChatQuota("u1");
    assert(q.allowed === true, "izin verilmedi");
    assert(q.used === 1, `used 1 olmalı, ${q.used}`);
  });

  await t("Free kullanıcı chat limitini aşamaz", async () => {
    for (let i = 0; i < FREE_LIMITS.chatMessagesPerDay; i++) await seedChatMessage("u1", "s1", "user");
    const q = await checkChatQuota("u1");
    assert(q.allowed === false, "limit aşıldığı halde izin verildi");
  });

  await t("Asistan mesajları kullanıcı kotasına sayılmaz", async () => {
    for (let i = 0; i < 20; i++) await seedChatMessage("u1", "s1", "assistant");
    const q = await checkChatQuota("u1");
    assert(q.used === 0, `asistan mesajları sayıldı: ${q.used}`);
    assert(q.allowed === true, "asistan mesajları kullanıcıyı bloklamış");
  });

  await t("BAŞKA kullanıcının mesajları kotayı etkilemez", async () => {
    for (let i = 0; i < 20; i++) await seedChatMessage("u2", "s2", "user");
    const q = await checkChatQuota("u1");
    assert(q.used === 0, `başkasının mesajları sayıldı: ${q.used}`);
    assert(q.allowed === true, "başkasının mesajları bloklamış");
  });

  await t("Uyum analizi free'de kapalı, premium'da açık", async () => {
    const { getLimits } = require("../src/lib/limits");
    const free = await getLimits("u1");
    assert(free.compatibilityEnabled === false, "free'de açık");

    await mockPrisma.subscription.create({
      data: { userId: "u2", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    const prem = await getLimits("u2");
    assert(prem.compatibilityEnabled === true, "premium'da kapalı");
  });

  /* ---------------- uyum analizi kotası ---------------- */

  await t("Free kullanıcı uyum analizi hakkı sıfır", async () => {
    const q = await checkCompatibilityQuota("u1");
    assert(q.allowed === false, "free kullanıcıya izin verildi");
    assert(q.limit === 0, `limit ${q.limit}, 0 olmalı`);
  });

  await t("Premium kullanıcı günlük tavana kadar analiz yapabilir", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    const q = await checkCompatibilityQuota("u1");
    assert(q.allowed === true, "premium engellendi");
    assert(q.limit === PREMIUM_LIMITS.compatibilityPerDay, "limit yanlış");
  });

  await t("Premium bile uyum analizinde sınırsız DEĞİL (maliyet tavanı)", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    for (let i = 0; i < PREMIUM_LIMITS.compatibilityPerDay; i++) {
      await mockPrisma.compatibilityCheck.create({
        data: { userId: "u1", partnerName: `p${i}`, partnerBirthData: {}, scores: {} },
      });
    }
    const q = await checkCompatibilityQuota("u1");
    assert(q.allowed === false, "premium tavanı yok — maliyet riski");
  });

  await t("BAŞKA kullanıcının uyum analizleri kotayı etkilemez", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    for (let i = 0; i < 10; i++) {
      await mockPrisma.compatibilityCheck.create({
        data: { userId: "u2", partnerName: `p${i}`, partnerBirthData: {}, scores: {} },
      });
    }
    const q = await checkCompatibilityQuota("u1");
    assert(q.used === 0, `used ${q.used} olmamalı`);
  });

  await t("Dünkü uyum analizleri bugünün kotasını doldurmaz", async () => {
    await mockPrisma.subscription.create({
      data: { userId: "u1", status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) },
    });
    const yesterday = new Date(Date.now() - 86400000);
    for (let i = 0; i < 10; i++) {
      await mockPrisma.compatibilityCheck.create({
        data: { userId: "u1", partnerName: `p${i}`, partnerBirthData: {}, scores: {}, createdAt: yesterday },
      });
    }
    const q = await checkCompatibilityQuota("u1");
    assert(q.allowed === true, "dünkü analizler bugünü bloklamış");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
