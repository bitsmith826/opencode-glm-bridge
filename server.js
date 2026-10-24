/**
 * OpenCode Dual Frontier Bridge (OpenAI Compatible)
 * 
 * Reverse-engineered using REA (morluto/rea) on OpenCode v2.
 * Connects external clients (Cursor, Claude Code, Cline, Python, cURL)
 * to OpenCode's free GLM-5.3 and DeepSeek V4.1 frontier models without running the OpenCode UI.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

// 1. Load Configuration
const configPath = path.join(__dirname, 'config.json');
let config = {
  port: 8318,
  host: '127.0.0.1',
  proxy: '',
  supportedModels: []
};

if (fs.existsSync(configPath)) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch (err) {
    console.error('[Config] Error reading config.json:', err.message);
  }
}

// 1.1 Load Local Override (config.local.json) if present
const localConfigPath = path.join(__dirname, 'config.local.json');
if (fs.existsSync(localConfigPath)) {
  try {
    const rawLocal = fs.readFileSync(localConfigPath, 'utf8');
    config = { ...config, ...JSON.parse(rawLocal) };
    console.log('[Config] Loaded local override from config.local.json');
  } catch (err) {
    console.warn('[Config Warning] Failed to parse config.local.json:', err.message);
  }
}

const PORT = parseInt(process.env.OPENCODE_BRIDGE_PORT || config.port || 8318, 10);
const HOST = process.env.OPENCODE_BRIDGE_HOST || config.host || '127.0.0.1';
const PROXY_URL = process.env.OPENCODE_PROXY || config.proxy || '';

function getUpstreamPool() {
  const envUrls = process.env.OPENCODE_UPSTREAM_URLS ? process.env.OPENCODE_UPSTREAM_URLS.split(',').map(s => s.trim()).filter(Boolean) : null;
  const cfgUrls = Array.isArray(config.upstreamUrls) ? config.upstreamUrls.map(s => s.trim()).filter(Boolean) : null;
  const single = process.env.OPENCODE_UPSTREAM_URL || config.upstreamUrl;

  const raw = envUrls || cfgUrls || (single ? [single] : ['https://opencode.ai']);
  return raw.map(u => u.replace(/\/$/, ''));
}

const UPSTREAM_POOL = getUpstreamPool();
const UPSTREAM_BASE = UPSTREAM_POOL[0] || 'https://opencode.ai';
const OPENCODE_CHAT_URL = `${UPSTREAM_BASE}/inference/v1/chat/completions`;
const OPENCODE_CLIENT_UA = 'opencode/latest/2.0.26/cli';

// Cooldown tracker for multi-upstream failover: upstreamUrl -> cooldownUntilTimestamp
const upstreamCooldowns = new Map();
let currentRoundRobinIndex = 0;

function getAvailableUpstreamIndex(pool, startIndex = 0) {
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const cooldown = upstreamCooldowns.get(pool[idx]) || 0;
    if (now >= cooldown) return idx;
  }
  let earliestIdx = startIndex % pool.length;
  let minCooldown = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const cooldown = upstreamCooldowns.get(pool[idx]) || 0;
    if (cooldown < minCooldown) {
      minCooldown = cooldown;
      earliestIdx = idx;
    }
  }
  return earliestIdx;
}

const sessionPrefixMask = (1n << 48n) - 1n;
const base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastSessionTs = 0n;
let sessionCounter = 0n;
const cachedSessions = new Map();

function descendingTimeHex(ts, counter) {
  const combined = (BigInt(ts) * 0x1000n) + BigInt(counter);
  const inverted = (~combined) & sessionPrefixMask;
  return inverted.toString(16).padStart(12, '0');
}

function genSessionID() {
  const now = BigInt(Date.now());
  if (now !== lastSessionTs) {
    lastSessionTs = now;
    sessionCounter = 0n;
  }
  sessionCounter++;
  const timeHex = descendingTimeHex(now, sessionCounter);
  let randStr = '';
  const randBytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) {
    randStr += base62Chars[randBytes[i] % base62Chars.length];
  }
  return `ses_${timeHex}${randStr}`;
}

function getOrCreateSession(key = 'opencode_global') {
  // Always generate a fresh session ID to bypass per-session token accumulation
  return genSessionID();
}

// 2. Upstream Resilience & Retry Policy (Smart Anti-Freeze & Failover Engine)
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 1000,
  backoffFactor: 1.5,
  jitterFactor: 0.25,
  maxDelayMs: 4000,
  retryableStatuses: [408, 409, 429, 500, 502, 503, 504, 524],
  retryablePatterns: [
    /429|500|502|503|504|524/i,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
    /try your request again|retry your request|resource exhausted|resource_exhausted/i,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i
  ]
};

function calculateRetryDelay(attempt, responseHeaders = {}) {
  const retryAfterMs = responseHeaders['retry-after-ms'];
  if (retryAfterMs) {
    const parsed = parseFloat(retryAfterMs);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 5000) return parsed;
  }
  const retryAfter = responseHeaders['retry-after'];
  if (retryAfter) {
    const parsedSec = parseFloat(retryAfter);
    if (!isNaN(parsedSec) && parsedSec > 0 && parsedSec <= 10) return Math.ceil(parsedSec * 1000);
  }
  const base = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1);
  const jitter = base * RETRY_CONFIG.jitterFactor * Math.random();
  return Math.min(Math.ceil(base + jitter), RETRY_CONFIG.maxDelayMs);
}

// 3. Official Fingerprint Tools Schema (Extracted from OpenCode CLI v2)
const officialFingerprintTools = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to read' },
          offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
          limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to execute' },
          workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
          timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
          background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  }
];

// Model mapping resolver
function resolveUpstreamModel(clientModel) {
  if (!clientModel) return 'glm-5.3-flash-free';
  const clean = clientModel.replace(/^(opencode|opencode-free)\//, '').trim();
  const found = (config.supportedModels || []).find(m => m.id === clean || m.upstreamId === clean);
  if (found && found.upstreamId) return found.upstreamId;

  // Exact & friendly fallback aliases
  if (clean === 'glm-5.3' || clean === 'glm5.3' || clean === 'glm53' || clean === 'glm-5.3-flash' || clean === 'glm' || clean === 'glm-5.3-flash-free') return 'glm-5.3-flash-free';
  if (clean === 'deepseek' || clean === 'deepseek-v4.1' || clean === 'deepseekv4.1' || clean === 'deepseekv41' || clean === 'deepseek-v4' || clean === 'deepseekv4' || clean === 'deepseek-v4.1-flash' || clean === 'deepseek-v4.1-flash-free') return 'deepseek-v4.1-flash-free';
  // Note: minimax-m3.1-flash-free was deprecated by upstream OpenCode (HTTP 410) with instruction: "Use deepseek-v4.1-flash-free instead."
  if (clean === 'minimax' || clean === 'minimax-m3.1' || clean === 'minimaxm3.1' || clean === 'minimaxm31' || clean === 'minimax-m3.1-flash' || clean === 'minimax-m3.1-flash-free') return 'deepseek-v4.1-flash-free';
  if (clean === 'mimo' || clean === 'mimo-v2.6' || clean === 'mimov2.6' || clean === 'mimov26' || clean === 'mimo-v2.6-flash' || clean === 'mimo-v2.6-flash-free') return 'mimo-v2.6-flash-free';
  if (clean === 'beam' || clean === 'beam-free') return 'beam-free';
  if (clean === 'cat-jam' || clean === 'cat-jam-free') return 'cat-jam-free';
  if (clean === 'big-pickle') return 'big-pickle';
  if (clean === 'longcat' || clean === 'longcat-2.5' || clean === 'longcat-2.5-preview' || clean === 'longcat-2.5-preview-free') return 'longcat-2.5-preview-free';
  if (clean === 'nemotron-super-vl' || clean === 'nemotron-3.5-super-vl' || clean === 'nemotron-3.5-super-vl-free') return 'nemotron-3.5-super-vl-free';
  if (clean === 'nemotron-lightning' || clean === 'nemotron-3.5-lightning' || clean === 'nemotron-3.5-lightning-free') return 'nemotron-3.5-lightning-free';
  if (clean === 'nemotron-ultra' || clean === 'nemotron-3-ultra' || clean === 'nemotron-3-ultra-free') return 'nemotron-3-ultra-free';
  if (clean === 'flint' || clean === 'flint-40b' || clean === 'flint-40b-free') return 'flint-40b-free';
  return clean;
}

// 4. Request Cloaker & Normalizer
function cloakOpencodePayload(body) {
  const payload = JSON.parse(JSON.stringify(body));

  // Resolve upstream model name
  payload.model = resolveUpstreamModel(payload.model);

  // Remove editor-specific incompatible parameters that cause 400
  delete payload.reasoning_effort;
  delete payload.thinking;

  // Upstream must always be stream: true
  payload.stream = true;
  payload.stream_options = { include_usage: true };

  // Handle client tools vs fingerprint tools
  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const finalTools = [];

  for (const t of existingTools) {
    if (!t || typeof t !== 'object') continue;
    const cloned = { ...t };
    let name = '';
    if (cloned.function && typeof cloned.function === 'object') {
      cloned.function = { ...cloned.function };
      name = (cloned.function.name || '').trim();
      if (name === 'read') cloned.function.name = 'read_client';
      else if (name === 'shell') cloned.function.name = 'shell_client';
    } else if (cloned.name) {
      name = (cloned.name || '').trim();
      if (name === 'read') cloned.name = 'read_client';
      else if (name === 'shell') cloned.name = 'shell_client';
    }
    finalTools.push(cloned);
  }

  // Inject OpenCode's official fingerprint tools
  finalTools.push(...officialFingerprintTools);

  payload.tools = finalTools;
  payload.tool_choice = 'auto';

  // System instruction note to prevent hallucinated tool execution
  const note = "Do not call the `read` or `shell` tools; they are placeholders that do nothing. Answer the prompt directly or use other tools.";
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const firstMsg = payload.messages[0];
    if (firstMsg && firstMsg.role === 'system' && typeof firstMsg.content === 'string') {
      firstMsg.content = `${firstMsg.content}\n\n${note}`;
    } else {
      payload.messages.unshift({ role: 'system', content: note });
    }
  } else {
    payload.messages = [{ role: 'system', content: note }];
  }

  return payload;
}

function restoreToolNamesInLine(line, requestedModel = '') {
  if (line.includes('read_client')) {
    line = line.replace(/"name"\s*:\s*"read_client"/g, '"name":"read"');
  }
  if (line.includes('shell_client')) {
    line = line.replace(/"name"\s*:\s*"shell_client"/g, '"name":"shell"');
  }
  if (requestedModel && !requestedModel.includes('-free') && line.includes('-free')) {
    line = line.replace(/"model"\s*:\s*"[^"]+-free"/g, `"model":"${requestedModel}"`);
  }
  return line;
}

// 5. Upstream HTTP Dispatcher
function makeUpstreamRequest(targetUrlStr, headers, payloadBuffer) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(targetUrlStr);

    if (PROXY_URL) {
      const proxyUrl = new URL(PROXY_URL);
      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 8080,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:443`,
        headers: proxyUrl.username ? {
          'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64')
        } : {}
      });

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`Proxy CONNECT failed with status: ${res.statusCode}`));
        }
        const tlsSocket = tls.connect({
          host: targetUrl.hostname,
          socket: socket,
          servername: targetUrl.hostname
        }, () => {
          const req = https.request({
            host: targetUrl.hostname,
            path: targetUrl.pathname + targetUrl.search,
            method: 'POST',
            headers: headers,
            createConnection: () => tlsSocket
          });
          req.on('response', resolve);
          req.on('error', reject);
          req.write(payloadBuffer);
          req.end();
        });
        tlsSocket.on('error', reject);
      });

      connectReq.on('error', reject);
      connectReq.end();
    } else {
      const isHttps = targetUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const req = client.request({
        host: targetUrl.hostname,
        port: targetUrl.port ? parseInt(targetUrl.port, 10) : defaultPort,
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers: headers
      });
      req.on('response', resolve);
      req.on('error', reject);
      req.write(payloadBuffer);
      req.end();
    }
  });
}

// 6. Non-Streaming SSE Assembler
function assembleSSE(rawLines, fallbackModel) {
  let resID = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCallsMap = new Map();

  for (let line of rawLines) {
    line = line.trim();
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.id) resID = parsed.id;
      if (parsed.created) created = parsed.created;
      if (parsed.model) {
        model = (fallbackModel && !fallbackModel.includes('-free')) ? fallbackModel : parsed.model;
      }
      if (parsed.usage) usage = parsed.usage;

      if (Array.isArray(parsed.choices) && parsed.choices[0]) {
        const choice = parsed.choices[0];
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index !== undefined ? tc.index : 0;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
                type: 'function',
                function: { name: '', arguments: '' },
                isClientTool: false
              });
            }
            const current = toolCallsMap.get(idx);
            if (tc.id) current.id = tc.id;
            if (tc.function) {
              if (tc.function.name) {
                let fnName = tc.function.name;
                if (fnName === 'read_client') {
                  fnName = 'read';
                  current.isClientTool = true;
                } else if (fnName === 'shell_client') {
                  fnName = 'shell';
                  current.isClientTool = true;
                } else if (fnName !== 'read' && fnName !== 'shell') {
                  current.isClientTool = true;
                }
                current.function.name = fnName;
              }
              if (tc.function.arguments) {
                current.function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  const message = {
    role: 'assistant',
    content: content || null
  };

  if (reasoning) {
    message.reasoning_content = reasoning;
  }

  const toolCalls = Array.from(toolCallsMap.values()).filter(t => t.function.name && t.isClientTool);
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: resID,
    object: 'chat.completion',
    created: created,
    model: model,
    choices: [
      {
        index: 0,
        message: message,
        finish_reason: finishReason
      }
    ],
    usage: usage
  };
}

// Safe local & webview Origin check for CORS protection
function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true;
    if (u.protocol === 'vscode-webview:' || u.protocol === 'chrome-extension:' || u.protocol === 'moz-extension:') return true;
  } catch (_) {}
  return false;
}

// 7. HTTP Server & Route Handler
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Cross-Origin Forbidden', type: 'access_denied' } }));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Liveness / Health check
  if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
    const pool = getUpstreamPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'opencode-glm-bridge',
      version: '1.2.0',
      activeSessions: cachedSessions.size,
      proxyConfigured: Boolean(PROXY_URL),
      upstreams: pool.map((u, i) => ({
        index: i + 1,
        url: u,
        status: (Date.now() >= (upstreamCooldowns.get(u) || 0)) ? 'active' : 'cooldown',
        cooldownRemainingSec: Math.max(0, Math.ceil(((upstreamCooldowns.get(u) || 0) - Date.now()) / 1000))
      }))
    }, null, 2));
    return;
  }

  // Model list discovery (/v1/models or /models)
  if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
    const modelsData = [];
    const seen = new Set();
    for (const m of (config.supportedModels || [])) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        modelsData.push({
          id: m.id,
          object: 'model',
          created: 1710000000,
          owned_by: 'opencode',
          name: m.name,
          upstream_id: m.upstreamId,
          context_window: m.contextWindow,
          max_output_tokens: m.maxOutput,
          permission: [],
          root: m.id,
          parent: null
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: modelsData }, null, 2));
    return;
  }

  // Chat completions endpoint (/v1/chat/completions or /chat/completions)
  if ((pathname === '/v1/chat/completions' || pathname === '/chat/completions') && req.method === 'POST') {
    const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB payload limit
    const contentLength = parseInt(req.headers['content-length'], 10);
    if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
      res.writeHead(413, { 
        'Content-Type': 'application/json',
        'Connection': 'close'
      });
      res.end(JSON.stringify({
        error: {
          message: `Payload Too Large: request body exceeds maximum allowed limit of ${MAX_BODY_BYTES / (1024 * 1024)}MB`,
          type: 'invalid_request_error'
        }
      }));
      req.on('data', () => {});
      req.resume();
      return;
    }

    let receivedBytes = 0;
    let exceeded = false;
    const chunks = [];

    req.on('data', chunk => {
      if (exceeded) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 
          'Content-Type': 'application/json',
          'Connection': 'close'
        });
        res.end(JSON.stringify({
          error: {
            message: `Payload Too Large: request body exceeds maximum allowed limit of ${MAX_BODY_BYTES / (1024 * 1024)}MB`,
            type: 'invalid_request_error'
          }
        }));
        req.on('data', () => {});
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (exceeded) return;
      let body;
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        body = JSON.parse(rawBody);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request payload', type: 'invalid_request_error' } }));
        return;
      }

      const clientRequestedStream = Boolean(body.stream);
      const requestedModel = (body.model || 'glm-5.3').trim();
      const timeStr = new Date().toLocaleTimeString();
      console.log(`[${timeStr}] >> [Incoming Request] Model: ${requestedModel} | Stream: ${clientRequestedStream}`);
      const upstreamModel = resolveUpstreamModel(requestedModel);
      const cloakedBody = cloakOpencodePayload(body);
      const payloadBuffer = Buffer.from(JSON.stringify(cloakedBody), 'utf8');

      const pool = getUpstreamPool();
      let activeUpstreamIdx = getAvailableUpstreamIndex(pool, currentRoundRobinIndex);
      currentRoundRobinIndex = (activeUpstreamIdx + 1) % pool.length;

      try {
        let upstreamRes = null;
        let lastErrBody = '';

        for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
          const currentUpstream = pool[activeUpstreamIdx];
          const targetUrl = `${currentUpstream}/inference/v1/chat/completions`;
          const sessionID = getOrCreateSession('opencode_global');
          const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer public',
            'User-Agent': OPENCODE_CLIENT_UA,
            'x-opencode-client': 'cli',
            'x-opencode-project': 'global',
            'x-opencode-session-id': sessionID,
            'x-opencode-session': sessionID,
            'x-session-affinity': sessionID,
            'x-session-id': sessionID,
            'Accept': 'text/event-stream',
            'Content-Length': payloadBuffer.length
          };

          try {
            upstreamRes = await makeUpstreamRequest(targetUrl, headers, payloadBuffer);

            if (upstreamRes.statusCode === 200) {
              break;
            }

            const errChunks = [];
            upstreamRes.on('data', c => errChunks.push(c));
            await new Promise(resolve => upstreamRes.on('end', resolve));
            lastErrBody = Buffer.concat(errChunks).toString('utf8');

            const isModelUnavailable = upstreamRes.statusCode === 400 || lastErrBody.includes('Model is unavailable');
            if (isModelUnavailable) {
              res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: {
                  message: `OpenCode Upstream Error (${upstreamRes.statusCode}): ${lastErrBody}`,
                  type: 'upstream_error'
                }
              }));
              return;
            }

            // Detect Hard Daily Rate Limit (FreeUsageLimitError or long retry-after)
            const isHardDailyLimit = upstreamRes.statusCode === 429 &&
              (lastErrBody.includes('FreeUsageLimitError') ||
               (upstreamRes.headers['retry-after'] && parseFloat(upstreamRes.headers['retry-after']) > 60));

            if (isHardDailyLimit) {
              const retryAfterSec = parseFloat(upstreamRes.headers['retry-after']) || 600;
              const cooldownMs = Math.min(retryAfterSec * 1000, 24 * 3600 * 1000);
              upstreamCooldowns.set(currentUpstream, Date.now() + cooldownMs);
              console.warn(`[${new Date().toLocaleTimeString()}] [Rate Limit Alert] Upstream ${currentUpstream} reached daily limit (${lastErrBody.slice(0, 80)}). Cooldown for ${Math.ceil(cooldownMs / 1000)}s.`);

              // Check if another relay is available in the pool
              const nextIdx = getAvailableUpstreamIndex(pool, activeUpstreamIdx + 1);
              const nextCooldown = upstreamCooldowns.get(pool[nextIdx]) || 0;
              if (pool.length > 1 && nextIdx !== activeUpstreamIdx && Date.now() >= nextCooldown) {
                console.log(`[${new Date().toLocaleTimeString()}] [Instant Failover] Switching immediately (0ms) to next relay [${nextIdx + 1}/${pool.length}]: ${pool[nextIdx]}`);
                activeUpstreamIdx = nextIdx;
                continue; // Instant retry with fresh relay without delay!
              } else {
                // All relays in pool exhausted or only 1 relay configured: FAIL FAST (0ms delay) to prevent editor freezing!
                console.warn(`[${new Date().toLocaleTimeString()}] [Anti-Freeze Fail-Fast] All available relays are rate-limited. Returning instant error response.`);
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: {
                    message: `OpenCode Free Tier daily rate limit reached on relay (${currentUpstream}). Upstream resets at 00:00 UTC. To continue, add more Cloudflare Worker relays in config.json or configure a proxy.`,
                    type: 'rate_limit_error',
                    code: 'free_usage_limit_exhausted',
                    retry_after: retryAfterSec
                  }
                }));
                return;
              }
            }

            // Transient retryable error (500, 502, 503, 504, 524, or temporary 429 Endpoint unavailable)
            const isRetryable = RETRY_CONFIG.retryableStatuses.includes(upstreamRes.statusCode) ||
              RETRY_CONFIG.retryablePatterns.some(p => p.test(lastErrBody));

            if (isRetryable && attempt < RETRY_CONFIG.maxRetries) {
              const delay = calculateRetryDelay(attempt, upstreamRes.headers);
              console.warn(`[${new Date().toLocaleTimeString()}] [Upstream Retry ${attempt}/${RETRY_CONFIG.maxRetries}] HTTP ${upstreamRes.statusCode}. Waiting ${delay}ms before next attempt... Error: ${lastErrBody.slice(0, 100)}`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }

            res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `OpenCode Upstream Error (${upstreamRes.statusCode}): ${lastErrBody}`,
                type: 'upstream_error'
              }
            }));
            return;
          } catch (netErr) {
            console.warn(`[${new Date().toLocaleTimeString()}] [Connection Error attempt ${attempt}/${RETRY_CONFIG.maxRetries}] ${currentUpstream}: ${netErr.message}`);

            // On network error, check if another relay is available
            const nextIdx = getAvailableUpstreamIndex(pool, activeUpstreamIdx + 1);
            if (pool.length > 1 && nextIdx !== activeUpstreamIdx) {
              console.log(`[${new Date().toLocaleTimeString()}] [Net Failover] Relay error, switching immediately to next relay: ${pool[nextIdx]}`);
              activeUpstreamIdx = nextIdx;
              continue;
            }

            if (attempt < RETRY_CONFIG.maxRetries) {
              const delay = calculateRetryDelay(attempt);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `Bridge connection error: ${netErr.message}`,
                type: 'gateway_error'
              }
            }));
            return;
          }
        }

        if (clientRequestedStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });

          let buffer = '';
          upstreamRes.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (let line of lines) {
              const restored = restoreToolNamesInLine(line, requestedModel);
              res.write(restored + '\n');
            }
          });

          upstreamRes.on('end', () => {
            if (buffer.trim()) {
              res.write(restoreToolNamesInLine(buffer, requestedModel) + '\n');
            }
            res.end();
            console.log(`[${new Date().toLocaleTimeString()}] << [Completed] Stream selesai dikirim ke client (${requestedModel})`);
          });

          req.on('close', () => {
            if (upstreamRes && !upstreamRes.destroyed) {
              upstreamRes.destroy();
            }
          });

          upstreamRes.on('error', err => {
            console.error('[Upstream Stream Error]:', err.message);
            res.end();
          });
        } else {
          const allLines = [];
          let buffer = '';
          upstreamRes.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              allLines.push(restoreToolNamesInLine(line, requestedModel));
            }
          });

          upstreamRes.on('end', () => {
            if (buffer.trim()) {
              allLines.push(restoreToolNamesInLine(buffer, requestedModel));
            }
            const assembled = assembleSSE(allLines, requestedModel);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(assembled, null, 2));
            console.log(`[${new Date().toLocaleTimeString()}] << [Completed] Respons JSON selesai dikirim ke client (${requestedModel})`);
          });

          upstreamRes.on('error', err => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message, type: 'bad_gateway' } }));
          });
        }
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Gateway dispatch failure: ${err.message}`, type: 'bad_gateway' } }));
      }
    });
    return;
  }

  // Not Found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${req.method} ${pathname} not found`, type: 'invalid_request_error' } }));
});

function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[OpenCode Dual Frontier Bridge] Port ${port} is already active.`);
        resolve(server);
      } else {
        console.error(`[OpenCode Dual Frontier Bridge] Server error:`, err);
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      console.log('===========================================================');
      console.log('   🚀 OpenCode Dual Frontier Bridge (OpenAI-Compatible)');
      console.log('===========================================================');
      console.log(`   Status   : Online & Listening on http://${host}:${port}`);
      const pool = getUpstreamPool();
      if (pool.length > 1) {
        console.log(`   Upstreams (${pool.length} Relays Failover Pool):`);
        pool.forEach((u, i) => {
          console.log(`     [${i + 1}] ${u}`);
        });
      } else {
        console.log(`   Upstream : ${pool[0] || 'https://opencode.ai'}`);
      }
      console.log('   Models   :');
      (config.supportedModels || []).forEach((m, i) => {
        const ctxStr = m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(m.contextWindow % 1000000 === 0 ? 0 : 1)}M` : `${Math.round(m.contextWindow / 1000)}k`;
        const outStr = m.maxOutput >= 1000 ? `${Math.round(m.maxOutput / 1000)}k` : `${m.maxOutput}`;
        console.log(`     [${(i + 1).toString().padStart(2)}] ${m.id.padEnd(23)} (${m.name} | ${ctxStr} ctx / ${outStr} out)`);
      });
      console.log('-----------------------------------------------------------');
      console.log('   Client Settings (Cursor / Cline / 9Router):');
      console.log(`     Base URL : http://${host}:${port}/v1`);
      console.log('     API Key  : free (bebas / sembarang teks)');
      console.log('-----------------------------------------------------------');
      console.log(`   Discovery: http://${host}:${port}/v1/models`);
      console.log(`   Chat API : http://${host}:${port}/v1/chat/completions`);
      console.log('===========================================================');
      console.log('   Waiting for incoming requests from 9Router / Cursor...\n');
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  server,
  startServer,
  config,
  PORT,
  HOST,
  PROXY_URL,
  UPSTREAM_BASE,
  UPSTREAM_POOL,
  getUpstreamPool,
  upstreamCooldowns,
  OPENCODE_CHAT_URL,
  OPENCODE_CLIENT_UA,
  genSessionID,
  getOrCreateSession,
  resolveUpstreamModel,
  cloakOpencodePayload,
  restoreToolNamesInLine,
  makeUpstreamRequest,
  assembleSSE
};
