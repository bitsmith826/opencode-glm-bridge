# OpenCode Frontier Bridge (OpenAI-Compatible)

Jembatan API mandiri (Zero-Dependency) berkinerja tinggi untuk menghubungkan berbagai editor AI (**Cursor**, **Cline**, **Roo Code**, **Continue**, **Aider**, atau **9Router**) ke 4 model frontier utama OpenCode:
1. **`glm-5.3`** (Zhipu AI GLM-5.3 Flash Free - **200.000 Konteks**, **32.000 Output**, Multimodal Teks/Gambar/Video/PDF)
2. **`deepseek-v4.1`** (DeepSeek V4.1 Flash Free - **200.000 Konteks**, **32.000 Output**, Coding & Speculative Reasoning)
3. **`minimax-m3.1`** (MiniMax M3.1 Flash Free - **1.000.000 Konteks**, **512.000 Output**, Multimodal + Deep Thinking)
4. **`mimo-v2.6`** (Xiaomi MiMo-V2.6 Flash Free - **200.000 Konteks**, **32.000 Output**, Full Omni Teks/Gambar/Audio/Video)

**100% Mandiri:** Tanpa perlu install software OpenCode, tanpa perlu akun berbayar!

---

## 📋 4 Model Utama yang Didukung

| Model ID | Nama Resmi Upstream | Context Window | Max Output | Fitur Unggulan |
|---|---|:---:|:---:|---|
| `glm-5.3` | `glm-5.3-flash-free` | **200.000** | **32.000** | Teks, Gambar, Video, PDF |
| `deepseek-v4.1` | `deepseek-v4.1-flash-free` | **200.000** | **32.000** | Teks, Gambar, Native Speculative Reasoning |
| `minimax-m3.1` | `minimax-m3.1-flash-free` | **1.000.000** (1M) | **512.000** | Teks, Gambar, Video, Deep Thinking (`reasoning_content`) |
| `mimo-v2.6` | `mimo-v2.6-flash-free` | **200.000** | **32.000** | Full Omni (Teks, Gambar, Audio, Video) |

> [!NOTE]
> Mendukung berbagai variasi penulisan alias di client (misal: `glm-5.3` / `glm5.3`, `deepseek-v4.1` / `deepseekv4.1`, `minimax-m3.1` / `minimaxm31`, `mimo-v2.6` / `mimov2.6`). Dropdown di Cline dan Cursor dijamin bersih tanpa model ganda.

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
   * **Enabled Models:** Pilih model yang diinginkan (misal: `minimax-m3.1`, `glm-5.3`, `deepseek-v4.1`, `beam`).
3. Klik **Save**. Model siap dipakai di semua client AI Anda via endpoint 9Router!

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
* **Model:** `minimax-m3.1`, `glm-5.3`, atau `deepseek-v4.1`

---

## 🛡️ Solusi Anti-Limit & Anti-429: Multi-Relay Failover

OpenCode membatasi kuota harian tier gratis per IP Egress. Jika satu relay terkena limit (`HTTP 429 FreeUsageLimitError`), Bridge dilengkapi dengan **Smart Multi-Upstream Failover** yang secara otomatis beralih seketika (0ms) ke relay berikutnya di dalam pool tanpa menghentikan pekerjaan client!

### 1. Buat Cloudflare Worker Relay
Gunakan script worker berikut:
```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "opencode.ai";

    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", "opencode.ai");
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

### 2. Konfigurasi Multi-Relay di Bridge:
Tambahkan daftar relay Anda ke `upstreamUrls` di `config.local.json`. Sangat disarankan menyertakan direct `https://opencode.ai` agar kuota IP lokal dapat digunakan bergantian dengan relay:
```json
{
  "upstreamUrls": [
    "https://opencode.ai",
    "https://relay-1.workers.dev",
    "https://relay-2.workers.dev"
  ]
}
```
* **Instant Hot-Swap (0ms):** Jika Relay 1 terkena 429 kuota harian, bridge otomatis loncat ke Relay 2.
* **Anti-Freeze (Fail-Fast):** Jika seluruh relay habis, bridge langsung mengabari dalam <100ms tanpa membekukan editor AI.

---

## 🧪 Uji Coba Cepat (Test Suite)

Jalankan test suite untuk memverifikasi fungsionalitas:
```bash
npm test
```
