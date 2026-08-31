# Astro Backend

Node.js + TypeScript + Fastify + Prisma (PostgreSQL) + Anthropic Claude API.

## Kurulum

```bash
cd astro-backend
npm install
cp .env.example .env
```

`.env` dosyasını doldur:
- `DATABASE_URL` — kendi PostgreSQL adresin (yerelde Postgres kurulu değilse aşağıdaki Docker komutunu kullanabilirsin)
- `JWT_SECRET` — uzun, rastgele bir string
- `ANTHROPIC_API_KEY` — https://console.anthropic.com/ üzerinden alınır

Hızlı yerel PostgreSQL (Docker varsa):
```bash
docker run --name astro-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=astro -p 5432:5432 -d postgres:16
```
Bu durumda `.env`: `DATABASE_URL="postgresql://postgres:password@localhost:5432/astro?schema=public"`

## Veritabanını kur

```bash
npx prisma generate
npx prisma migrate dev --name init
```

## Çalıştır

```bash
npm run dev
```

Sunucu `http://localhost:3000` adresinde ayağa kalkar. `GET /health` ile kontrol edebilirsin.

## Expo uygulamasına bağlama

`astro-app-expo/services/ai.js` içinde:
```js
export const API_BASE_URL = "http://SENIN-IP-ADRESIN:3000";
```
(Telefonundan test ediyorsan `localhost` çalışmaz — bilgisayarının yerel ağ IP'sini kullan, örn. `192.168.1.x`.)

Ayrıca mobil uygulamada auth flow'u henüz login/register ekranına bağlanmadı — şu an backend JWT bekliyor ama uygulama henüz token göndermiyor. Bir sonraki adım: onboarding sonunda `/auth/register` çağrısı yapıp token'ı güvenli şekilde saklamak (örn. `expo-secure-store`).

## Uygulanan endpointler

```
POST   /auth/anonymous             — e-posta istemeden hesap açar, JWT döner (uygulama ilk açılışta kullanır)
GET    /auth/me                     — oturum durumu (anonim mi, bağlı mı)
POST   /auth/forgot-password        — sıfırlama bağlantısı gönderir
POST   /auth/reset-password         — token ile yeni şifre belirler
POST   /auth/link-email             — anonim hesabı e-postaya bağlar (userId korunur)
POST   /auth/register              — kayıt, JWT döner
POST   /auth/login                 — giriş, JWT döner
GET    /user/profile                — profil + doğum bilgisi
PUT    /user/profile                — profil güncelle
GET    /user/export                  — tüm verileri dışa aktar (KVKK/GDPR)
DELETE /user/account                 — hesabı ve tüm verileri sil
GET    /astrology/cities            — desteklenen şehir listesi (şehir arama için)
POST   /astrology/chart             — doğum bilgisiyle GERÇEK chart hesapla ve kaydet
GET    /astrology/chart             — kayıtlı chart'ı getir
GET    /astrology/daily-scores      — günlük alan puanları (transit bazlı, kota harcamaz)
POST   /readings/:category          — daily|love|career|money|weekly|monthly (cache'li, JWT gerekli)
GET    /readings/today              — bugün ZATEN üretilmiş yorumlar (üretim tetiklemez)
GET    /readings/history            — geçmiş yorumlar
POST   /readings/:id/favorite       — yorumu favorile
GET    /readings/favorites          — kaydedilen yorumlar
POST   /ai/chat                     — Ask the Stars (conversation memory ile)
GET    /ai/chat/:sessionId/messages — bir sohbetin mesajları
POST   /compatibility               — uyum analizi
POST   /analytics/events            — event gönderimi (toplu)
GET    /internal/analytics/summary  — huni metrikleri (x-analytics-secret)

POST   /notifications/register      — cihaz push token'ı kaydet
POST   /notifications/test          — kendine test bildirimi gönder
POST   /internal/notifications/broadcast — toplu bildirim (x-admin-secret)
GET    /notifications/settings      — bildirim ayarları
PUT    /notifications/settings      — aç/kapat, saat değiştir
DELETE /notifications/register      — cihazı çıkar
POST   /internal/cron/daily-notifications — harici cron tetikleyici (x-cron-secret)

GET    /subscription                — abonelik durumu + isPremium
POST   /subscription/verify         — Apple/Google sunucusuna GERÇEK doğrulama
POST   /subscription/webhook/:provider — mağaza bildirimleri (henüz işlenmiyor)
```

Tüm route'lar (auth hariç) `Authorization: Bearer <token>` header'ı bekler.

## Astroloji motoru (gerçek efemeris)

`circular-natal-horoscope-js` (tropical zodiac, Placidus ev sistemi) kullanılıyor. Hesaplananlar:
Güneş, Ay, Yükselen, Merkür, Venüs, Mars, Jüpiter, Satürn, Uranüs, Neptün, Plüton (burç + ev + retro durumu), 12 ev ve major açılar.

**Uyum (sinastri):** İki haritanın gezegenleri arasındaki açılardan hesaplanır. Daha önce
isim+tarih string'inin hash'inden üretiliyordu — astrolojiyle ilgisi yoktu. Alan eşlemesi:
iletişim → Merkür/Ay, duygusal bağ → Ay/Güneş, kimya → Venüs/Mars, uzun vade → Satürn/Güneş/Jüpiter.

**Günlük puanlar:** Ana ekrandaki enerji/aşk/kariyer/para yıldızları, kullanıcının doğum
haritasındaki gezegen dereceleri ile o günün transit konumları arasındaki açılardan hesaplanır
(uyumlu açılar puanı yükseltir, sert açılar düşürür). Kullanıcıya ve güne göre değişir, gün
içinde sabit kalır. AI çağrısı yapmaz.

**Saat dilimi:** Kütüphane verilen saati doğum yerinin yerel saati olarak yorumlar ve koordinattan
saat dilimini kendisi çözer — tarihsel DST kuralları dahil (Türkiye 2010'da kışın UTC+2, yazın UTC+3;
New York'ta yazın EDT). Ayrıca offset uygulamak **gerekmez**, uygulanırsa çift dönüşüm olur.
Testlerle doğrulandı: İstanbul 19:30 ile Londra 17:30 aynı Güneş derecesini veriyor.

Doğum saati bilinmiyorsa:
- Yükselen ve evler hesaplanmaz (`null` döner), API `meta.housesAvailable: false` bildirir.
- Ay burcu öğlen 12:00 varsayımıyla hesaplanır ama gün içinde değişebileceği için `meta.moonUncertain: true` işaretlenir ve UI'da kullanıcıya belirtilir.

`npx tsx tests/astrology.test.ts` ile 13 testin tamamı çalışır durumda.

## Kullanım limitleri (AI maliyet + abuse koruması)

**Uyum analizi de kotalı:** Daha önce `/compatibility` yalnızca "premium mi?"
kontrolü yapıyordu — premium bir hesap günde sınırsız uyum analizi isteyebilir,
her biri bir AI çağrısı demekti (maliyet tavanı yoktu). Artık günde 15 ile
sınırlı, aynı advisory lock korumasıyla (bkz. aşağıda). Kota dolduğunda dönen
`upgradeRequired: false` sayesinde zaten premium olan kullanıcıya yanlışlıkla
"yükselt" mesajı gösterilmiyor — mobil taraf bunu otomatik ayırt ediyor.

**Yarış durumu koruması:** Kota kontrolü ("bugün kaç yorum ürettin?") ile kaydın
yazılması arasındaki boşluğa aynı kullanıcıdan paralel bir istek girerse, kilit
olmadan ikisi de "henüz limite ulaşmadın" görüp AI çağrısı yapabilirdi — free
kullanıcı günde 1 hakkına sahipken paralel isteklerle (örn. 4 kategoriyi aynı anda
açmak) 4 yorum üretebilirdi. `src/lib/lock.ts` bir Postgres advisory lock ile
aynı kullanıcının isteklerini sıraya sokuyor; farklı kullanıcılar birbirini
beklemiyor. `tests/integration.test.ts` içinde 4 paralel istek göndererek
yalnızca 1'inin başarılı olduğunu doğrulayan bir test var (gerçek DB gerektirir).

`src/lib/limits.ts` — limitler BACKEND'de zorlanır, client'ın iddiasına asla güvenilmez:

| | Free | Premium |
|---|---|---|
| Günlük yeni yorum | 1 | 30 |
| Günlük chat mesajı | 5 | 200 |
| Uyum analizi | ✕ | ✓ (günde 15) |

Cache'ten dönen yorumlar kotadan düşmez (kullanıcı kendi yorumunu tekrar açabilir). Limit aşılınca API `402` + `upgradeRequired: true` döner, mobil uygulama bunu paywall'a çevirir.

## Abonelik doğrulama (gerçek)

`/subscription/verify` artık satın almayı doğrudan mağazanın sunucusuna doğrulatır:
- **Apple**: App Store Server API (`/inApps/v1/subscriptions/...`), ES256 JWT ile kimlik doğrulama
- **Google**: Play Developer API (`purchases.subscriptionsv2`), service account ile

Güvenlik davranışı:
- Premium durumu **sadece** mağazanın yanıtına göre yazılır; client'ın iddiası hiçbir şekilde dikkate alınmaz.
- Aynı `purchaseToken` başka bir hesaba bağlıysa `409` ile reddedilir (tek satın almayı çok hesaba yayma engellenir).
- Env değişkenleri tanımlı değilse endpoint `503` döner ve **hiç kimse premium olamaz** — yapılandırılmamış doğrulama, açık kapı bırakmak yerine özelliği kapatır.

## Geocoding (gerçek)

`src/lib/geo.ts` üç katmanlı çalışır: yerleşik şehir listesi → veritabanı cache'i → Nominatim (OpenStreetMap) API.
Negatif sonuçlar da cache'lenir, böylece hatalı aramalar tekrar tekrar dış servise gitmez. Nominatim'in
saniyede 1 istek sınırı için throttle uygulanır. Mobil uygulama koordinatı doğrudan gönderdiğinde
geocoding'e hiç gidilmez.

## Mağaza bildirimleri (webhook)

Abonelik iptali, yenilenmesi veya ödeme hatası artık mağazadan anlık olarak alınır — kullanıcının
uygulamayı açmasını beklemeye gerek yok.

- `POST /subscription/webhook/apple` — App Store Server Notifications V2. `signedPayload` JWS'i,
  x5c sertifika zinciri Apple Root CA'ya kadar doğrulanarak kontrol edilir.
- `POST /subscription/webhook/google` — Play RTDN (Pub/Sub push). İsteğin OIDC token'ı doğrulanır
  ve beklenen service account'tan geldiği kontrol edilir.

Her iki uçta da **imza/kimlik doğrulanmadan hiçbir abonelik durumu güncellenmez**; doğrulanamayan
istek `401` ile reddedilir. `tests/webhook.test.ts` sahte sertifika zinciri ve kendi anahtarıyla
imzalanmış bildirim senaryolarını test eder (18 test).

Grace period davranışı bilinçli: ödeme başarısız olsa da Apple/Google grace period tanıdığında
erişim sürer; kullanıcı iptal ettiğinde durum hemen değişmez çünkü `currentPeriodEnd` zaten
dönem sonunda erişimi kapatır.

## Push bildirimleri

Expo Push API üzerinden günlük hatırlatma. `src/jobs/daily-notifications.ts` saatte bir çalışır
ve o an **yerel saati** kullanıcının tercih ettiği saate eşit olan cihazlara gönderir — herkese
aynı UTC saatinde göndermek kullanıcının gecesine denk gelirdi.

Spam koruması (madde 17):
- Kullanıcıya günde en fazla 1 hatırlatma
- Bugün yorumunu **zaten okuduysa** bildirim gönderilmez (okumuş kullanıcıyı dürtmek spam)
- Bildirim metinleri rotasyonlu, hep aynı cümle gitmiyor
- Kullanıcı ayarlardan kapatabilir ve saatini değiştirebilir

`DeviceNotRegistered` dönen token'lar (uygulama silinmiş) otomatik devre dışı bırakılır; ağ
hatası token'ı suçlamaz, bir sonraki turda tekrar denenir.

**Toplu bildirim:** `POST /internal/notifications/broadcast` ile duyuru gönderilir
(`x-admin-secret` ile korunur — kullanıcı token'ı yetmez). Varsayılan olarak yalnızca
önizleme döner; gerçekten göndermek için `confirm: true` gerekir. Yanlışlıkla tüm kitleye
mesaj atmayı zorlaştırmak için bilinçli iki adımlı. Hedef kitle `all | premium | free`
seçilebilir; bildirimi kapatmış kullanıcılar hiçbir koşulda dahil edilmez.

**Ölçekleme:** dahili `setInterval` tek sunucu içindir. Çok instance'ta her biri aynı işi
tetikler ve kullanıcı mükerrer bildirim alır — `DISABLE_NOTIFICATION_SCHEDULER=true` yapıp
platformun cron'undan `POST /internal/cron/daily-notifications` ucunu çağır (`x-cron-secret` ile korunur).

## Şifre sıfırlama

`POST /auth/forgot-password` → e-posta ile bağlantı, `POST /auth/reset-password` → yeni şifre.

Güvenlik kararları:
- Token'ın **kendisi değil SHA-256 özeti** saklanır; veritabanı sızarsa token'lar kullanılamaz.
- Tek kullanımlık ve 60 dakika geçerli; yeni istek eski token'ları geçersiz kılar.
- `forgot-password` e-posta kayıtlı olsun olmasın **aynı yanıtı** döner — aksi halde bu uç
  hangi e-postaların sistemde olduğunu öğrenmek için kullanılabilirdi.
- Anonim hesaplara (sahte e-posta) sıfırlama yapılamaz.
- Sıfırlama sonrası `sessionsValidFrom` güncellenir ve **mevcut tüm JWT'ler geçersizleşir** —
  hesabı ele geçiren biri varsa şifre değişimi onu da dışarı atar. Token'lar durumsuz olduğu
  için sunucu onları başka türlü iptal edemezdi.
- `forgot-password` 15 dakikada 3, `reset-password` ve `login` 10 istekle sınırlı.

**Sıfırlama sayfası:** `public/sifre-sifirla.html` backend tarafından `/sifre-sifirla`
adresinden sunulur — ayrı bir web sitesi kurmana gerek yok. `PASSWORD_RESET_URL`'i
`https://SENIN-BACKEND/sifre-sifirla` olarak ayarlaman yeterli.

**E-posta sağlayıcısı:** `EMAIL_PROVIDER` ile seçilir (`resend` veya `console`).
Yapılandırılmazsa bağlantı yalnızca konsola yazılır ve uyarı loglanır — geliştirmede akışı
test edebilirsin ama production'da gerçek sağlayıcı gerekir.

## Girdi uzunluk sınırları (AI maliyet + dış API kötüye kullanımı koruması)

`firstName`, `focusArea`, chat mesajı ve `partnerName` gibi alanlar **her AI prompt'una
doğrudan gömülür** (bkz. `buildContext`). Daha önce bu alanların çoğunda üst sınır yoktu —
kullanıcı devasa bir isim girip her sonraki yorum/sohbet/uyum çağrısını şişirebilir,
gereksiz token maliyeti oluşturabilirdi. `birthCity` gibi alanlar ise doğrudan Nominatim'e
(dış geocoding servisi) gönderilir; sınırsız bırakılırsa dış API'yi kötüye kullanmanın
veya bizi hız sınırlamasına maruz bırakmanın bir yolu olurdu.

Tüm bu alanlara `.max()` sınırı eklendi — isim 50, şehir 100, chat mesajı 2000, e-posta 254
(RFC 5321), şifre 128, şifre sıfırlama token'ı 256, mağaza satın alma token'ı 1000 karakter.
E-posta özellikle önemliydi: Zod'un `.email()` formatı doğrular ama uzunluğu SINIRLAMAZ —
`.max()` olmadan "a"×10000+"@x.com" geçerli bir e-posta gibi geçebilirdi. `tests/input-bounds.test.ts`
bu sınırların route dosyalarında gerçekten var olduğunu ve Zod'un gerçekten reddettiğini doğrular.

## AI güvenlik katmanı

Sistem prompt'u modele ne yapmaması gerektiğini *söyler* ama garanti etmez.
`src/lib/safety.ts` iki yönde çalışır:

**Girdi tarafı** — kullanıcı kriz, intihar, ölüm öngörüsü veya tıbbi konuda yazdıysa:
- AI'ya **hiç gidilmez** (bir astroloji uygulamasının "yıldızlara göre iyileşeceksin" demesi tehlikelidir)
- **Kotadan düşülmez** — destek isteyen kullanıcı cezalandırılmamalı
- Destekleyici, profesyonel yardıma yönlendiren bir yanıt döner (kriz durumunda 112)
- Yanıt uygulamada görsel olarak ayrışır; astroloji yorumu gibi görünmez

**Çıktı tarafı** — model yine de yasak bir iddiada bulunursa yakalanır: ölüm öngörüsü,
hastalık iddiası, tedavi müdahalesi, yatırım tavsiyesi, kesinlik iddiası, hukuki öngörü.
Yorumlarda bu durum **DB'ye yazılmadan** yakalanır ve kota harcanmaz.

Ayrıca klişe kalıplar sayılıp loglanır (madde 36) — engellenmez, kalite zamanla izlensin diye ölçülür.

`tests/safety.test.ts` 20 test: kriz senaryoları, Türkçe karakter varyasyonları,
yanlış pozitif kontrolü ("bölüm" gibi masum kelimeler engellenmemeli) ve çıktı doğrulama.

## Analytics

`src/lib/analytics-events.ts` event adlarının tek doğruluk kaynağıdır — serbest string
göndermek zamanla `paywall_view` / `paywall_viewed` / `viewPaywall` gibi üç ayrı isme
yol açar ve veriyi kullanılamaz hale getirir.

**Gizlilik:** doğum tarihi/saati/yeri, koordinat, isim, e-posta, token ve sohbet içeriği
analitiğe **yazılmaz** — `sanitizeProperties` bunları düşürür (büyük/küçük harf ve gömülü
anahtar adları dahil). Mobil taraf da göndermez; iki katmanlı koruma.

Kullanıcı hesabını silerse eventlerin `userId` alanı `SetNull` ile boşalır — kişisel bağ
kopar ama toplam metrikler bozulmaz.

`GET /internal/analytics/summary?days=7` (x-analytics-secret ile korumalı) şu huni
metriklerini döndürür: onboarding tamamlanma oranı, paywall→satın alma dönüşümü,
kota dolumu→paywall oranı ve premium kullanıcı payı.

## Hesap modeli

Uygulama ilk açılışta e-posta sormadan anonim bir hesap açar (sürtünmesiz onboarding).
Kullanıcı dilediğinde `/auth/link-email` ile bu hesabı bir e-postaya bağlar.

**Kritik davranış:** bağlama sırasında yeni hesap AÇILMAZ, mevcut kaydın kimliği güncellenir.
Böylece doğum haritası, yorumlar, sohbetler ve özellikle **abonelik** aynı `userId` altında kalır.
Yeni hesap açılsaydı kullanıcı ödediği aboneliği kaybederdi.

Yeni cihazda giriş yapıldığında, o cihazda otomatik açılmış boş anonim hesap temizlenir —
ama yalnızca gerçekten boşsa (yorum/sohbet/abonelik yoksa). Temizlik isteği ham `userId`
ile değil, **doğrulanan bir JWT** ile yapılır; aksi halde bir istemci başkasının hesabının
silinmesini isteyebilirdi.

## CI (GitHub Actions)

`.github/workflows/ci.yml` her push/PR'da:
- Typecheck + 152 birim testi (DB gerektirmez)
- Entegrasyon testleri (gerçek PostgreSQL servis konteyneriyle)

Entegrasyon job'ı `postgres:16` servis konteyneri kullanır, migration'ları uygulayıp
`tests/integration.test.ts`'i gerçek bir veritabanına karşı çalıştırır. AI çağrısı
gerektiren testler `ANTHROPIC_API_KEY` secret'ı yoksa kendini atlar.

Dağıtım (`preflight`) job'ı bilinçli olarak yorum satırında bırakıldı — yalnızca
gerçek production ortam değişkenleri (secrets) tanımlandığında anlamlıdır.

## Dağıtım öncesi denetim

```bash
npm run preflight
```

Yayına çıkmadan önce yapılandırmayı denetler: eksik/zayıf `JWT_SECRET`, yapılandırılmamış
mağaza doğrulaması (kimse premium olamaz), `EMAIL_PROVIDER=console` (şifre sıfırlama
e-postası gitmez), production'da `CORS_ORIGIN=*`, uygulanmamış migration, ulaşılamayan
veritabanı veya Anthropic API. Hata varsa çıkış kodu 1 döner, CI'a bağlanabilir.

Bu kontrollerin çoğu kod hatası gibi görünmeyen ama kullanıcıya ulaşan sorunları yakalar.

## Kimliksiz uçlarda dedike rate limit

`/auth/anonymous` ve `/auth/register` her çağrıda `bcrypt.hash()` çalıştırır (bilinçli
olarak yavaş bir fonksiyon) ve bir DB satırı yazar — kimlik doğrulaması olmadan. Genel
100/dk limiti bunlar için yeterince sıkı değildi; saldırgan bu uçları spam'leyerek hem
DB'yi şişirebilir hem sunucunun CPU'sunu bcrypt hesaplamalarıyla doyurabilirdi.

`/astrology/cities` de kimliksizdir ve yerleşik listede eşleşme yoksa dış bir servise
(Nominatim) istek atar — dedike limit olmadan, rastgele string'lerle spam atarak dış
API'yi kötüye kullanmanın veya bizi Nominatim'in hız sınırına düşürüp **tüm kullanıcıların**
şehir aramasını yavaşlatmanın bir yolu olurdu.

| Uç | Limit |
|---|---|
| `POST /auth/anonymous` | 20/dk |
| `POST /auth/register` | 10/15dk |
| `GET /astrology/cities` | 30/dk |
| `POST /subscription/webhook/apple` | 60/dk |
| `POST /subscription/webhook/google` | 60/dk |

İki webhook ucu da ayrıca eklendi: imza doğrulaması (X.509 sertifika zinciri / OIDC
token) GEÇERSİZLİĞİ TESPİT ETMEK İÇİN BİLE çalıştırılması gereken CPU-yoğun bir
işlemdir — "önce doğrula sonra reddet" akışı ucuza savuşturulamaz, dedike limit
olmadan rastgele gövdelerle spam atarak CPU tüketilebilirdi.

`tests/rate-limits.test.ts` beş limitin de tam olarak yapılandırılan eşikte
devreye girdiğini doğrular (bellek içi Prisma taklidiyle, DB gerektirmez).

## HTTP gövde boyutu sınırı

Fastify'ın örtük varsayılanı (1MB) yerine `bodyLimit: 256KB` açıkça belirtildi — hiçbir uç
bundan büyük bir gövdeye ihtiyaç duymuyor (en büyüğü ~2000 karakterlik chat mesajı). Bunun
üzerindeki istekler `413` ile reddedilir. Test edilerek doğrulandı.

## Testler

`tests/analytics-sync.test.ts` mobil projeyi de okur (varsayılan yol: `../astro-app-expo`,
`MOBILE_PROJECT_PATH` ile değiştirilebilir). Mobil proje yoksa test atlanır.

Bu test **sessiz hata sınıflarını** yakalar: mobilde tanımsız bir event sabiti kullanmak
(`EVENTS.FOO` → undefined → event hiç gönderilmez) veya tanımsız bir stile referans vermek
(React Native sessizce yok sayar, bileşen stilsiz çizilir). İkisi de hata mesajı üretmediği
için gözden kaçar; ikisi de bir kez yaşandı.

```bash
npm test              # 152 test — DB gerektirmez
npm run typecheck
```

| Dosya | Kapsam | Adet |
|---|---|---|
| `tests/astrology.test.ts` | Efemeris, saat dilimi/DST, evler, **günlük puanlar, sinastri** | 30 |
| `tests/webhook.test.ts` | Sahte sertifika zinciri, sahte imza, mağaza bildirim eşlemeleri | 18 |
| `tests/limits.test.ts` | Kota mantığı, premium tespiti, **kullanıcılar arası izolasyon** | 18 |
| `tests/push.test.ts` | Saat dilimi doğruluğu, mükerrer bildirim koruması, metin çeşitliliği | 13 |
| `tests/analytics.test.ts` | **Kişisel veri sızıntısı**, event şeması tutarlılığı | 16 |
| `tests/safety.test.ts` | **Kriz/tıbbi içerik filtresi**, yasak çıktı tespiti | 20 |
| `tests/password-reset.test.ts` | Token özetleme, tek kullanım, **oturum geçersizleştirme** | 16 |
| `tests/reset-page.test.ts` | Sıfırlama sayfası güvenlik davranışları | 13 |
| `tests/analytics-sync.test.ts` | Mobil↔backend event uyumu, tanımsız stil/sabit | 8 |
| `tests/input-bounds.test.ts` | AI prompt'una gömülen/dış API'ye giden/public uçlardaki alanların uzunluk sınırı | 15 |
| `tests/rate-limits.test.ts` | Kimliksiz, kaynak-yoğun uçların dedike rate limit'i (auth, geocoding, webhook) | 5 |

`tests/limits.test.ts` bellek içi bir Prisma taklidi kullanır (`tests/mock-prisma.ts`) — DB
kurmadan mantığı doğrular ama Prisma'nın kendi sorgu üretimindeki bir hatayı yakalayamaz.

### Entegrasyon testleri (gerçek PostgreSQL gerekir)

```bash
createdb astro_test
DATABASE_URL="postgresql://.../astro_test" npx prisma migrate deploy
DATABASE_URL="postgresql://.../astro_test" npm run test:integration
```

Kapsam: auth (bcrypt hash doğrulaması, sahte JWT reddi), yetkilendirme, **kullanıcı izolasyonu**
(A'nın yorumu/sohbeti/haritası B'ye sızmamalı), hesap bağlama (abonelik korunuyor mu),
doğum bilgisi güncelleme (harita yeniden hesaplanıyor mu, mükerrer kayıt oluşuyor mu),
günlük puanlar, uyum analizi (premium kilidi + puanların haritaya bağlı olması),
sahte satın alma reddi, doğrulanmamış webhook reddi ve hesap silmede tüm verilerin
temizlenmesi (KVKK/GDPR).

AI çağrısı yapan uçlar bilinçli olarak test edilmez — gerçek API'ye istek atıp para harcar.

## Bilinçli bırakılan eksikler / TODO

- **Entegrasyon testleri çalıştırılmadı** — bu ortamda PostgreSQL yok. Yerelde `npm run test:integration` ile çalıştırıp doğrulaman gerekir.
- AI yanıt kalitesi için otomatik test yok (klişe tespiti, disclaimer kontrolü gibi).

## Proje yapısı

```
src/
  server.ts              → Fastify app, plugin kayıtları
  lib/prisma.ts           → Prisma client singleton
  lib/anthropic.ts         → Claude API çağrı katmanı
  lib/astrology.ts          → gerçek efemeris hesaplaması (circular-natal-horoscope-js)
  lib/geo.ts                 → geocoding (yerleşik liste + DB cache + Nominatim)
  lib/verify-apple.ts         → Apple App Store Server API doğrulaması
  lib/verify-google.ts         → Google Play Developer API doğrulaması
  lib/limits.ts               → free/premium kota kontrolü
  lib/push.ts                  → Expo push gönderimi + zamanlama yardımcıları
  lib/analytics-events.ts       → event şeması + kişisel veri temizleme
  lib/safety.ts                  → kriz tespiti + AI çıktı doğrulama
  lib/email.ts                    → e-posta gönderimi (sağlayıcıdan bağımsız)
  jobs/daily-notifications.ts   → günlük hatırlatma işi
  middleware/auth.ts        → JWT doğrulama
  prompts/index.ts           → sistem prompt + kategori bazlı prompt template'leri
  routes/                     → auth, user, astrology, readings, chat, compatibility, subscription
public/sifre-sifirla.html      → şifre sıfırlama sayfası (backend sunar)
prisma/schema.prisma          → veritabanı şeması
tests/                          → astrology, webhook, limits (birim) + integration (DB'li)
```
