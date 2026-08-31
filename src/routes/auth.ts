import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { createHash, randomBytes } from "crypto";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { sendEmail, passwordResetEmail, isEmailConfigured } from "../lib/email";

/**
 * Uzunluk sınırları bilinçlidir:
 * - email: Zod'un .email() formatı doğrular ama uzunluğu SINIRLAMAZ — "a"*10000+"@x.com"
 *   geçerli bir e-posta gibi görünüp geçebilirdi. RFC 5321 sınırı (254) uygulanır.
 * - password: bcrypt.hash() 72 byte'tan sonrasını sessizce yok sayar, ama sınırsız
 *   bırakılırsa yine de her istek CPU/bellek harcayan gereksiz büyük girdi kabul eder.
 */
const credentialsSchema = z.object({
  email: z.string().email("Geçerli bir e-posta adresi gir").max(254),
  password: z.string().min(8, "Şifre en az 8 karakter olmalı").max(128, "Şifre çok uzun"),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  /** Bu cihazdaki boş anonim hesabın temizlenmesi için (opsiyonel, doğrulanır) */
  discardToken: z.string().max(2000).optional(),
});

const TOKEN_TTL = "365d";
const RESET_TTL_MINUTES = 60;

/** Token'ın kendisi değil özeti saklanır; DB sızarsa token'lar kullanılamaz. */
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Anonim hesaplar için üretilen e-posta biçimi; gerçek adreslerle çakışmaz. */
function anonymousEmail() {
  return `anon-${randomUUID()}@device.local`;
}

export default async function authRoutes(app: FastifyInstance) {
  /**
   * Uygulama ilk açılışta e-posta/şifre istemeden hesap açar.
   * Kullanıcı daha sonra /auth/link-email ile bu hesabı kalıcı hale getirebilir.
   */
  app.post("/auth/anonymous", {
    // Kimliksiz, DB satırı oluşturuyor VE bcrypt.hash() çalıştırıyor (bilinçli
    // olarak yavaş/CPU-yoğun bir fonksiyon) — dedike limit olmadan hem DB şişirme
    // hem CPU tüketen bir DoS vektörü olurdu. 20/dk gerçek kullanımı (token kaybı,
    // test) rahatça karşılar ama spam'i engeller.
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    const passwordHash = await bcrypt.hash(randomUUID(), 12);
    const user = await prisma.user.create({
      data: { email: anonymousEmail(), passwordHash, isAnonymous: true },
    });

    const token = app.jwt.sign({ userId: user.id }, { expiresIn: TOKEN_TTL });
    return reply.code(201).send({ token, userId: user.id, isAnonymous: true });
  });

  /** Mevcut oturumun durumu — uygulama "hesabını bağla" uyarısını buna göre gösterir. */
  app.get("/auth/me", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isAnonymous: true, createdAt: true },
    });
    if (!user) {
      return reply.code(404).send({ error: "Hesap bulunamadı." });
    }
    return reply.send({
      userId: user.id,
      isAnonymous: user.isAnonymous,
      // Anonim hesabın sahte e-postasını istemciye gösterme
      email: user.isAnonymous ? null : user.email,
      createdAt: user.createdAt,
    });
  });

  /**
   * Anonim hesabı e-posta + şifreyle kalıcı hale getirir.
   *
   * KRİTİK: Yeni hesap OLUŞTURULMAZ, mevcut hesabın kimliği güncellenir. Böylece
   * doğum haritası, yorumlar, sohbetler ve özellikle ABONELİK aynı userId'de kalır.
   * Yeni hesap açılsaydı kullanıcı ödediği aboneliği kaybederdi.
   */
  app.post("/auth/link-email", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const email = parsed.data.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({ error: "Hesap bulunamadı." });
    }
    if (!user.isAnonymous) {
      return reply.code(409).send({ error: "Bu hesap zaten bir e-postaya bağlı." });
    }

    // Adres başkasına aitse bağlama; aksi halde iki hesap çakışırdı
    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== userId) {
      return reply.code(409).send({
        error: "Bu e-posta zaten kullanılıyor. Giriş yapmayı dene.",
        shouldLogin: true,
      });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { email, passwordHash, isAnonymous: false },
    });

    req.log.info({ userId }, "Anonim hesap e-postaya bağlandı");
    // Token aynı userId'yi taşıdığı için geçerliliğini korur
    return reply.send({ linked: true, email });
  });

  /**
   * Şifre sıfırlama isteği.
   *
   * GÜVENLİK: E-postanın kayıtlı olup olmadığına bakılmaksızın HER ZAMAN aynı
   * yanıt döner. Aksi halde bu uç, hangi e-postaların sistemde olduğunu
   * öğrenmek için kullanılabilirdi.
   */
  app.post("/auth/forgot-password", {
    // Sıkı limit: bu uç hem e-posta bombardımanı hem de hesap keşfi için kullanılabilir
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const parsed = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Geçerli bir e-posta adresi gir." });
    }
    const email = parsed.data.email.trim().toLowerCase();

    const genericResponse = {
      message: "Bu adres kayıtlıysa şifre sıfırlama bağlantısı gönderildi.",
    };

    const user = await prisma.user.findUnique({ where: { email } });
    // Anonim hesapların sahte e-postası vardır; sıfırlama yapılamaz
    if (!user || user.isAnonymous) {
      return reply.send(genericResponse);
    }

    // Aynı kullanıcının kullanılmamış eski token'larını geçersiz kıl
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
      },
    });

    const base = process.env.PASSWORD_RESET_URL || "https://ornek.com/sifre-sifirla";
    const resetUrl = `${base}?token=${token}`;

    try {
      await sendEmail({ to: email, ...passwordResetEmail(resetUrl, RESET_TTL_MINUTES) });
      if (!isEmailConfigured()) {
        req.log.warn("E-posta sağlayıcısı yapılandırılmamış — bağlantı yalnızca konsola yazıldı.");
      }
    } catch (err) {
      req.log.error({ err }, "Şifre sıfırlama e-postası gönderilemedi");
      // Kullanıcıya yine aynı yanıt: e-posta varlığı sızdırılmamalı
    }

    return reply.send(genericResponse);
  });

  /** Token ile yeni şifre belirleme. */
  app.post("/auth/reset-password", {
    // Token tahmin denemelerini sınırla
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const parsed = z
      .object({
        // Gerçek token 64 hex karakter (randomBytes(32).toString("hex")); slack ile sınırlanır
        token: z.string().min(1).max(256, "Geçersiz token"),
        password: z.string().min(8, "Şifre en az 8 karakter olmalı").max(128, "Şifre çok uzun"),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(parsed.data.token) },
      include: { user: true },
    });

    const invalid = { error: "Bağlantı geçersiz veya süresi dolmuş. Yeniden talep et." };
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return reply.code(400).send(invalid);
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const now = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        // sessionsValidFrom güncellenince mevcut TÜM token'lar geçersizleşir —
        // hesabı ele geçiren biri varsa şifre sıfırlama onu da dışarı atar
        data: { passwordHash, sessionsValidFrom: now },
      }),
      prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: now },
      }),
    ]);

    req.log.info({ userId: record.userId }, "Şifre sıfırlandı, oturumlar geçersiz kılındı");

    // Kullanıcı hemen kullanabilsin diye yeni token ver
    const token = app.jwt.sign({ userId: record.userId }, { expiresIn: TOKEN_TTL });
    return reply.send({ reset: true, token, userId: record.userId });
  });

  /** Doğrudan kayıt (anonim akış kullanılmadıysa). */
  app.post("/auth/register", {
    // Aynı sınıf risk: bcrypt.hash() CPU maliyeti + DB yazımı, kimlik doğrulaması yok
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const email = parsed.data.email.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "Bu e-posta zaten kayıtlı." });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, isAnonymous: false },
    });

    const token = app.jwt.sign({ userId: user.id }, { expiresIn: TOKEN_TTL });
    return reply.code(201).send({ token, userId: user.id, isAnonymous: false });
  });

  /**
   * Giriş. Yeni cihazda kullanıcı önce anonim bir hesapla açılmış olur;
   * `discardToken` ile o boş hesabın temizlenmesi istenebilir — aksi halde
   * veritabanında hiç kullanılmayan yetim kayıtlar birikir.
   *
   * GÜVENLİK: Ham userId değil, JWT beklenir ve DOĞRULANIR. Aksi halde bir istemci
   * başkasının hesabının silinmesini isteyebilirdi.
   */
  app.post("/auth/login", {
    // Şifre deneme saldırılarına karşı
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const email = parsed.data.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    // Aynı mesaj: hangi e-postanın kayıtlı olduğunu sızdırmamak için
    if (!user || user.isAnonymous) {
      return reply.code(401).send({ error: "E-posta veya şifre hatalı." });
    }
    const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "E-posta veya şifre hatalı." });
    }

    const discardToken = (req.body as { discardToken?: string })?.discardToken;
    if (discardToken) {
      try {
        const payload = app.jwt.verify(discardToken) as AuthPayload;
        if (payload.userId && payload.userId !== user.id) {
          await cleanupEmptyAnonymousAccount(payload.userId, req.log);
        }
      } catch {
        // Geçersiz token: sadece temizlik atlanır, giriş etkilenmez
      }
    }

    const token = app.jwt.sign({ userId: user.id }, { expiresIn: TOKEN_TTL });
    return reply.send({ token, userId: user.id, isAnonymous: false });
  });
}

/**
 * Giriş sonrası kullanılmayan anonim hesabı siler.
 *
 * Yalnızca gerçekten BOŞ hesaplar silinir: içinde yorum, sohbet veya abonelik
 * varsa dokunulmaz — kullanıcı yanlışlıkla veri kaybetmesin.
 */
async function cleanupEmptyAnonymousAccount(
  userId: string,
  log: { info: (o: unknown, m?: string) => void }
) {
  try {
    const candidate = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isAnonymous: true,
        _count: { select: { readings: true, chatSessions: true, subscriptions: true } },
      },
    });
    if (!candidate?.isAnonymous) return;

    const c = candidate._count;
    if (c.readings > 0 || c.chatSessions > 0 || c.subscriptions > 0) {
      log.info({ userId }, "Anonim hesapta veri var, silinmedi");
      return;
    }

    await prisma.user.delete({ where: { id: userId } });
    log.info({ userId }, "Boş anonim hesap temizlendi");
  } catch (err) {
    // Temizlik başarısız olsa da giriş akışı bozulmamalı
    log.info({ err }, "Anonim hesap temizlenemedi");
  }
}
