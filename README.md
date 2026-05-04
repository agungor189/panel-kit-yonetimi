# DSDST Panel

Şirket içi ERP paneli. Stok, satış, gelir/gider, tekrarlayan ödemeler, B2B CRM ve çok platformlu pazaryeri yönetimi.

**Stack:** React 19 + TypeScript (Vite) / Express + SQLite (better-sqlite3) / JWT Auth

---

## Hızlı Başlangıç

### 1. Ortam değişkenlerini hazırla

```bash
cp .env.example .env
```

`.env` dosyasını aç ve şu üç zorunlu değeri doldur:

```
JWT_SECRET=         # min 32 rastgele karakter
ENCRYPTION_SECRET=  # tam 32 karakter
PANEL_API_HASH_SECRET= # rastgele string
```

Güvenli rastgele değer üretmek için:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2. Docker ile çalıştır (önerilen)

```bash
docker compose up -d
```

Uygulama `http://localhost:3000` adresinde açılır.
Veriler varsayılan olarak `panel_data` (SQLite) ve `panel_uploads` (görseller) isimli Docker volume'larında kalıcı olarak saklanır. Backup arşivleri `./backups` klasörüne yazılır.

Verileri doğrudan host klasörlerinde tutmak için `.env` içine şunları ekleyebilirsin:

```bash
PANEL_DATA_DIR=/opt/dsdst-panel/data
PANEL_UPLOADS_DIR=/opt/dsdst-panel/uploads
PANEL_BACKUP_DIR=/opt/dsdst-panel/backups
```

> Mevcut named volume'dan host klasörüne geçerken önce canlı DB ve uploads'ı yeni klasöre kopyala; boş klasörle başlatırsan uygulama yeni DB oluşturur.

```bash
# Logları izle
docker compose logs -f panel

# Güncelle
docker compose up -d --build
```

### 3. Lokal geliştirme

```bash
npm install
npm run dev        # Vite + Express birlikte localhost:3000
```

---

## Yapılandırma

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT imzalama anahtarı (min 32 karakter) |
| `ENCRYPTION_SECRET` | ✅ | API anahtarlarını şifrelemek için AES-256 anahtarı |
| `PANEL_API_HASH_SECRET` | ✅ | Panel API anahtarlarını hash'lemek için HMAC anahtarı |
| `DB_PATH` | — | SQLite dosya yolu. **Docker'da mutlaka set et:** `DB_PATH=/data/dsdst_panel.db` (volume'a bağlı). Set edilmezse proje dizinine yazar — Docker container yeniden başlatıldığında veri kaybolur. |
| `BACKUP_DIR` | — | Otomatik backup arşivlerinin yazılacağı klasör. Docker'da varsayılan: `/backups` |
| `PANEL_DATA_DIR` | — | docker-compose için host DB klasörü veya named volume adı. Varsayılan: `panel_data` |
| `PANEL_UPLOADS_DIR` | — | docker-compose için host uploads klasörü veya named volume adı. Varsayılan: `panel_uploads` |
| `PANEL_BACKUP_DIR` | — | docker-compose için host backup klasörü. Varsayılan: `./backups` |
| `CLOUD_BACKUP_ENABLED` | — | `true` olursa otomatik yedek arşivleri rclone ile buluta yüklenir |
| `CLOUD_BACKUP_RCLONE_REMOTE` | — | rclone hedefi. Cloudflare R2 örneği: `dsdstr2:dsdst-panel-backups` |
| `CLOUD_BACKUP_PREFIX` | — | Bucket içi klasör/prefix. Öneri: `production` |
| `CLOUD_BACKUP_RETENTION_DAYS` | — | Bulutta eski yedeklerin tutulacağı gün sayısı. Varsayılan: `30` |
| `APP_URL` | — | Uygulamanın dışarıdan erişilen URL'i |
| `ALLOWED_ORIGINS` | — | İzin verilen CORS origin'leri (virgülle ayrılmış). Boş bırakılırsa hepsi izinli |
| `GEMINI_API_KEY` | — | Google Gemini AI entegrasyonu için |

---

## Cloudflare R2 Backup

Gelişmiş backup sistemi önce yerel `/backups` klasörüne ZIP arşivi yazar. Cloud backup açıksa aynı arşiv daha sonra rclone üzerinden Cloudflare R2 bucket içine yüklenir. Bulut yükleme hatası yerel yedeği bozmaz; durum Ayarlar > Gelişmiş Yedekleme tablosunda ayrı görünür.

Önerilen bucket yapısı:

```text
dsdst-panel-backups/
└── production/
    ├── db/
    └── uploads/
```

`.env` örneği:

```bash
CLOUD_BACKUP_ENABLED=true
CLOUD_BACKUP_PROVIDER=cloudflare-r2
CLOUD_BACKUP_RCLONE_REMOTE=dsdstr2:dsdst-panel-backups
CLOUD_BACKUP_PREFIX=production
CLOUD_BACKUP_RETENTION_DAYS=30

RCLONE_CONFIG_DSDSTR2_TYPE=s3
RCLONE_CONFIG_DSDSTR2_PROVIDER=Cloudflare
RCLONE_CONFIG_DSDSTR2_ACCESS_KEY_ID=...
RCLONE_CONFIG_DSDSTR2_SECRET_ACCESS_KEY=...
RCLONE_CONFIG_DSDSTR2_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
```

Kurulumdan sonra container içinden bağlantıyı test edebilirsin:

```bash
docker compose exec panel rclone lsd dsdstr2:
docker compose exec panel rclone lsf dsdstr2:dsdst-panel-backups
```

Not: R2 erişim anahtarlarını DB içinde saklama; sadece sunucudaki `.env` dosyasında tut.

---

## Veritabanı

- **SQLite** — tek dosya, sıfır konfigürasyon.
- **WAL modu** açık → eşzamanlı okuma performansı yüksek.
- **Versiyonlu migration sistemi** — `server/migrations/runner.ts`. Her uygulama başlangıcında yeni migration'lar otomatik uygulanır. `schema_migrations` tablosunda izlenir.

### Stok Modeli

Stok modeli tek merkezi depo stoğudur. Platform bazlı stok fiziksel stok değildir; `product_platforms` kanal/listelenme/fiyat bilgisi için tutulur, gerçek stok kaynağı `products.central_stock` alanıdır.

### Yedek & Geri Yükleme

Panelden **Ayarlar → Gelişmiş Yedekleme Sistemi** ile otomatik yedekleri yönet.

- DB her otomatik çalışmada SQLite hot-backup ile tam yedeklenir.
- Upload dosyaları akıllı modda haftalık tam, günlük değişen dosyalar şeklinde yedeklenir.
- Varsayılan saklama süresi 7 gündür; eski dosyalar otomatik silinir.
- En son tam uploads yedeği, restore zinciri bozulmasın diye retention dışında korunur.
- **Yedek İndir** butonu tek ZIP içinde DB + uploads tam yedeği indirir.
- Geri yüklemek için **Ayarlar → Geri Yükle** — yalnızca admin yapabilir.

Manuel yedek (Docker):
```bash
docker compose exec panel sh -c 'cp /data/dsdst_panel.db /data/dsdst_panel_backup_$(date +%Y%m%d).db'
```

---

## Kullanıcı Rolleri

| Rol | Yetkiler |
|---|---|
| `admin` | Tam erişim. Yedek, geri yükleme, kullanıcı yönetimi dahil |
| `user` | Tüm modülleri yönetebilir. Yedek/geri yükleme yapamaz |
| `readonly` | Yalnızca okuma — hiçbir yazma/silme işlemi yapamaz (sunucu tarafında zorlanır) |

Varsayılan kullanıcı: `admin` / `admin` — **ilk girişte şifreyi değiştir.**

---

## Üretim Güvenliği

- `.env` dosyasını asla git'e commit etme.
- `JWT_SECRET`, `ENCRYPTION_SECRET`, `PANEL_API_HASH_SECRET` değerlerini birbirinden farklı ve güçlü tut.
- Cloudflare Tunnel / Zero Trust arkasında çalıştırıyorsan `ALLOWED_ORIGINS` ayarlamak şart değil; Tunnel zaten dışarıya kapalı.
- Dışarıya direkt port açılıyorsa `ALLOWED_ORIGINS=https://panel.yourdomain.com` şeklinde kısıtla.
- Docker volume'larını düzenli olarak dışa yedekle.

---

## Modüller

| Modül | Açıklama |
|---|---|
| Ürünler | SKU/barkod, merkezi depo stoğu, kanal fiyatları, görsel, fiyat hesaplama |
| Stok | Merkezi depo stok hareketleri, hareket geçmişi |
| Satışlar | Sipariş yönetimi, otomatik stok düşme, otomatik gelir kaydı, iade/iptal akışı |
| Gelir/Gider | İşlem kaydı, fatura ekleri, kasa hesapları |
| Tekrarlayan Ödemeler | Aylık/yıllık/özel frekans planlar, takvim görünümü |
| Analitik | Satış trendleri, ürün performansı, çapraz analiz |
| B2B | Firma veritabanı, teklif takibi, hatırlatıcılar |
| Entegrasyonlar | Şifreli API anahtar yönetimi, Panel Public API |
| Dashboard | Kişiselleştirilebilir widget düzeni |
| Aktivite Logları | Tüm işlemler kullanıcı bazlı kaydedilir |

---

## Geliştirme

```bash
npm run lint      # TypeScript tip kontrolü
npm run build     # Üretim için derle (dist/)
```
