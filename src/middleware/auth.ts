import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma";

export interface AuthPayload {
  userId: string;
  /** JWT'nin üretilme zamanı (saniye) — jsonwebtoken tarafından otomatik eklenir */
  iat?: number;
}

/**
 * Route'lara `preHandler: [requireAuth]` olarak eklenir.
 *
 * İki aşama:
 *  1. JWT imzası doğrulanır.
 *  2. Token, kullanıcının `sessionsValidFrom` tarihinden ÖNCE üretilmişse reddedilir.
 *     Bu olmadan, şifre sıfırlandıktan sonra bile çalınmış bir token bir yıl
 *     boyunca geçerli kalırdı — token'lar durumsuz olduğu için sunucu onları
 *     başka türlü iptal edemez.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Yetkisiz. Geçerli bir oturum token'ı gerekli." });
  }

  const payload = request.user as AuthPayload;
  if (!payload?.iat) return; // iat yoksa kontrol edilemez, imza zaten doğrulandı

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { sessionsValidFrom: true },
  });

  if (!user) {
    return reply.code(401).send({ error: "Hesap bulunamadı." });
  }

  /**
   * JWT'nin `iat` alanı saniyeye yuvarlanır (999 ms'ye kadar geriye kayabilir).
   * Buna uygulama ve veritabanı sunucuları arasındaki olası saat farkı eklenince,
   * dar bir tolerans meşru bir kullanıcıyı şifre sıfırlamadan hemen sonra
   * oturumdan atabilir. 2 saniyelik pencere bunu önler; güvenlik maliyeti ihmal
   * edilebilir çünkü saldırganın bu aralıkta token üretmesi gerekirdi.
   */
  const CLOCK_TOLERANCE_MS = 2000;
  const issuedAt = payload.iat * 1000;
  if (issuedAt < user.sessionsValidFrom.getTime() - CLOCK_TOLERANCE_MS) {
    return reply.code(401).send({
      error: "Oturumun sona erdi. Lütfen tekrar giriş yap.",
      sessionExpired: true,
    });
  }
}
