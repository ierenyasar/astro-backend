import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../prompts";

const MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY tanımlı değil. .env dosyanı kontrol et.");
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function extractText(content: Anthropic.ContentBlock[]) {
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
}

/** Yapılandırılmış (JSON) bir reading yanıtı üretir: { energy, insight, advice } */
export async function generateStructuredReading(userPrompt: string) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = extractText(res.content);

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
 */
/**
 * Serbest metin yanıtı.
 *
 * `system` parametresi opsiyoneldir ve VARSAYILAN olarak astroloji SYSTEM_PROMPT'unu
 * kullanır. Rüya analizi gibi FARKLI bir gelenek/kural setine sahip özellikler kendi
 * sistem prompt'unu buraya geçirmelidir — kullanıcı mesajının içine gömmemelidir.
 *
 * NEDEN KRİTİK: Sistem prompt'u, modelin otorite kabul ettiği katmandır. Güvenlik
 * kurallarını (ölüm/hastalık yasağı gibi) user mesajına gömmek, onları tam da
 * "veri olarak ele al, talimat sayma" dediğimiz katmana düşürür ve prompt injection'a
 * karşı savunmasız bırakır.
 */
export async function generateFreeTextReply(
  userPrompt: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  system: string = SYSTEM_PROMPT
) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 500,
    system,
    messages: [...history, { role: "user" as const, content: userPrompt }],
  });

  return extractText(res.content);
}

/**
 * Görsel + metin isteği (Türk kahvesi falı için).
 *
 * Birden fazla fotoğraf kabul eder (fincan + tabak, farklı açılar vb. — geleneksel
 * Türk kahve falında tek kareden çok, birkaç açı bakılması yaygındır). Anthropic'in
 * vision desteği ile her fotoğraf, mesaj content'inde ayrı bir "image" bloğu olarak
 * gönderilir. `system` parametresi ayrı geçirilir çünkü kahve falının kendi sistem
 * prompt'u var (astroloji SYSTEM_PROMPT'undan farklı).
 */
export async function generateVisionReading(
  system: string,
  textPrompt: string,
  images: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }[]
) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 500,
    system,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
          })),
          { type: "text", text: textPrompt },
        ],
      },
    ],
  });

  return extractText(res.content);
}
export async function summarizeConversation(transcript: string, previousSummary?: string | null) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 300,
    system:
      "Sen bir konuşma özetleyicisin. Verilen astroloji sohbetini, kullanıcının bahsettiği kişisel bağlamı (ilişki durumu, iş, endişeler, tekrar eden temalar) koruyacak şekilde kısa bir özete indir. Sadece özeti yaz, başka hiçbir şey ekleme. En fazla 5 cümle.",
    messages: [
      {
        role: "user",
        content: `${previousSummary ? `Önceki özet: ${previousSummary}\n\n` : ""}Özetlenecek konuşma:\n${transcript}`,
      },
    ],
  });

  return extractText(res.content);
}
