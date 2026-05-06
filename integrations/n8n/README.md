# DSDST Telegram Asistan — n8n Workflow

Bu workflow Telegram botunu DSDST paneline bağlar. İki yetenek var:

1. **Fiş/fatura fotoğrafı** atınca Gemini Vision ile alanları çıkarır, panele gider olarak kaydeder, görseli ek olarak iliştirir, Telegram'a onay mesajı atar.
2. **Yazılı soru** sorulunca Gemini intent tespit eder, ilgili panel endpoint'inden veri alır, cevabı Türkçe özetler.

Ayrıca her sabah 09:00'da otomatik günlük brifing atar.

## Ön gereksinimler

- Lokal (veya self-hosted) çalışan n8n
- Telegram bot token (BotFather'dan alınır)
- Google AI Studio API key (Gemini için, ücretsiz: https://aistudio.google.com/apikey)
- DSDST paneli erişilebilir bir URL'de (n8n container'dan ulaşılabilmeli)
- Panelden üretilmiş bir Panel API Key

## 1. Panel API Key oluştur

Panel arayüzünde **Entegrasyonlar → Panel API Anahtarları → Yeni Anahtar**:

İzinler (en az):
- `expenses:write` (gider oluşturma + fiş ekleme)
- `assistant:read` (rapor uçları)

İsteğe bağlı:
- `stock:read`, `products:read`, `sales:read` (eski uçlar için)

Anahtarı bir kez göreceksin — kopyala.

## 2. n8n environment variables

n8n çalıştığın yerde şu env değişkenlerini ekle (docker-compose.yml veya `.env`):

```bash
# n8n'in panele nasıl ulaşacağı:
PANEL_API_URL=http://panel:3000          # n8n ile panel aynı docker network'tayse
# veya
PANEL_API_URL=http://192.168.1.X:3010    # farklı host

PANEL_API_KEY=ds_pk_xxxxxxxxxxxxxxxxxxxx # panelden aldığın API key

# Gemini Free Tier
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXX

# Sabah brifingini gönderecek chat (kendi Telegram chat ID'in)
TELEGRAM_OWNER_CHAT_ID=123456789
```

`docker-compose.yml`'a örnek:
```yaml
n8n:
  environment:
    - PANEL_API_URL=http://panel:3000
    - PANEL_API_KEY=ds_pk_xxxxxxxxxxxxxxxxxxxx
    - GEMINI_API_KEY=AIzaSyXXXXXXXX
    - TELEGRAM_OWNER_CHAT_ID=123456789
```

## 3. Telegram bot

1. BotFather'a `/newbot` yaz, ad ve username belirle, token al.
2. n8n'de **Credentials → New → Telegram API**, token'ı yapıştır, kaydet.
3. n8n credential ID'sini kopyala (URL'de görünür).

## 4. Workflow'u import et

1. n8n UI → **Workflows → Import from File** → `telegram-assistant.json` seç.
2. Açtığında 4 adet kırmızı uyarı göreceksin (Telegram Trigger ve diğer Telegram node'ları için credential).
3. Her node'da **Credentials → Telegram Bot** seç (oluşturduğun credential).
4. Workflow'u **Active** yap (sağ üstteki toggle).

## 5. Test et

**Fiş testi:**
- Bota fiş fotoğrafı at → birkaç saniye içinde "✅ Gider kaydedildi" cevabı + panelde **Finans → Giderler** ekranında yeni kayıt + ekli görsel görünmeli.

**Rapor testi:**
- "Bugün ne sattım?" → satış sayısı, ciro, kar, en çok satan 5 ürün özeti gelir.
- "Stoğu azalan ürünler" → 10'un altındaki ürünler listelenir.
- "Son 7 günün en çok satanları" → top liste.
- "Bu haftanın satışları" → tarih aralıklı özet.
- "Kasa durumu" → her hesabın bakiyesi.

## Yapılandırma ipuçları

**Sadece kendi mesajlarına cevap versin (yetkilendirme):** Telegram Trigger'dan hemen sonra bir **IF** node'u ekle, koşul `{{ $json.message.from.id === Number($env.TELEGRAM_OWNER_USER_ID) }}` — başka kullanıcılar reddedilir.

**Sabah cron saati:** "Sabah 09:00 cron" node'unu açıp `0 9 * * *` ifadesini istediğin saate çevir (örn. `0 8 * * 1-6` → hafta içi 08:00).

**Düşük stok eşiği:** Sabah brifinginde varsayılan 10. "Sabah: Düşük stok" node'unun URL'sindeki `threshold=10`'u değiştir.

**Gemini model:** Endpoint URL'inde `gemini-2.0-flash` yerine başka model deneyebilirsin (örn. `gemini-2.5-flash`). Free tier limitleri: https://ai.google.dev/pricing

## Sınırlar / Bilinenler

- Gemini Free Tier günde 1500 istek (her foto + her chat = 1-2 istek). Kişisel kullanım için yeter.
- OCR doğruluğu el yazısı/silik fişlerde düşer — panelde manuel düzenleme her zaman mümkün.
- Asistan **sadece okuma** yapar; satış oluşturma, fiyat değiştirme gibi yazma komutları kasıtlı olarak workflow dışında. Eklenmesi istenirse ayrı endpoint + ayrı izin gerekir.
- Eğer panel HTTPS arkasında değilse PANEL_API_URL'i sadece iç network'te bırak; API key trafiği plain HTTP üzerinde gider.

## Kullanılan panel endpointleri

| Endpoint | İzin | Amaç |
|---|---|---|
| `POST /api/public/expenses` | `expenses:write` | Gider oluştur |
| `POST /api/public/expenses/:id/attachments` | `expenses:write` | Fiş ekle |
| `GET /api/public/assistant/today` | `assistant:read` | Bugün özeti |
| `GET /api/public/assistant/low-stock` | `assistant:read` | Düşük stok |
| `GET /api/public/assistant/top-products` | `assistant:read` | En çok satanlar |
| `GET /api/public/assistant/sales` | `assistant:read` | Tarih aralıklı satış özeti |
| `GET /api/public/assistant/cashflow` | `assistant:read` | Kasa hesap bakiyeleri |
