# OpenCode Dual Frontier Bridge (OpenAI-Compatible)

Jembatan API lokal mandiri untuk menghubungkan berbagai editor AI (**Cursor**, **Cline**, **Roo Code**, **Continue**, **Aider**, atau skrip **Python**) ke dua model frontier gratis terbaik:
1. **`glm-5.3-flash-free`** (Zhipu AI / Z.ai Multimodal Reasoning - Konteks 1 Juta Token, 128K Output)
2. **`deepseek-v4.1-flash-free`** (DeepSeek AI Coding Specialist - Konteks 200 Ribu Token, 32K Output)

**100% Mandiri:** Tanpa perlu instal software OpenCode, tanpa perlu akun berbayar!

---

## 🚀 Panduan Cepat untuk Pengguna (1-Klik)

1. Pastikan komputer Anda memiliki [Node.js](https://nodejs.org).
2. Klik ganda file:
   ```cmd
   start-windows.bat
   ```
   *(Jendela hitam CMD akan terbuka menandakan server bridge aktif di `http://127.0.0.1:8318`)*.
3. Buka editor AI Anda (misal: **Cursor** atau **VS Code Cline**):
   * **API Provider:** `OpenAI Compatible`
   * **Base URL:** `http://127.0.0.1:8318/v1`
   * **API Key:** `dummy` *(bebas isi sembarang teks)*
   * **Pilihan Model:**
     * `deepseek-v4.1-flash-free` *(atau alias `deepseek`)*
     * `glm-5.3-flash-free` *(atau alias `glm-5.3`)*
4. Selesai! Model siap digunakan untuk coding dan chat sepuasnya.

---

## ⚡ Integrasi Otomatis dengan 9Router (Cukup Jalankan `9router` Saja!)

Bagi pengguna [9Router](https://9router.com), Anda **TIDAK PERLU** lagi membuka dua terminal atau menjalankan `start-windows.bat` secara terpisah!

Cukup pasang integrasi sidecar sekali saja:
```bash
npm run setup-9router
# atau: node integrate-9router.js
```

Setelah itu, setiap kali Anda menjalankan `9router` di terminal:
* 9Router akan **otomatis meluncurkan OpenCode Bridge** di background.
* 9Router secara transparan merutekan model `opencode/glm-5.3-flash-free` dan `opencode/deepseek-v4.1-flash-free` langsung lewat bridge anti-abuse.
* Ketika 9Router dimatikan (Ctrl+C atau quit tray), bridge juga otomatis berhenti dengan bersih tanpa meninggalkan proses zombie.
* Model langsung dapat diakses lewat port 9Router (`http://localhost:20128/v1/chat/completions`) dengan API key 9Router Anda!

---

## 🐳 Panduan Deployment di Docker VPS (Jika 9Router di VPS)

Jika 9Router Anda sudah berjalan di Docker VPS (`ghcr.io/decolua/9router`), Anda bisa menghubungkannya dengan 2 cara mudah:

### Opsi A (Paling Simpel - Container Sidecar):
1. Di VPS Anda, clone repositori ini dan jalankan:
   ```bash
   git clone https://github.com/bitsmith826/opencode-glm-bridge.git
   cd opencode-glm-bridge
   docker compose up -d
   ```
   *(Bridge akan aktif di port `8318` di VPS)*.

2. Buka Web Dashboard 9Router Anda (`http://<IP-VPS>:20128/dashboard`):
   * Masuk ke menu **Provider Nodes** (atau **Custom Provider**) ➡️ Klik **Add Provider**.
   * Pilih tipe: **`OpenAI Compatible`**
   * **Node Name:** `OpenCode Free`
   * **Prefix:** `opencode-free` *(Catatan: gunakan prefix `opencode-free` agar tidak bertabrakan dengan provider bawaan 9Router yang broken)*
   * **Base URL:** `http://172.17.0.1:8318/v1` *(atau `http://opencode-bridge:8318/v1` jika 1 network docker)*
   * **API Key:** `free`
   * **Enabled Models:** Centang/tambahkan `glm-5.3-flash-free` dan `deepseek-v4.1-flash-free`.

3. Di IDE / editor coding Anda:
   * **Base URL:** `http://<IP-VPS>:20128/v1`
   * **Model:** `opencode-free/glm-5.3-flash-free` atau `opencode-free/deepseek-v4.1-flash-free`

### Opsi B (All-in-One Stack di VPS):
Jalankan stack lengkap 9Router + Bridge dalam satu compose:
```bash
docker compose -f docker-compose.9router-stack.yml up -d
```

---

Jika Anda ingin koneksi yang 100% stabil, bebas error 403, dan bebas rate limit 429, gunakan metode **Cloudflare Worker Relay** (100.000 Request GRATIS per hari):

### Langkah-langkah Pembuatan (Hanya 2 Menit):
1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) (daftar akun gratis).
2. Di menu sebelah kiri, masuk ke **Workers & Pages**.
3. Klik tombol **Start with Hello World!** *(ikon bola dunia hijau)*.
4. Beri nama aplikasi Anda (misal: `my-opencode-relay`) ➡️ Klik **Deploy**.
5. Setelah ter-deploy, klik tombol **Edit code**.
6. Hapus semua kode bawaan di layar, lalu tempel kode relay resmi berikut:
   ```javascript
   export default {
     async fetch(request) {
       const url = new URL(request.url);
       url.hostname = "opencode.ai";

       const newHeaders = new Headers(request.headers);
       newHeaders.set("Host", "opencode.ai");

       return fetch(url.toString(), {
         method: request.method,
         headers: newHeaders,
         body: request.body,
         redirect: "follow"
       });
     }
   };
   ```
7. Klik tombol **Save and deploy**. Anda akan mendapatkan URL publik Worker (contoh: `https://my-opencode-relay.namaanda.workers.dev`).
8. Buat file baru bernama `config.local.json` di folder ini, lalu isi URL Worker Anda (gunakan awalan `http://`):
   ```json
   {
     "upstreamUrl": "http://my-opencode-relay.namaanda.workers.dev"
   }
   ```
   *(File `config.local.json` otomatis diprioritaskan oleh server dan diabaikan oleh Git, sehingga data pribadi Anda aman dari commit GitHub)*.
9. Jalankan ulang `start-windows.bat`. Selesai!

---

## 🧪 Uji Coba Cepat (Terminal / CMD)

Anda bisa menguji koneksi langsung lewat terminal menggunakan perintah `curl`:

```bash
curl http://127.0.0.1:8318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"glm-5.3-flash-free\", \"messages\": [{\"role\": \"user\", \"content\": \"Halo!\"}]}"
```

