import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Kullanıcı bazlı kilit altında çalıştırır (Postgres advisory lock).
 *
 * NEDEN GEREKLİ: Kota kontrolü ("bugün kaç yorum ürettin?") ile yorumun DB'ye
 * yazılması arasında zaman farkı var — bu ikisi arasına aynı kullanıcıdan gelen
 * ikinci bir istek girerse, ikisi de "henüz limite ulaşmadın" görüp AI çağrısı
 * yapabilir. Free kullanıcı günde 1 yorum hakkına sahipken paralel isteklerle
 * 2-3 yorum üretebilirdi — hem ürün kuralını hem AI maliyet kontrolünü delerdi.
 *
 * `pg_advisory_xact_lock` aynı kullanıcı için gelen istekleri SIRAYLA işletir;
 * farklı kullanıcılar birbirini beklemez. Kilit transaction bitince otomatik
 * serbest kalır (xact_lock kullanmanın avantajı budur — elle unlock gerekmez).
 *
 * `hashtext` kullanıcı UUID'sini bigint'e çevirir çünkü advisory lock bigint anahtar ister.
 */
export async function withUserLock<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // ::text cast açıkça belirtilir; aksi halde Postgres parametreli sorguda
      // "could not determine polymorphic type" hatası verebilir.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;
      return fn(tx);
    },
    {
      // AI çağrısı birkaç saniye sürebilir; varsayılan 5 sn transaction timeout'u yetmez
      timeout: 30_000,
      maxWait: 10_000,
    }
  );
}
