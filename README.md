# OpenCode Frontier Bridge (OpenAI-Compatible)

Jembatan API mandiri (Zero-Dependency) berkinerja tinggi untuk menghubungkan berbagai editor AI (**Cursor**, **Cline**, **Roo Code**, **Continue**, **Aider**, atau **9Router**) ke model-model frontier OpenCode:
1. **`minimax-m3.1`** (MiniMax M3.1 Flash Free - **1.000.000 Konteks**, **512.000 Output**, Multimodal + Deep Thinking)
2. **`glm-5.3`** (Zhipu AI GLM-5.3 Flash Free - **200.000 Konteks**, **32.000 Output**, Multimodal Teks/Gambar/Video/PDF)
3. **`deepseek-v4.1`** (DeepSeek V4.1 Flash Free - **200.000 Konteks**, **32.000 Output**, Coding & Speculative Reasoning)
4. Serta model aktif lainnya: `mimo-v2.6`, `beam` (501B MoE 1M ctx), `cat-jam`, `big-pickle`, `longcat-2.5`, dan seri `nemotron-3.5`.

**100% Mandiri:** Tanpa perlu install software OpenCode, tanpa perlu akun berbayar!

---

## 📋 Daftar Model yang Didukung

| Model ID | Nama Resmi Upstream | Context Window | Max Output | Fitur Unggulan |
|---|---|:---:|:---:|---|
| `minimax-m3.1` | `minimax-m3.1-flash-free` | **1.000.000** (1M) | **512.000** | Teks, Gambar, Video, Deep Thinking (`reasoning_content`) |
| `glm-5.3` | `glm-5.3-flash-free` | **200.000** | **32.000** | Teks, Gambar, Video, PDF |
| `deepseek-v4.1` | `deepseek-v4.1-flash-free` | **200.000** | **32.000** | Teks, Gambar, Native Speculative Reasoning |
| `mimo-v2.6` | `mimo-v2.6-flash-free` | **200.000** | **32.000** | Full Omni (Teks, Gambar, Audio, Video) |
| `beam` | `beam-free` | **1.048.576** (1M) | **131.072** | Sparse MoE 501B Parameter (23B Active) |
| `cat-jam` | `cat-jam-free` | **1.048.576** (1M) | **131.072** | Structured JSON & Tool Calling |
| `big-pickle` | `big-pickle` | **200.000** | **32.000** | Step-by-step deliberate reasoning |
| `longcat-2.5` | `longcat-2.5-preview-free` | **1.000.000** (1M) | **131.072** | Teks, Gambar + 1M Context |
| `nemotron-3.5-super-vl` | `nemotron-3.5-super-vl-free` | **1.048.576** (1M) | **131.072** | Vision-Language MoE 120B |
| `nemotron-3.5-lightning` | `nemotron-3.5-lightning-free` | **262.144** | **262.144** | Fast NVIDIA MoE |
| `nemotron-3-ultra` | `nemotron-3-ultra-free` | **1.000.000** (1M) | **128.000** | 550B Flagship Reasoning |

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
Tambahkan daftar relay Anda ke `upstreamUrls` di `config.local.json`:
```json
{
  "upstreamUrls": [
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
