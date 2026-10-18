# OpenCode Dual Frontier Bridge (OpenAI-Compatible)

Jembatan API lokal mandiri untuk menghubungkan berbagai editor AI (**Cursor**, **Cline**, **Roo Code**, **Continue**, **Aider**, atau skrip **Python**) ke dua model frontier gratis terbaik:
1. **`deepseek-v4.1-flash-free`** (DeepSeek AI Coding Specialist - Konteks 1 Juta Token)
2. **`glm-5.3-flash-free`** (Zhipu AI / Z.ai Multimodal Reasoning - Konteks 200 Ribu Token)

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

## 🛠️ Solusi Anti-Limit: Cloudflare Worker Relay (Teruji 100%)

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

