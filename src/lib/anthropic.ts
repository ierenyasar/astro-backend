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
export async function generateFreeTextReply(
  userPrompt: string,
  history: { role: "user" | "assistant"; content: string }[] = []
) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: "user" as const, content: userPrompt }],
  });

  return extractText(res.content);
}

/** Uzayan sohbetlerde eski mesajları tek bir özete indirger (token maliyetini sabit tutar). */
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
