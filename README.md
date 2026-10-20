# OpenCode Dual Frontier Bridge (OpenAI-Compatible)

Jembatan API mandiri (Zero-Dependency) untuk menghubungkan berbagai editor AI (**Cursor**, **Cline**, **Roo Code**, **Continue**, **Aider**, atau **9Router**) ke dua model frontier terbaik:
1. **`glm-5.3`** (Zhipu AI Multimodal Reasoning - Standar Resmi 200K Konteks, 32K Output)
2. **`deepseek-v4.1`** (DeepSeek AI Coding Specialist - Standar Resmi 200K Konteks, 32K Output)

**100% Mandiri:** Tanpa perlu install software OpenCode, tanpa perlu akun berbayar!

---

## 🐳 Panduan Docker VPS (Rekomendasi Utama bersama 9Router)

Konfigurasi ini dirancang agar **100% bersih tanpa membuat folder tambahan di host VPS**. Docker akan mem-build image langsung dari GitHub ke memori Docker.

### 1. `docker-compose.yml` di VPS Anda
Cukup gunakan file `docker-compose.yml` berikut di direktori 9Router VPS Anda:

```yaml
services:
  9router:
    image: decolua/9router:latest
    container_name: 9router
    restart: unless-stopped
    ports:
      - "127.0.0.1:20128:20128"
    environment:
      - DATA_DIR=/app/data
      - PORT=20128
      - INITIAL_PASSWORD=your_password_here
    volumes:
      - ./data:/app/data
    networks:
      - gateway-net
    depends_on:
      - opencode-bridge

  opencode-bridge:
    build: https://github.com/bitsmith826/opencode-glm-bridge.git#main
    container_name: opencode-bridge
    restart: unless-stopped
    environment:
      # Opsional: Jika memakai Cloudflare Worker relay (bisa lewat .env)
      - OPENCODE_UPSTREAM_URL=${OPENCODE_UPSTREAM_URL:-https://opencode.ai}
    networks:
      - gateway-net

networks:
  gateway-net:
    external: true
```

### 2. Jalankan di VPS:
```bash
docker compose build --no-cache opencode-bridge
docker compose up -d
```

### 3. Konfigurasi di Web Dashboard 9Router:
1. Masuk ke menu **Provider Nodes** ➡️ Klik **Add Provider**.
2. Masukkan data:
   * **Provider Type:** `OpenAI Compatible`
   * **Node Name:** `OpenCode Free`
   * **Prefix:** `opencode-free`
   * **Base URL:** `http://opencode-bridge:8318/v1`
   * **API Key:** `free` *(bebas isi sembarang teks)*
   * **Enabled Models:** Centang/tambahkan:
     * `glm-5.3`
     * `deepseek-v4.1`
3. Klik **Save**. Kedua model siap dipakai di semua client AI Anda via endpoint 9Router!

---

## 💻 Menjalankan Secara Lokal (Node.js)

Jika ingin menjalankan bridge secara lokal di komputer:

```bash
# Clone dan jalankan
git clone https://github.com/bitsmith826/opencode-glm-bridge.git
cd opencode-glm-bridge
npm start
```

Server bridge akan aktif di `http://127.0.0.1:8318`.

Arahkan editor AI Anda (Cursor / Cline / Roo Code):
* **API Provider:** `OpenAI Compatible`
* **Base URL:** `http://127.0.0.1:8318/v1`
* **API Key:** `dummy` *(bebas)*
* **Model:** `glm-5.3` atau `deepseek-v4.1`

---

## 🛡️ Solusi Anti-Limit & Anti-429: Multi-Relay Failover (Rekomendasi Utama)

OpenCode membatasi kuota harian tier gratis per IP Egress. Jika satu relay terkena limit (`HTTP 429 FreeUsageLimitError`), Bridge dilengkapi dengan **Smart Multi-Upstream Failover** yang secara otomatis beralih seketika (0ms) ke relay berikutnya di dalam pool tanpa menghentikan pekerjaan client!

### 1. Buat 1 atau Lebih Cloudflare Worker Relay (Gratis 100.000 req/hari per akun)
1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) ➡️ Masuk ke **Workers & Pages** ➡️ **Create Worker**.
2. Masukkan kode relay berikut:
   ```javascript
   export default {
     async fetch(request) {
       const url = new URL(request.url);
       url.hostname = "opencode.ai";

       const newHeaders = new Headers(request.headers);
       newHeaders.set("Host", "opencode.ai");
       // Hapus header pelacak IP asal agar OpenCode melihat IP anycast Cloudflare yang bersih
       newHeaders.delete("cf-connecting-ip");
       newHeaders.delete("x-forwarded-for");
       newHeaders.delete("x-real-ip");

       return fetch(url.toString(), {
         method: request.method,
         headers: newHeaders,
         body: request.body,
         redirect: "follow"
       });
     }
   };
   ```
3. Deploy worker. Anda bisa membuat 2 atau 3 worker untuk melipatgandakan kuota (misal: `relay1.workers.dev`, `relay2.workers.dev`).

### 2. Konfigurasi Multi-Relay di Bridge:
Tambahkan daftar relay Anda ke `upstreamUrls` di `config.local.json` (atau via ENV `OPENCODE_UPSTREAM_URLS`):
```json
{
  "upstreamUrls": [
    "http://relay-1.workers.dev",
    "http://relay-2.workers.dev"
  ]
}
```
* **Instant Hot-Swap (0ms):** Jika Relay 1 terkena 429 kuota harian, bridge otomatis loncat ke Relay 2.
* **Anti-Freeze (Fail-Fast):** Jika seluruh relay habis, bridge langsung mengabari dalam <100ms tanpa membekukan editor AI selama 2.5 menit.

---

## 🧪 Uji Coba Cepat (Test Suite)

Jalankan test suite untuk memverifikasi fungsionalitas streaming dan non-streaming:
```bash
npm test
```
