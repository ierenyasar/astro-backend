/**
 * Google Gemini tabanlı AI istemcisi.
 *
 * anthropic.ts ile BİREBİR AYNI dışa aktarılan fonksiyon imzalarını kullanır
 * (generateStructuredReading, generateFreeTextReply, summarizeConversation) —
 * bu yüzden route dosyalarında (readings.ts, chat.ts, compatibility.ts) hiçbir
 * değişiklik gerekmez, sadece import satırındaki dosya adını değiştirmen yeterli:
 *
 *   import { generateStructuredReading } from "../lib/anthropic";
 *   // yerine:
 *   import { generateStructuredReading } from "../lib/gemini";
 *
 * Gemini'nin ücretsiz katmanı kredi kartı istemez ama sınırlı kotalıdır
 * (dakikada/günde belirli sayıda istek). Yoğun kullanımda 429 (rate limit)
 * hatası alabilirsin — bu durumda Anthropic'e geri dönmek (bu dosyayı
 * anthropic.ts ile değiştirerek) gerekecek.
 *
 * Gerekli ortam değişkeni: GEMINI_API_KEY (aistudio.google.com/apikey'den alınır,
 * kredi kartı gerektirmez).
 */

import { SYSTEM_PROMPT } from "../prompts";

// "flash" modelleri hızlı ve ücretsiz katmanda cömert kotaya sahiptir.
// Daha güçlü ama daha az cömert kotalı bir model istersen "gemini-2.0-pro" dene.
const MODEL = "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY tanımlı değil. .env dosyanı kontrol et.");
  }
  return key;
}

/**
 * Gemini içerik parçası. Metin VEYA görsel olabilir — kahve falı gibi görsel
 * gerektiren özellikler inlineData kullanır.
 */
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/**
 * Gemini'ye tek bir istek atar.
 * `system`: sistem talimatı. `contents`: konuşma geçmişi + son kullanıcı mesajı.
 */
async function callGemini(
  system: string,
  contents: GeminiContent[],
  maxOutputTokens: number
): Promise<string> {
  const url = `${API_BASE}/${MODEL}:generateContent?key=${apiKey()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        maxOutputTokens,
        temperature: 0.9, // Anthropic tarafında da benzer yaratıcılık seviyesi kullanılıyordu
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error("Gemini ücretsiz kota sınırına ulaşıldı. Biraz sonra tekrar dene.");
    }
    throw new Error(`Gemini API hatası (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as GeminiResponse;

  if (json.promptFeedback?.blockReason) {
    // Gemini'nin kendi güvenlik filtresi devreye girdi — kullanıcıya boş yanıt dönmesin
    throw new Error(`Gemini içeriği engelledi: ${json.promptFeedback.blockReason}`);
  }

  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
  return text.trim();
}

/** Yapılandırılmış (JSON) bir reading yanıtı üretir: { energy, insight, advice } */
export async function generateStructuredReading(userPrompt: string) {
  const text = await callGemini(SYSTEM_PROMPT, [{ role: "user", parts: [{ text: userPrompt }] }], 600);

  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      energy: String(parsed.energy || ""),
      insight: String(parsed.insight || ""),
      advice: String(parsed.advice || ""),
    };
  } catch {
    // Model JSON dışında bir şey döndürdüyse ham metni insight alanına koy — kullanıcı boş ekran görmesin.
    return { energy: "", insight: text, advice: "" };
  }
}

/**
 * Serbest metin yanıtı (chat, compatibility, birth chart özeti).
 * `history` verilirse çok turlu konuşma context'i olarak gönderilir.
 *
 * NOT: Anthropic "assistant" rolü kullanırken Gemini "model" rolü kullanır —
 * bu dönüşüm burada otomatik yapılıyor, çağıran kodun bunu bilmesi gerekmez.
 */
export async function generateFreeTextReply(
  userPrompt: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  system: string = SYSTEM_PROMPT
) {
  const contents: GeminiContent[] = [
    ...history.map((h) => ({
      role: (h.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: h.content }],
    })),
    { role: "user" as const, parts: [{ text: userPrompt }] },
  ];

  return callGemini(system, contents, 500);
}


/**
 * Görsel + metin isteği (Türk kahvesi falı için).
 *
 * anthropic.ts'teki generateVisionReading ile AYNI imzaya sahiptir, böylece
 * coffee.ts'te sadece import satırını değiştirmek yeterli olur.
 *
 * ÖNEMLİ: Gemini'nin "flash" modelleri doğal olarak çok-modludur (metin+görsel),
 * bu yüzden kahve falı için ayrı bir model gerekmez. Groq gibi yalnızca metin
 * üreten sağlayıcılar bu özelliği ÇALIŞTIRAMAZ — sağlayıcı seçerken bu belirleyici.
 */
export async function generateVisionReading(
  system: string,
  textPrompt: string,
  images: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }[]
) {
  const parts: GeminiPart[] = [
    ...images.map((img) => ({
      inlineData: { mimeType: img.mediaType, data: img.base64 },
    })),
    { text: textPrompt },
  ];

  return callGemini(system, [{ role: "user", parts }], 500);
}

/** Uzayan sohbetlerde eski mesajları tek bir özete indirger (token maliyetini sabit tutar). */
export async function summarizeConversation(transcript: string, previousSummary?: string | null) {
  const system =
    "Sen bir konuşma özetleyicisin. Verilen astroloji sohbetini, kullanıcının bahsettiği kişisel bağlamı (ilişki durumu, iş, endişeler, tekrar eden temalar) koruyacak şekilde kısa bir özete indir. Sadece özeti yaz, başka hiçbir şey ekleme. En fazla 5 cümle.";

  const userContent = `${previousSummary ? `Önceki özet: ${previousSummary}\n\n` : ""}Özetlenecek konuşma:\n${transcript}`;

  return callGemini(system, [{ role: "user", parts: [{ text: userContent }] }], 300);
}
