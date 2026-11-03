# v2.5 doğrulaması — 3 Kasım 2026

Mevcut proje ve canlı veri değiştirilmedi. Testler ayrı klasörlerde yapay verilerle çalıştırıldı.

Gerçek PostgreSQL motorunda 6 entegrasyon testi geçti: Türkçe/uzun notların korunması; aynı revizyonla iki yazardan yalnız birinin kabul edilmesi; işlem kimliğiyle tekrar koruması; geçersiz girişte verinin değişmemesi; transaction ortasında hata oluştuğunda bütün değişikliklerin geri alınması; kullanıcı girişi, kaynak kontrolü, oturum kapatma ve işlem sahibinin kaydı.

Edge tarayıcısında PostgreSQL modu: giriş, hızlı konu ekleme, otomatik kayıt, haftalık not, filtreler, iki bağımsız tarayıcı bağlamında ortak veri ve yenileme, kayıt cevabı kaybolduğunda sonuç sorgulama, yönetici HTML raporunun indirilmesi doğrulandı.

Edge tarayıcısında doğrudan `file://` üzerinden yerel HTML modu: mevcut JSON'un açılması, dosyaya otomatik yazma, önceki sürümün yedeklenmesi, dışarıdan değişen dosyanın yeniden okunması ve yönetici raporunun indirilmesi doğrulandı. İşletim sisteminin klasör seçicisi testte simüle edildi; dosyalar gerçek bir test dizinine yazıldı. Gerçek kullanıcı izin penceresi ve kurum tarayıcı politikası otomatik test kapsamında değildir.

Dağıtım paketi Python, EXE, gerçek kullanıcı parolası, canlı veri ve test veritabanı içermez. `embedded-postgres` yalnız test bağımlılığıdır; üretim PostgreSQL bağlantısı `pg` sürücüsünü kullanır. Test motoru Windows üzerinde PostgreSQL 18 paketidir; Compose yapılandırması PostgreSQL 17 kullanır. Docker/NGINX ile gerçek sunucu yayını ve gerçek ağ paylaşımı pilotu yapılmadı.

Sunucu kurulumu için kurumun bağlantı adresi, TLS alan adı ve PostgreSQL erişim bilgileri gerekir. Yerel JSON modu çok kullanıcılı eşzamanlı yazma için desteklenmez.
