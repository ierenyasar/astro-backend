import fs from "fs";
import path from "path";

/**
 * Şifre sıfırlama sayfası testleri.
 *
 * Sayfa saf HTML/JS olduğu için tarayıcı olmadan çalıştırılamaz; bunun yerine
 * güvenlik açısından kritik davranışların kodda BULUNDUĞU doğrulanır.
 * Bunlar gözden kaçarsa fark edilmesi zor açıklar oluşur.
 */

const html = fs.readFileSync(path.join(__dirname, "..", "public", "sifre-sifirla.html"), "utf8");

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

t("Arama motorlarına kapalı", () => {
  // Sıfırlama sayfası indekslenmemeli
  assert(/noindex/.test(html), "noindex meta etiketi yok");
});

t("Token adres çubuğundan temizleniyor", () => {
  // Token URL'de kalırsa tarayıcı geçmişinde ve paylaşılan ekran görüntülerinde sızabilir
  assert(html.includes("history.replaceState"), "token URL'de bırakılıyor");
});

t("Token yoksa form gösterilmiyor", () => {
  assert(/if \(!token\)[\s\S]{0,120}invalidView/.test(html), "token yokken form gösteriliyor");
});

t("Şifre en az 8 karakter kontrolü var", () => {
  assert(/length >= 8/.test(html), "uzunluk kontrolü yok");
});

t("Şifre tekrarı doğrulanıyor", () => {
  assert(/p === c|password\.value === confirm\.value/.test(html), "şifre tekrarı kontrolü yok");
});

t("Doğru uca istek atıyor", () => {
  assert(html.includes("/auth/reset-password"), "yanlış veya eksik endpoint");
});

t("Şifre alanları gizli tipte", () => {
  const passwordInputs = html.match(/type="password"/g) || [];
  assert(passwordInputs.length >= 2, "şifre alanları düz metin olarak görünüyor");
});

t("Tarayıcıya şifre önerisi bildiriliyor", () => {
  assert(html.includes('autocomplete="new-password"'), "autocomplete ipucu yok");
});

t("Rate limit yanıtı (429) ele alınıyor", () => {
  assert(html.includes("429"), "çok fazla deneme durumu kullanıcıya açıklanmıyor");
});

t("Ağ hatası kullanıcıya anlatılıyor", () => {
  assert(/Bağlantı kurulamadı/.test(html), "ağ hatası mesajı yok");
});

t("Süresi dolmuş bağlantı ayrı ele alınıyor", () => {
  assert(/invalidView/.test(html) && /süresi/i.test(html), "geçersiz token durumu yok");
});

t("Başarıdan sonra kullanıcı yönlendiriliyor", () => {
  assert(/Profil|giriş yap/i.test(html), "sonraki adım anlatılmıyor");
});

t("Sayfa şifreyi hiçbir yere loglamıyor", () => {
  assert(!/console\.log\([^)]*password/i.test(html), "şifre konsola yazılıyor");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
