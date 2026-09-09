import fs from "fs";
import path from "path";

/**
 * AI sağlayıcı denklik testi.
 *
 * gemini.ts, anthropic.ts'in yerine geçebilen bir yedektir (Anthropic kredisi
 * bittiğinde/ücretsiz katmana geçilmek istendiğinde). Bunun çalışması için İKİ
 * dosyanın da AYNI fonksiyonları dışa açması gerekir — aksi halde sağlayıcı
 * değiştirildiğinde bazı özellikler sessizce kırılır.
 *
 * GERÇEK VAKA: gemini.ts, kahve falı özelliğinden ÖNCE yazılmıştı ve
 * generateVisionReading içermiyordu. Fark edilmeseydi, Gemini'ye geçiş
 * kahve falını tamamen bozardı.
 */

const libDir = path.join(__dirname, "..", "src", "lib");
const anthropicSrc = fs.readFileSync(path.join(libDir, "anthropic.ts"), "utf8");
const geminiSrc = fs.readFileSync(path.join(libDir, "gemini.ts"), "utf8");

let pass = 0,
  fail = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
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

function exportedFunctions(src: string): string[] {
  return [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort();
}

const anthropicFns = exportedFunctions(anthropicSrc);
const geminiFns = exportedFunctions(geminiSrc);

t("Her iki sağlayıcı da fonksiyon dışa açıyor", () => {
  assert(anthropicFns.length >= 4, `anthropic.ts'te sadece ${anthropicFns.length} fonksiyon var`);
});

t("gemini.ts, anthropic.ts'in TÜM fonksiyonlarını sağlıyor", () => {
  const missing = anthropicFns.filter((f) => !geminiFns.includes(f));
  assert(
    missing.length === 0,
    `gemini.ts'te eksik: ${missing.join(", ")} — sağlayıcı değişince bu özellikler kırılır`
  );
});

t("Görsel (vision) desteği her iki sağlayıcıda da var", () => {
  // Kahve falı fotoğraf analiz ediyor — sadece metin üreten bir sağlayıcı
  // (örn. Groq'un gpt-oss modelleri) bu özelliği ÇALIŞTIRAMAZ.
  assert(anthropicFns.includes("generateVisionReading"), "anthropic.ts'te vision yok");
  assert(geminiFns.includes("generateVisionReading"), "gemini.ts'te vision yok");
});

t("Vision fonksiyonu çoklu görsel kabul ediyor (1-4 fotoğraf)", () => {
  for (const [name, src] of [["anthropic", anthropicSrc], ["gemini", geminiSrc]] as const) {
    assert(
      /generateVisionReading\([\s\S]{0,300}images:\s*\{/.test(src),
      `${name}.ts'te vision fonksiyonu görsel DİZİSİ almıyor`
    );
  }
});

t("Görsel gerektiren route, vision destekli bir sağlayıcıdan import ediyor", () => {
  const coffeeSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "coffee.ts"),
    "utf8"
  );
  const match = coffeeSrc.match(/import \{ generateVisionReading \} from "\.\.\/lib\/(\w+)"/);
  assert(!!match, "coffee.ts generateVisionReading import etmiyor");
  const provider = match![1];
  const providerSrc = fs.readFileSync(path.join(libDir, `${provider}.ts`), "utf8");
  assert(
    /^export async function generateVisionReading/m.test(providerSrc),
    `coffee.ts "${provider}" kullanıyor ama o dosyada vision fonksiyonu yok`
  );
});


t("Fonksiyon İMZALARI da eşleşiyor (sadece isimler değil)", () => {
  // GERÇEK VAKA: gemini.ts'in generateFreeTextReply'ında `system` parametresi
  // eksikti (anthropic.ts'e QA turunda eklenmişti). Sadece fonksiyon ADLARINI
  // karşılaştıran bir test bunu kaçırdı — sağlayıcı değiştirilseydi rüya
  // analizinin güvenlik prompt'u sessizce astroloji prompt'una düşecekti.
  function paramsOf(src: string, fn: string): string[] {
    const m = src.match(new RegExp(`export async function ${fn}\\(([\\s\\S]*?)\\)\\s*\\{`));
    if (!m) return [];
    return m[1]
      .split(",")
      .map((p) => p.split(":")[0].trim())
      .filter(Boolean);
  }

  for (const fn of anthropicFns) {
    const a = paramsOf(anthropicSrc, fn);
    const g = paramsOf(geminiSrc, fn);
    assert(
      a.length === g.length,
      `${fn}: anthropic ${a.length} parametre (${a.join(",")}), gemini ${g.length} (${g.join(",")})`
    );
    assert(
      a.every((p, i) => p === g[i]),
      `${fn}: parametre adları farklı — anthropic(${a.join(",")}) vs gemini(${g.join(",")})`
    );
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
