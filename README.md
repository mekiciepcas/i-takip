# İş Takip v2.5

Bu deponun güncel sürümü `public/` (arayüz) ve `server/` (PostgreSQL API) dizinlerindedir. Yerel kullanım için `public/index.html` açın; sunucu kurulumu aşağıdadır. Kök dizindeki `kaynak/`, `uygulama/`, `assets/` ve `haftalik-rapor-v2.html` önceki sürümün kaynakları olarak korunmuştur.

Mevcut tablo ve yönetici raporu arayüzünün Python/EXE gerektirmeyen sürümü. Uygulama HTML, CSS ve JavaScript kullanır. İki ayrı veri kaynağı vardır; aralarında gizli veya otomatik veri aktarımı yapılmaz.

## 1. Yalnız HTML + JSON

1. Paketi çıkarın. `public/index.html` dosyasını güncel Edge veya Chrome ile açın. `public` içindeki dosyaları birlikte tutun.
2. **JSON klasörünü seç** düğmesine basın, veri dosyalarının bulunduğu klasöre okuma/yazma izni verin.
3. Mevcut İş Takip JSON dosyanızı seçin veya **Yeni dosya** ile `is-takip-v2.5.json` oluşturun. Mevcut dosya aynı adla yeniden oluşturulmaz.
4. Hücreleri düzenleyin. Hücreden çıkınca/Enter'a basınca otomatik kayıt yapılır. Detay paneli ve haftalık not formu kendi Kaydet düğmeleriyle kaydedilir.

Bu modda Python, Node.js, EXE veya veritabanı hizmeti çalışmaz. Sekme açık ve düzenleme boşta iken seçilen JSON yaklaşık üç saniyede bir yeniden okunur. Her yazmadan önce önceki dosyanın tamamı aynı klasörde `yedekler/` altına kopyalanır. Yedekler otomatik silinmez. Klasör izni sonraki açılışta yeniden istenebilir; tarayıcı güvenliği nedeniyle HTML bulunduğu klasörü kendiliğinden okuyamaz. Desteklenmeyen tarayıcıda klasör erişimi yerine sahte kayıt yapılmaz.

**Bu mod tek düzenleyici içindir.** İçerik özetiyle dışarıdan yapılan değişiklikler kontrol edilir, ancak tarayıcı dosya API'si farklı bilgisayarlar arasında veritabanı işlemi/dağıtık kilit sağlamaz. Aynı JSON'u birden fazla kişinin aynı anda düzenlemesi desteklenmez. Ekip çalışması için aşağıdaki PostgreSQL modu kullanılmalıdır. Yedeklerin aynı disk üzerinde olması disk kaybına karşı koruma sağlamaz.

Eski `is-takip.db` JSON değildir. Eski uygulamadaki **JSON yedek indir** ile dışa aktarın. Bu JSON doğrudan yerel modda seçilebilir; PostgreSQL modunda **Yedekten yükle** ile aktarılabilir. Canlı `.db` dosyasının uzantısını `.json` yapmayın. Excel içe/dışa aktarma da korunmuştur.

## 2. Ayrı sunucu + PostgreSQL

Kullanıcılar yalnız web bağlantısını açar. Sunucuda Node.js 22 veya üzeri (önerilen 24 LTS) ve PostgreSQL 17/18 gerekir. Ön yüz PostgreSQL'e doğrudan bağlanmaz; bağlantı bilgileri sunucuda kalır.

```sh
npm ci --omit=dev
```

`.env.example` dosyasını `.env` olarak kopyalayın. Gerçek PostgreSQL bağlantısını, ilk kullanıcı adını ve en az 12 karakterlik benzersiz parolayı ayarlayın. Örneklerdeki `CHANGE_THIS...` değerlerini kullanmayın.

```sh
npm start
```

Yerel geliştirme adresi: `http://localhost:3000`. `APP_ORIGIN` tarayıcıda kullanılan adresle birebir eşleşmelidir; sonuna `/` eklenmez. Veritabanı tabloları ilk açılışta oluşturulur. Başlangıçtaki `ADMIN_USERNAME`/`ADMIN_PASSWORD` yalnız hiç kullanıcı yokken ilk hesabı oluşturur; ortam değişkenini sonradan değiştirmek mevcut hesabın parolasını değiştirmez.

Sunucuya ait `.env` dosyasını, `server/` klasörünü ve veritabanı bağlantı bilgilerini statik web dizininde yayınlamayın. Sunucu yalnız açıkça listelenen `public` dosyalarını HTTP üzerinden sunar.

### Docker Compose

`.env` içindeki `DATABASE_URL` için veritabanı sunucusu adı `db` olmalıdır. `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` ile URL'deki bilgiler eşleşmelidir. Paroladaki URL özel karakterlerini bağlantı adresinde URL kodlamasıyla yazın.

```sh
docker compose up -d --build
```

Veritabanı kalıcı `postgres-data` volume'unda tutulur. PostgreSQL portu dışarıya açılmaz; uygulama portu ana makinenin yalnız `127.0.0.1:3000` adresine bağlanır. Başka bilgisayarlardan erişim için TLS sağlayan reverse proxy kullanın. `NODE_ENV=production` ve `APP_ORIGIN=https://is-takip.kurumunuz.example` ayarlayın. `deploy/nginx.conf.example` örneği kendi alan adınız ve sertifika yollarınızla uyarlanmalıdır. Kurumun sunucusuna bu teslimde yayınlama yapılmamıştır.

### Kullanıcı ekleme

Bu sürümde her hesabın ayrı parolası vardır; giriş yapan tüm kullanıcılar düzenleyicidir. Rol bazlı yetki/SSO içermez. Kullanıcı ekleme yalnız sunucu yöneticisinin CLI işlemiyle yapılır. Parolayı komut satırına yazmayın; araç standart girdiden okur.

PowerShell örneği:

```powershell
$newUserPassword = Read-Host 'Yeni kullanıcı parolası' -MaskInput
$newUserPassword | node --env-file=.env server/create-user.js kullanici
Remove-Variable newUserPassword
```

`Read-Host -MaskInput` PowerShell 7 içindir. CMD geçmişine parola yazmak yerine sunucu ortamınızın gizli girdi mekanizmasını kullanın. HTTPS üretim modunda oturum çerezleri Secure, HttpOnly ve SameSite=Strict olur. Oturumlar 12 saat geçerlidir. Oturum sona ererse **Oturumu yenile** düğmesiyle taslağı kaybetmeden tekrar giriş yapılabilir. Temel IP bazlı giriş denemesi sınırı vardır; kurumun proxy/SSO politikasının yerini tutmaz.

### Veri bütünlüğü ve yedekleme

- Konular, sayfalar, haftalık güncellemeler, kullanıcılar, oturumlar ve işlem kayıtları ayrı PostgreSQL tablolarında tutulur.
- Kayıt tek transaction içinde yapılır. Çalışma alanının revizyon satırı kilitlenir; eski sürümle yazmaya 412 yanıtı verilir. Arayüz bağımsız alanları birleştirir, aynı alan çakışmasında taslağı korur.
- İşlem kimliği yinelenen kaydı engeller. Kayıt cevabı kaybolduğunda **İşlem sonucunu denetle** düğmesi işlemin sonucunu sorgular.
- İşlem günlüğünde kullanıcı adı, zaman, revizyon ve değişen konu kimlikleri bulunur. Bu tablo her alanın eski değerini içeren tam denetim arşivi değildir.
- JSON modunun dosya yedeklemesi PostgreSQL moduna uygulanmaz. PostgreSQL için düzenli `pg_dump` ve ayrı ortamda saklanan, geri yüklemesi test edilmiş yedekler kurum tarafından yapılandırılmalıdır. `JSON yedek indir` uygulama verisinin taşınabilir kopyasıdır; hesap ve işlem tablolarını içermez.
- Mevcut çalışma alanı API'si tüm konuları birlikte taşır: en fazla 10.000 konu, 200 sayfa ve 9 MB kayıt isteği. Büyük veri hacimleri için sayfalama ve konu bazlı API ayrı çalışma gerektirir.

## Rapor

**Yönetici HTML raporu indir**, kaydedilmiş ve mevcut filtrelere uyan konulardan mevcut rapor şablonuyla çıktı oluşturur. Rapor ayrı sekmede açılır; açılır pencere/indirme izinleri gerekebilir. Raporun yazdırma görünümünden PDF alınır. XLSX kütüphanesi pakettedir; yerel JSON modunda rapor için internet bağlantısı gerekmez.

## Geliştirme ve test

```sh
npm ci
npm test
npm run test:browser
```

Testler kendi PostgreSQL süreçlerini ve `test-data/` altında yalnız yapay verilerini oluşturur; uygulamanın `.env` bağlantısına veya canlı veriye bağlanmaz. Windows Edge tarayıcı testleri için Edge yüklü olmalıdır. `embedded-postgres` yalnız test bağımlılığıdır, üretim uygulamasında kullanılmaz. Linux'ta testleri root olmayan kullanıcıyla çalıştırın. Test sonunda PostgreSQL ve tarayıcı kapatılır; test verileri inceleme için bırakılır.

Yerel JSON tarayıcı testinde işletim sisteminin klasör seçicisi test dosya tutamaçlarıyla simüle edilir; gerçek dosya okuma/yazma ve uygulama akışı test klasöründe çalışır. Kurum tarayıcısının dosya erişim politikası ve gerçek SMB paylaşımı ayrıca denenmelidir.

Kaynaklar: [PostgreSQL kilitler](https://www.postgresql.org/docs/current/explicit-locking.html), [node-postgres işlemler](https://node-postgres.com/features/transactions), [tarayıcı dosya erişimi](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
