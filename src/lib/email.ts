/**
 * E-posta gönderimi.
 *
 * Sağlayıcıdan bağımsız tutuldu: `EMAIL_PROVIDER` env değişkeniyle seçilir.
 * Yapılandırılmamışsa e-posta konsola yazılır — geliştirme sırasında akışı
 * test edebilmek için. Production'da yapılandırılmazsa şifre sıfırlama
 * çalışmaz ve bu durum loglanır.
 *
 * Desteklenen: "resend" | "console" (varsayılan)
 * Yeni sağlayıcı eklemek için `send` içine bir dal eklemek yeterli.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class EmailNotConfiguredError extends Error {}

function provider() {
  return (process.env.EMAIL_PROVIDER || "console").toLowerCase();
}

function fromAddress() {
  return process.env.EMAIL_FROM || "Astro <noreply@example.com>";
}

async function sendViaResend(msg: EmailMessage) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new EmailNotConfiguredError("RESEND_API_KEY tanımlı değil.");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`E-posta gönderilemedi (${res.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * E-postayı gönderir.
 * Konsol modunda gerçek gönderim yapılmaz; içerik loglanır.
 */
export async function sendEmail(msg: EmailMessage) {
  switch (provider()) {
    case "resend":
      await sendViaResend(msg);
      return { sent: true, provider: "resend" };

    case "console":
    default:
      // Geliştirme modu — bağlantıyı terminalden kopyalayıp akışı test edebilirsin
      console.log("\n--- E-POSTA (konsol modu, gerçekten gönderilmedi) ---");
      console.log("Kime:", msg.to);
      console.log("Konu:", msg.subject);
      console.log(msg.text);
      console.log("--- son ---\n");
      return { sent: false, provider: "console" };
  }
}

export function isEmailConfigured() {
  return provider() !== "console";
}

/* ------------------------------ şablonlar ------------------------------ */

export function passwordResetEmail(resetUrl: string, expiresInMinutes: number): Omit<EmailMessage, "to"> {
  const text = `Astro hesabın için şifre sıfırlama isteği aldık.

Yeni şifre belirlemek için bu bağlantıyı kullan:
${resetUrl}

Bağlantı ${expiresInMinutes} dakika boyunca geçerli ve yalnızca bir kez kullanılabilir.

Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.`;

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0F0D22;color:#F3F1FA;border-radius:16px">
  <p style="font-size:22px;margin:0 0 20px">✦ Astro</p>
  <p style="line-height:1.6;color:#C9C4DE">Astro hesabın için şifre sıfırlama isteği aldık.</p>
  <p style="margin:26px 0">
    <a href="${resetUrl}" style="display:inline-block;background:#7C5CFC;color:#fff;text-decoration:none;padding:13px 26px;border-radius:12px;font-weight:600">Yeni şifre belirle</a>
  </p>
  <p style="line-height:1.6;color:#9993B8;font-size:13px">Bağlantı ${expiresInMinutes} dakika boyunca geçerli ve yalnızca bir kez kullanılabilir.</p>
  <p style="line-height:1.6;color:#9993B8;font-size:13px">Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.</p>
</div>`;

  return { subject: "Astro — şifre sıfırlama", text, html };
}
