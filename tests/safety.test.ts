import { checkUserMessage, checkAiOutput, countCliches } from "../src/lib/safety";

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

/* ---------------- kriz tespiti: en kritik bölüm ---------------- */

t("İntihar ifadesi engellenir ve destek yanıtı döner", () => {
  const r = checkUserMessage("intihar etmeyi düşünüyorum");
  assert(r.blocked === true, "ENGELLENMEDİ — AI'ya gidecekti");
  assert(r.category === "self_harm", "yanlış kategori");
  assert(!!r.response, "destek yanıtı yok");
});

t("Destek yanıtı acil yardım bilgisi içerir", () => {
  const r = checkUserMessage("artık dayanamıyorum");
  assert(r.blocked === true, "engellenmedi");
  assert(r.response!.includes("112"), "acil yardım numarası yok");
});

t("Destek yanıtı astrolojik yorum İÇERMEZ", () => {
  const r = checkUserMessage("ölmek istiyorum");
  const text = r.response!.toLowerCase();
  assert(!text.includes("burç"), "kriz anında burç yorumu veriliyor");
  assert(!text.includes("yıldızlar sana"), "kriz anında astroloji vaadi veriliyor");
  assert(!text.includes("gezegen"), "kriz anında gezegen yorumu veriliyor");
});

t("Türkçe karakter varyasyonları yakalanır", () => {
  // Kullanıcı aksansız yazabilir; filtre kaçırmamalı
  assert(checkUserMessage("intihar").blocked, "aksanlı hali kaçtı");
  assert(checkUserMessage("INTIHAR ETMEK").blocked, "büyük harf kaçtı");
  assert(checkUserMessage("kendime zarar vermek istiyorum").blocked, "kendine zarar kaçtı");
  assert(checkUserMessage("yaşamak istemiyorum").blocked, "yaşamak istemiyorum kaçtı");
});

t("Cümle içinde geçse de yakalanır", () => {
  const r = checkUserMessage("bu hafta çok kötüydüm ve ölmek istiyorum galiba");
  assert(r.blocked === true, "cümle içinde kaçtı");
});

/* ---------------- ölüm öngörüsü ---------------- */

t("Ölüm zamanı sorusu cevaplanmaz", () => {
  const r = checkUserMessage("ne zaman öleceğim");
  assert(r.blocked === true, "ölüm öngörüsü sorusu AI'ya gidiyor");
});

t("Ölüm yanıtı kesin iddia içermez", () => {
  const r = checkUserMessage("kaç yaşında öleceğim");
  assert(r.blocked === true, "engellenmedi");
  assert(r.response!.toLowerCase().includes("doğru olmaz"), "reddetme gerekçesi yok");
});

/* ---------------- tıbbi sorular ---------------- */

t("İlaç bırakma sorusu engellenir", () => {
  const r = checkUserMessage("ilacımı bıraksam mı");
  assert(r.blocked === true, "tehlikeli tıbbi soru AI'ya gidiyor");
  assert(r.category === "medical", "yanlış kategori");
});

t("Tıbbi yanıt doktora yönlendirir", () => {
  const r = checkUserMessage("hastalığım geçecek mi");
  assert(r.blocked === true, "engellenmedi");
  assert(r.response!.toLowerCase().includes("doktor"), "profesyonele yönlendirme yok");
});

/* ---------------- yanlış pozitif olmamalı ---------------- */

t("Normal astroloji soruları engellenmez", () => {
  const normal = [
    "bu ay aşk hayatım nasıl olacak",
    "iş değiştirmeli miyim",
    "eski sevgilimi neden düşünüyorum",
    "bu hafta neye odaklanmalıyım",
    "yükselen burcum ne anlama geliyor",
    "partnerimle uyumlu muyuz",
  ];
  for (const m of normal) {
    const r = checkUserMessage(m);
    assert(r.blocked === false, `normal soru engellendi: "${m}"`);
  }
});

t("'öl' içeren masum kelimeler engellenmez", () => {
  // "ölçü", "bölüm", "gönül" gibi kelimeler yanlışlıkla yakalanmamalı
  const r = checkUserMessage("hayatımda bir bölüm kapanıyor gibi hissediyorum");
  assert(r.blocked === false, "masum cümle engellendi");
});

/* ---------------- çıktı doğrulama ---------------- */

t("Ölüm öngörüsü içeren çıktı reddedilir", () => {
  const r = checkAiOutput("Bu dönem öleceksin, dikkatli ol.");
  assert(r.safe === false, "ölüm öngörüsü kullanıcıya gidecekti");
});

t("Hastalık iddiası içeren çıktı reddedilir", () => {
  assert(checkAiOutput("Haritanda kanser belirtisi görünüyor.").safe === false, "hastalık iddiası geçti");
});

t("Tedavi müdahalesi içeren çıktı reddedilir", () => {
  assert(checkAiOutput("İlacını bırakman gerektiğini gösteriyor.").safe === false, "tedavi müdahalesi geçti");
});

t("Yatırım tavsiyesi içeren çıktı reddedilir", () => {
  assert(checkAiOutput("Bu ay bitcoin al, kazanacaksın.").safe === false, "yatırım tavsiyesi geçti");
  assert(checkAiOutput("Altın alım için iyi bir dönem.").safe === false, "yatırım tavsiyesi geçti");
});

t("Kesinlik iddiası içeren çıktı reddedilir", () => {
  assert(
    checkAiOutput("Bu ay kesinlikle olacak bir şey var.").safe === false,
    "kesinlik iddiası geçti"
  );
});

t("Hukuki öngörü içeren çıktı reddedilir", () => {
  assert(checkAiOutput("Davayı kazanacaksın, endişelenme.").safe === false, "hukuki öngörü geçti");
});

t("Normal yorum çıktısı geçer", () => {
  const good =
    "Venüs'ün konumu bu hafta ilişkilerinde daha açık bir iletişimi destekliyor. " +
    "Astrolojik açıdan bakıldığında, söylemediğin bir şey varsa bunun için uygun bir dönem olabilir.";
  assert(checkAiOutput(good).safe === true, "iyi yorum reddedildi");
});

/* ---------------- klişe ölçümü ---------------- */

t("Klişe kalıplar sayılır", () => {
  assert(countCliches("Bugün harika bir gün! Evrene güven.") >= 2, "klişeler sayılmadı");
});

t("Spesifik yorumda klişe bulunmaz", () => {
  const specific =
    "Merkür'ün Başak'taki konumu, detaylara takılma eğilimini artırabilir. " +
    "Bir işi bitirmeden mükemmelleştirmeye çalışmak bu hafta seni yorabilir.";
  assert(countCliches(specific) === 0, "spesifik metinde klişe bulundu");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
