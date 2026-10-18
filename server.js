/**
 * OpenCode GLM-5.3 Standalone Bridge (OpenAI Compatible)
 * 
 * Reverse-engineered using REA (morluto/rea) on OpenCode v2.
 * Connects external clients (Cursor, Claude Code, Cline, Python, cURL)
 * to OpenCode's free GLM-5.3 frontier model without running the OpenCode UI.
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

const PORT = parseInt(process.env.PORT || config.port || 8318, 10);
const HOST = process.env.HOST || config.host || '127.0.0.1';
const PROXY_URL = process.env.OPENCODE_PROXY || config.proxy || '';

const UPSTREAM_BASE = config.upstreamUrl || 'https://opencode.ai';
const OPENCODE_CHAT_URL = `${UPSTREAM_BASE.replace(/\/$/, '')}/inference/v1/chat/completions`;
const OPENCODE_RESPONSES_URL = `${UPSTREAM_BASE.replace(/\/$/, '')}/inference/v1/responses`;
const OPENCODE_CLIENT_UA = 'opencode/latest/2.0.26/cli';

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
  const clean = clientModel.replace(/^opencode\//, '').trim();
  const found = (config.supportedModels || []).find(m => m.id === clean);
  if (found && found.upstreamId) return found.upstreamId;
  if (clean === 'glm-5.3' || clean === 'glm-5.3-flash') return 'glm-5.3-flash-free';
  return clean;
}

// 4. Request Cloaker & Normalizer
function cloakOpencodePayload(body, isResponses = false) {
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

  // Inject OpenCode's official tools
  for (const ft of officialFingerprintTools) {
    if (isResponses) {
      finalTools.push({
        type: 'function',
        name: ft.function.name,
        description: ft.function.description,
        parameters: ft.function.parameters
      });
    } else {
      finalTools.push(ft);
    }
  }

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

function restoreToolNamesInLine(line) {
  if (line.includes('read_client')) {
    line = line.replaceAll('read_client', 'read');
  }
  if (line.includes('shell_client')) {
    line = line.replaceAll('shell_client', 'shell');
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
      if (parsed.model) model = parsed.model;
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
                function: { name: '', arguments: '' }
              });
            }
            const current = toolCallsMap.get(idx);
            if (tc.id) current.id = tc.id;
            if (tc.function) {
              if (tc.function.name) {
                let fnName = tc.function.name;
                if (fnName === 'read_client') fnName = 'read';
                else if (fnName === 'shell_client') fnName = 'shell';
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

  const toolCalls = Array.from(toolCallsMap.values()).filter(t => t.function.name && t.function.name !== 'read' && t.function.name !== 'shell');
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

// 7. HTTP Server & Route Handler
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-requested-with');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Liveness / Health check
  if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'opencode-glm-bridge',
      version: '1.0.0',
      activeSessions: cachedSessions.size,
      proxyConfigured: Boolean(PROXY_URL)
    }, null, 2));
    return;
  }

  // Model list discovery (/v1/models)
  if (pathname === '/v1/models' && req.method === 'GET') {
    const modelsData = (config.supportedModels || []).map(m => ({
      id: m.id,
      object: 'model',
      created: 1710000000,
      owned_by: 'opencode-free',
      permission: [],
      root: m.id,
      parent: null
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: modelsData }, null, 2));
    return;
  }

  // Chat completions endpoint (/v1/chat/completions)
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
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
      const isResponsesUrl = upstreamModel.includes('muse-spark');
      const targetUrl = isResponsesUrl ? OPENCODE_RESPONSES_URL : OPENCODE_CHAT_URL;

      const cloakedBody = cloakOpencodePayload(body, isResponsesUrl);
      const sessionID = getOrCreateSession('opencode_global');
      const payloadBuffer = Buffer.from(JSON.stringify(cloakedBody), 'utf8');

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
        const upstreamRes = await makeUpstreamRequest(targetUrl, headers, payloadBuffer);

        if (upstreamRes.statusCode >= 400) {
          const errChunks = [];
          upstreamRes.on('data', c => errChunks.push(c));
          upstreamRes.on('end', () => {
            const errMsg = Buffer.concat(errChunks).toString('utf8');
            res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `OpenCode Upstream Error (${upstreamRes.statusCode}): ${errMsg}`,
                type: 'upstream_error'
              }
            }));
          });
          return;
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
              const restored = restoreToolNamesInLine(line);
              res.write(restored + '\n');
            }
          });

          upstreamRes.on('end', () => {
            if (buffer.trim()) {
              res.write(restoreToolNamesInLine(buffer) + '\n');
            }
            res.end();
            console.log(`[${new Date().toLocaleTimeString()}] << [Completed] Stream selesai dikirim ke client (${requestedModel})`);
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
              allLines.push(restoreToolNamesInLine(line));
            }
          });

          upstreamRes.on('end', () => {
            if (buffer.trim()) {
              allLines.push(restoreToolNamesInLine(buffer));
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

server.listen(PORT, HOST, () => {
  console.log(`[OpenCode GLM-5.3 Bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[OpenCode GLM-5.3 Bridge] Models endpoint: http://${HOST}:${PORT}/v1/models`);
  console.log(`[OpenCode GLM-5.3 Bridge] Chat endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
});
