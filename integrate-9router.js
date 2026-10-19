#!/usr/bin/env node

/**
 * 9Router Automated Sidecar Integrator
 * Integrates opencode-glm-bridge into 9Router so that running `9router`
 * automatically launches the OpenCode bridge in-process and reroutes
 * OpenCode requests to it with full anti-abuse cloaking.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function get9RouterPath() {
  const npmGlobal = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '9router')
    : path.join('/usr/local/lib/node_modules/9router');

  if (fs.existsSync(npmGlobal)) {
    return npmGlobal;
  }
  return null;
}

const ninerouterDir = get9RouterPath();
if (!ninerouterDir) {
  console.error('❌ 9Router installation not found in npm global modules.');
  process.exit(1);
}

const customServerPath = path.join(ninerouterDir, 'app', 'custom-server.js');
const backupPath = path.join(ninerouterDir, 'app', 'custom-server.js.bak');
const bridgePath = path.resolve(__dirname, 'server.js');

const action = process.argv[2] || 'install';

if (action === 'uninstall') {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, customServerPath);
    console.log('✅ Restored 9Router custom-server.js from backup.');
  } else {
    console.log('ℹ️ No backup found.');
  }
  process.exit(0);
}

if (action === 'status') {
  const content = fs.readFileSync(customServerPath, 'utf8');
  if (content.includes('startOpenCodeBridgeFromCustomServer')) {
    console.log('✅ 9Router is currently hooked with OpenCode Bridge.');
  } else {
    console.log('ℹ️ 9Router is NOT hooked with OpenCode Bridge.');
  }
  process.exit(0);
}

// Action: install / patch
if (!fs.existsSync(customServerPath)) {
  console.error('❌ custom-server.js not found in 9Router installation:', customServerPath);
  process.exit(1);
}

let content = fs.readFileSync(customServerPath, 'utf8');

if (content.includes('startOpenCodeBridgeFromCustomServer')) {
  console.log('✅ 9Router custom-server.js is already integrated with OpenCode Bridge!');
  process.exit(0);
}

// Create backup if not exists
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(customServerPath, backupPath);
  console.log(`📦 Created backup at: ${backupPath}`);
}

// Sidecar code to inject
const sidecarCode = `
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
                parsed.model = parsed.model.replace(/^opencode\\//, "");
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
  const bridgePath = process.env.OPENCODE_BRIDGE_PATH || ${JSON.stringify(bridgePath)};
  if (!fs.existsSync(bridgePath)) return;

  const net = require("net");
  const probe = net.connect({ host: "127.0.0.1", port: 8318 }, () => {
    probe.destroy();
  });

  probe.on("error", () => {
    try {
      const bridge = require(bridgePath);
      if (typeof bridge.startServer === "function") {
        bridge.startServer(8318, "127.0.0.1")
          .then((srv) => {
            opencodeBridgeServer = srv;
            console.log("[9Router] Auto-started OpenCode Frontier Bridge on 127.0.0.1:8318");
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
`;

// Inject sidecar before http.createServer
const targetMarker = 'http.createServer = (...args) => {';
if (!content.includes(targetMarker)) {
  console.error('❌ Target marker not found in custom-server.js');
  process.exit(1);
}

content = content.replace(targetMarker, `${sidecarCode}\n${targetMarker}`);

// Inject call into server.once("listening")
const listeningMarker = 'startBackgroundTokenRefreshFromCustomServer();';
if (content.includes(listeningMarker)) {
  content = content.replace(
    listeningMarker,
    `${listeningMarker}\n    startOpenCodeBridgeFromCustomServer();`
  );
} else {
  console.error('❌ Listening marker not found in custom-server.js');
  process.exit(1);
}

fs.writeFileSync(customServerPath, content, 'utf8');
console.log('⚡ Successfully integrated OpenCode Bridge into 9Router custom-server.js!');
console.log('Now you only need to run `9router` to use opencode/glm-5.3-flash-free and opencode/deepseek-v4.1-flash-free.');
