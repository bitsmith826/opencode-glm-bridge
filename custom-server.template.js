const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {}
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

let opencodeBridgeServer = null;

// Intercept outgoing fetch to opencode.ai and transparently reroute to local bridge
const origFetch = globalThis.fetch;
if (typeof origFetch === "function") {
  globalThis.fetch = async function (input, init = {}) {
    try {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url || "";
      if (urlStr.includes("opencode.ai")) {
        let target = urlStr;
        if (urlStr.includes("/chat/completions") || urlStr.includes("/responses") || urlStr.includes("/messages")) {
          target = "http://127.0.0.1:8318/v1/chat/completions";
        } else if (urlStr.includes("/models")) {
          target = "http://127.0.0.1:8318/v1/models";
        }

        if (target !== urlStr) {
          const headers = { ...(init.headers || {}) };
          delete headers.host;
          delete headers.Host;

          let body = init.body;
          if (body && typeof body === "string") {
            try {
              const parsed = JSON.parse(body);
              if (parsed.model && parsed.model.startsWith("opencode/")) {
                parsed.model = parsed.model.replace(/^opencode\//, "");
                body = JSON.stringify(parsed);
              }
            } catch {}
          }

          return origFetch(target, {
            ...init,
            headers,
            body
          });
        }
      }
    } catch (e) {
      console.error("[9Router Interceptor Error]", e.message);
    }
    return origFetch.apply(this, arguments);
  };
}

function startOpenCodeBridgeFromCustomServer() {
  const bridgePath = process.env.OPENCODE_BRIDGE_PATH || path.join(__dirname, "server.js");
  if (!fs.existsSync(bridgePath)) return;

  const net = require("net");
  const probe = net.connect({ host: "127.0.0.1", port: 8318 }, () => {
    probe.destroy();
  });

  probe.on("error", () => {
    try {
      const bridge = require(bridgePath);
      if (typeof bridge.startServer === "function") {
        bridge.startServer(8318, "0.0.0.0")
          .then((srv) => {
            opencodeBridgeServer = srv;
            console.log("[9Router] Auto-started OpenCode Frontier Bridge on 0.0.0.0:8318");
          })
          .catch((err) => {
            if (err.code !== "EADDRINUSE") {
              console.error("[9Router] OpenCode bridge sidecar error:", err.message);
            }
          });
      }
    } catch (err) {
      console.error("[9Router] Failed to initialize OpenCode bridge sidecar:", err.message);
    }
  });

  const stop = () => {
    if (opencodeBridgeServer && typeof opencodeBridgeServer.close === "function") {
      try {
        opencodeBridgeServer.close();
        opencodeBridgeServer = null;
      } catch {}
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
    startOpenCodeBridgeFromCustomServer();
  });
  const origEmit = server.emit;
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
