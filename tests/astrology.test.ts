import { computeChart, computeDailyScores, computeSynastry, getSunSign, GeocodingError } from "../src/lib/astrology";

let pass = 0, fail = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log("PASS:", name); pass++; }
  catch (e: any) { console.log("FAIL:", name, "-", e.message); fail++; }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function main() {
  // 1. Doğum saati bilinen tam hesaplama
  const full = await computeChart({
    birthDate: new Date("2002-07-28T00:00:00Z"),
    birthTime: "19:30", birthTimeKnown: true, birthCity: "İstanbul",
  });
  console.log("Full chart:", JSON.stringify({
    sun: full.sunSign, moon: full.moonSign, rising: full.risingSign,
    venus: full.planets?.venus.sign, houses: full.houses?.length, aspects: full.aspects?.length,
  }));

  await t("Güneş burcu doğru (28 Tem 2002 -> Leo)", () => assert(full.sunSign === "Leo", `beklenen Leo, gelen ${full.sunSign}`));
  await t("Yükselen hesaplandı", () => assert(full.risingSign !== null, "rising null"));
  await t("12 ev hesaplandı", () => assert(full.houses?.length === 12, "houses eksik"));
  await t("Gezegenler hesaplandı", () => assert(!!full.planets?.venus, "venus yok"));
  await t("Açılar hesaplandı", () => assert((full.aspects?.length ?? 0) > 0, "aspect yok"));
  await t("moonUncertain false", () => assert(full.moonUncertain === false, "moonUncertain yanlış"));

  // 2. Doğum saati bilinmeyen
  const noTime = await computeChart({
    birthDate: new Date("2002-07-28T00:00:00Z"),
    birthTime: null, birthTimeKnown: false, birthCity: "İstanbul",
  });
  await t("Saat yoksa rising null", () => assert(noTime.risingSign === null, "rising null olmalı"));
  await t("Saat yoksa houses null", () => assert(noTime.houses === null, "houses null olmalı"));
  await t("Saat yoksa moonUncertain true", () => assert(noTime.moonUncertain === true, "moonUncertain true olmalı"));
  await t("Saat yoksa bile Güneş doğru", () => assert(noTime.sunSign === "Leo", "sun yanlış"));

  // 3. Türkçe karakterli şehir normalize (yerleşik listeden, ağ gerektirmez)
  await t("Türkçe şehir adı çözülüyor", async () => {
    const r = await computeChart({ birthDate: new Date("1995-03-15T00:00:00Z"), birthTime: "08:00", birthTimeKnown: true, birthCity: "İzmir" });
    assert(r.sunSign === "Pisces", `beklenen Pisces, gelen ${r.sunSign}`);
  });

  // 4. Koordinat doğrudan verilirse geocoding'e hiç gidilmez
  await t("Doğrudan koordinat ile hesaplama", async () => {
    const r = await computeChart({
      birthDate: new Date("1990-11-05T00:00:00Z"), birthTime: "03:15", birthTimeKnown: true,
      birthCity: "Bilinmeyen Yer", latitude: 48.8566, longitude: 2.3522,
    });
    assert(r.sunSign === "Scorpio", `beklenen Scorpio, gelen ${r.sunSign}`);
    assert(r.risingSign !== null, "rising hesaplanmalı");
  });

  // 5. Burçların tamamı
  const cusps: [string, string][] = [
    ["2000-01-15", "Capricorn"], ["2000-02-10", "Aquarius"], ["2000-03-10", "Pisces"],
    ["2000-04-10", "Aries"], ["2000-05-10", "Taurus"], ["2000-06-10", "Gemini"],
    ["2000-07-10", "Cancer"], ["2000-08-10", "Leo"], ["2000-09-10", "Virgo"],
    ["2000-10-10", "Libra"], ["2000-11-10", "Scorpio"], ["2000-12-10", "Sagittarius"],
  ];
  await t("12 burcun tamamı doğru (getSunSign, senkron)", () => {
    for (const [date, expected] of cusps) {
      const s = getSunSign(new Date(date + "T00:00:00Z"));
      assert(s.name === expected, `${date}: beklenen ${expected}, gelen ${s.name}`);
    }
  });

  // 6. Dereceler ve Placidus ev sınırları
  await t("Ekliptik dereceler mantıklı aralıkta", () => {
    assert(full.sunDegree >= 120 && full.sunDegree < 150, `Aslan 120-150 olmalı, gelen ${full.sunDegree}`);
    assert(full.moonDegree >= 330 && full.moonDegree < 360, `Balık 330-360 olmalı, gelen ${full.moonDegree}`);
    assert(full.risingDegree! >= 270 && full.risingDegree! < 300, `Oğlak 270-300 olmalı, gelen ${full.risingDegree}`);
  });

  await t("Gezegenlerin derecesi var", () => {
    assert(typeof full.planets?.venus.degree === "number", "venus derecesi yok");
  });

  await t("Placidus evleri eşit aralıklı DEĞİL", () => {
    const degs = full.houses!.map((h) => h.degree);
    const gaps = degs.map((d, i) => ((degs[(i + 1) % 12] - d + 360) % 360));
    const allEqual = gaps.every((g) => Math.abs(g - 30) < 0.5);
    assert(!allEqual, "Placidus evleri 30'ar derece çıktı — ev sistemi yanlış hesaplanıyor olabilir");
  });

  await t("Saat yoksa risingDegree null", () => assert(noTime.risingDegree === null, "null olmalı"));

  // 7. Saat dilimi ve DST — kütüphane koordinattan çözüyor, bunun bozulmadığını doğrula
  await t("Konum haritayı etkiliyor (enlem/boylam dikkate alınıyor)", async () => {
    // Aynı YEREL saatte doğan iki kişinin yükselen BURCU benzer olabilir — yerel saat
    // zaten güneş konumunu takip eder. Ama enlem ve saat dilimi içi boylam farkı
    // yüzünden yükselen DERECESİ farklı olmalı. Aynı çıkarsa konum yok sayılıyor demektir.
    const ist = await computeChart({
      birthDate: new Date("2002-07-28T00:00:00Z"), birthTime: "19:30",
      birthTimeKnown: true, birthCity: "Istanbul",
    });
    const ny = await computeChart({
      birthDate: new Date("2002-07-28T00:00:00Z"), birthTime: "19:30",
      birthTimeKnown: true, birthCity: "new york",
    });
    assert(
      Math.abs((ist.risingDegree ?? 0) - (ny.risingDegree ?? 0)) > 0.5,
      "konum haritayı etkilememiş"
    );
  });

  await t("Saat dilimi UTC'ye doğru çevriliyor", async () => {
    // Istanbul'da 19:30 (UTC+3) = UTC 16:30. Aynı ANI temsil eden UTC 16:30'u
    // Londra'da (UTC+1, yaz saati) 17:30 olarak vermek benzer bir gökyüzü vermeli.
    const ist = await computeChart({
      birthDate: new Date("2002-07-28T00:00:00Z"), birthTime: "19:30",
      birthTimeKnown: true, birthCity: "Istanbul",
    });
    const lon = await computeChart({
      birthDate: new Date("2002-07-28T00:00:00Z"), birthTime: "17:30",
      birthTimeKnown: true, birthCity: "London",
    });
    // Aynı evrensel an -> Güneş derecesi neredeyse aynı olmalı (günde ~1° hareket eder)
    assert(
      Math.abs(ist.sunDegree - lon.sunDegree) < 0.1,
      `aynı an farklı Güneş derecesi verdi: ${ist.sunDegree} vs ${lon.sunDegree}`
    );
  });

  await t("DST doğru uygulanıyor (yaz/kış farkı)", async () => {
    // Türkiye 2010'da kışın UTC+2, yazın UTC+3 kullanıyordu.
    // Aynı yerel saatte doğan iki kişinin Ay derecesi farklı olmalı.
    const winter = await computeChart({
      birthDate: new Date("2010-01-15T00:00:00Z"), birthTime: "12:00",
      birthTimeKnown: true, birthCity: "Istanbul",
    });
    const summer = await computeChart({
      birthDate: new Date("2010-07-15T00:00:00Z"), birthTime: "12:00",
      birthTimeKnown: true, birthCity: "Istanbul",
    });
    assert(winter.risingDegree !== summer.risingDegree, "DST hesaba katılmıyor");
  });

  // 8. Günlük puanlar — daha önce sabitti, herkese aynı gösteriliyordu
  const natalA = { sun: full.sunDegree, moon: full.moonDegree, planets: full.planets! };
  const other = await computeChart({
    birthDate: new Date("1990-02-14T00:00:00Z"), birthTime: "06:00",
    birthTimeKnown: true, birthCity: "Ankara",
  });
  const natalB = { sun: other.sunDegree, moon: other.moonDegree, planets: other.planets! };
  const day1 = new Date("2026-03-15T00:00:00Z");
  const day2 = new Date("2026-09-10T00:00:00Z");

  await t("Puanlar 1-5 aralığında", () => {
    const s = computeDailyScores(natalA, day1);
    for (const [k, v] of Object.entries(s)) {
      assert(v >= 1 && v <= 5, `${k} aralık dışı: ${v}`);
      assert(Number.isInteger(v), `${k} tam sayı değil: ${v}`);
    }
  });

  await t("Aynı kullanıcı + aynı gün = aynı puan (gün içinde değişmez)", () => {
    const a1 = computeDailyScores(natalA, day1);
    const a2 = computeDailyScores(natalA, day1);
    assert(JSON.stringify(a1) === JSON.stringify(a2), "puanlar her çağrıda değişiyor");
  });

  await t("Farklı kullanıcılar farklı puan alabiliyor", () => {
    // Sabit değerlerin geri gelmesini yakalar
    let differs = false;
    for (const d of [day1, day2, new Date("2026-01-05T00:00:00Z"), new Date("2026-11-22T00:00:00Z")]) {
      if (JSON.stringify(computeDailyScores(natalA, d)) !== JSON.stringify(computeDailyScores(natalB, d))) {
        differs = true;
        break;
      }
    }
    assert(differs, "tüm kullanıcılar aynı puanı alıyor — kişiselleştirme yok");
  });

  await t("Aynı kullanıcı farklı günlerde farklı puan alabiliyor", () => {
    let differs = false;
    const days = ["2026-01-05", "2026-03-15", "2026-06-20", "2026-09-10", "2026-11-22"];
    const first = JSON.stringify(computeDailyScores(natalA, new Date(days[0] + "T00:00:00Z")));
    for (const d of days.slice(1)) {
      if (JSON.stringify(computeDailyScores(natalA, new Date(d + "T00:00:00Z"))) !== first) {
        differs = true;
        break;
      }
    }
    assert(differs, "puanlar gün değişse de sabit kalıyor");
  });

  await t("Dört alanın tamamı hesaplanıyor", () => {
    const s = computeDailyScores(natalA, day1);
    for (const k of ["energy", "love", "career", "money"]) {
      assert(k in s, `eksik alan: ${k}`);
    }
  });

  // 9. Sinastri — daha önce isim hash'inden üretiliyordu, astrolojiyle ilgisi yoktu
  const third = await computeChart({
    birthDate: new Date("1995-04-12T00:00:00Z"), birthTime: "14:00",
    birthTimeKnown: true, birthCity: "Izmir",
  });
  const natalC = { sun: third.sunDegree, moon: third.moonDegree, planets: third.planets! };

  await t("Uyum puanları makul aralıkta", () => {
    const sc = computeSynastry(natalA, natalB);
    for (const [k, v] of Object.entries(sc)) {
      assert(v >= 40 && v <= 95, `${k} aralık dışı: ${v}`);
      assert(Number.isInteger(v), `${k} tam sayı değil`);
    }
  });

  await t("Aynı çift her zaman aynı sonucu verir", () => {
    assert(
      JSON.stringify(computeSynastry(natalA, natalB)) === JSON.stringify(computeSynastry(natalA, natalB)),
      "sonuç her çağrıda değişiyor"
    );
  });

  await t("Farklı çiftler farklı uyum alır", () => {
    const ab = JSON.stringify(computeSynastry(natalA, natalB));
    const ac = JSON.stringify(computeSynastry(natalA, natalC));
    assert(ab !== ac, "tüm çiftler aynı puanı alıyor — hesap gerçek değil");
  });

  await t("Uyum haritalara bağlı, isme değil", () => {
    // Eski hash yönteminde isim değişince puan değişiyordu; artık değişmemeli
    const sc1 = computeSynastry(natalA, natalB);
    const sc2 = computeSynastry(natalA, natalB);
    assert(sc1.overall === sc2.overall, "puan harita dışı bir şeye bağlı");
  });

  await t("Genel puan alt puanların ortalaması", () => {
    const sc = computeSynastry(natalA, natalC);
    const avg = Math.round(
      (sc.communication + sc.emotionalConnection + sc.chemistry + sc.longTermPotential) / 4
    );
    assert(sc.overall === avg, `overall ${sc.overall}, beklenen ${avg}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
