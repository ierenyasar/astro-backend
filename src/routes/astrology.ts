import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthPayload } from "../middleware/auth";
import { computeChart, computeDailyScores, GeocodingError, signByName } from "../lib/astrology";
import { KNOWN_CITIES, searchCities } from "../lib/geo";

/**
 * birthCity uzunluğu sınırlıdır: doğrudan Nominatim'e (dış geocoding servisi)
 * sorgu parametresi olarak gönderilir. Sınırsız bırakılırsa devasa bir string
 * hem gereksiz dış API çağrısı yapar hem de servisin bizi hız sınırlamasına
 * (rate limit) maruz bırakabilir.
 */
const chartSchema = z.object({
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG formatında olmalı"),
  birthTime: z.string().regex(/^\d{2}:\d{2}$/, "Saat SS:DD formatında olmalı").nullable().optional(),
  birthTimeKnown: z.boolean().default(true),
  birthCity: z.string().min(1).max(100, "Şehir adı çok uzun"),
  birthCountry: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  timezone: z.string().max(50).optional(),
});

export default async function astrologyRoutes(app: FastifyInstance) {
  /**
   * Mobil uygulamadaki şehir arama alanının önerileri için.
   *
   * Kimliksiz bir uç ve yerleşik listede eşleşme yoksa searchCities() dış bir
   * geocoding servisine (Nominatim) istek atar — dedike limit olmadan, rastgele
   * string'lerle spam atılarak dış API'yi kötüye kullanmanın veya bizi Nominatim'in
   * hız sınırlamasına maruz bırakmanın (bu da TÜM kullanıcıların şehir aramasını
   * yavaşlatır) bir yolu olurdu.
   */
  app.get("/astrology/cities", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const q = (req.query as { q?: string })?.q;
    if (!q) return reply.send({ cities: KNOWN_CITIES });
    const results = await searchCities(q);
    return reply.send({
      cities: results.map((c) => ({
        label: c.label ?? q,
        latitude: c.latitude,
        longitude: c.longitude,
      })),
    });
  });

  app.post("/astrology/chart", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const parsed = chartSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const birthDate = new Date(d.birthDate + "T00:00:00Z");
    if (Number.isNaN(birthDate.getTime())) {
      return reply.code(400).send({ error: "Geçersiz doğum tarihi." });
    }

    let computed;
    try {
      computed = await computeChart({
        birthDate,
        birthTime: d.birthTimeKnown ? d.birthTime ?? null : null,
        birthTimeKnown: d.birthTimeKnown,
        birthCity: d.birthCity,
        latitude: d.latitude,
        longitude: d.longitude,
      });
    } catch (err) {
      if (err instanceof GeocodingError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "Doğum haritası hesaplanamadı." });
    }

    const birthDataPayload = {
      birthDate,
      birthTime: d.birthTimeKnown ? d.birthTime ?? null : null,
      birthTimeKnown: d.birthTimeKnown,
      birthCity: d.birthCity,
      birthCountry: d.birthCountry,
      latitude: d.latitude,
      longitude: d.longitude,
      timezone: d.timezone,
    };

    const birthData = await prisma.birthData.upsert({
      where: { userId },
      update: birthDataPayload,
      create: { userId, ...birthDataPayload },
    });

    const chartPayload = {
      sunSign: computed.sunSign,
      moonSign: computed.moonSign,
      risingSign: computed.risingSign,
      // Prisma'nın Json alan tipi (InputJsonValue) index signature'ı olmayan
      // TypeScript interface/dizilerini doğrudan kabul etmez — açık cast gerekir.
      // Bu olmadan derleme HATA VERİR (Railway'de gerçek Prisma client'la
      // yakalandı; bu sandbox'ta prisma generate ağ kısıtlaması yüzünden
      // hiç tam çalışmadığı için bu hata daha önce görünmüyordu).
      planets: (computed.planets ?? undefined) as any,
      houses: (computed.houses ?? undefined) as any,
      aspects: (computed.aspects ?? undefined) as any,
      // Dairesel harita görselleştirmesi için ekliptik dereceler
      degrees: {
        sun: computed.sunDegree,
        moon: computed.moonDegree,
        rising: computed.risingDegree,
      } as any,
    };

    const chart = await prisma.astrologyChart.upsert({
      where: { birthDataId: birthData.id },
      update: { ...chartPayload, computedAt: new Date() },
      create: { birthDataId: birthData.id, ...chartPayload },
    });

    const sun = signByName(computed.sunSign);
    return reply.send({
      birthData,
      chart,
      meta: {
        element: sun.element,
        ruler: sun.ruler,
        housesAvailable: computed.housesAvailable,
        moonUncertain: computed.moonUncertain,
        note: computed.housesAvailable
          ? null
          : "Doğum saati bilinmediği için yükselen burç ve ev hesaplamaları yapılamadı; Ay burcu da gün içinde değişmiş olabilir.",
      },
    });
  });

  /**
   * Ana ekrandaki günlük alan puanları (enerji/aşk/kariyer/para).
   * Doğum haritası ile o günün transitleri karşılaştırılarak hesaplanır;
   * AI çağrısı yapmaz, kota harcamaz.
   */
  app.get("/astrology/daily-scores", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const birthData = await prisma.birthData.findUnique({
      where: { userId },
      include: { chart: true },
    });
    if (!birthData?.chart) {
      return reply.code(404).send({ error: "Doğum haritası henüz oluşturulmamış." });
    }

    const degrees = (birthData.chart.degrees ?? null) as { sun?: number; moon?: number } | null;
    const planets = (birthData.chart.planets ?? {}) as Record<string, { degree: number }>;

    if (degrees?.sun == null || degrees?.moon == null) {
      // Eski kayıtlarda derece bilgisi olmayabilir; haritayı yeniden hesaplatmak gerekir
      return reply.code(409).send({
        error: "Harita verisi güncellenmeli.",
        needsRecompute: true,
      });
    }

    const scores = computeDailyScores(
      { sun: degrees.sun, moon: degrees.moon, planets },
      new Date()
    );
    return reply.send({ scores, date: new Date().toISOString().slice(0, 10) });
  });

  app.get("/astrology/chart", { preHandler: [requireAuth] }, async (req, reply) => {
    const { userId } = req.user as AuthPayload;
    const birthData = await prisma.birthData.findUnique({ where: { userId }, include: { chart: true } });
    if (!birthData?.chart) {
      return reply.code(404).send({ error: "Doğum haritası henüz oluşturulmamış." });
    }
    const sun = signByName(birthData.chart.sunSign);
    return reply.send({
      birthData,
      chart: birthData.chart,
      meta: {
        element: sun.element,
        ruler: sun.ruler,
        housesAvailable: birthData.birthTimeKnown,
        moonUncertain: !birthData.birthTimeKnown,
      },
    });
  });
}
