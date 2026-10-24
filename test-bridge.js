/**
 * Automated Verification Suite for OpenCode Frontier Bridge
 */

const http = require('node:http');
const { startServer } = require('./server.js');

const TEST_PORT = 8399;
const TEST_HOST = '127.0.0.1';

function request(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: TEST_HOST,
      port: TEST_PORT,
      path: path,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw
        });
      });
    });
    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== [OpenCode Frontier Bridge: Test Suite] ===\n');
  const serverInstance = await startServer(TEST_PORT, TEST_HOST);
  let passed = 0;
  let total = 0;

  async function assertTest(name, fn) {
    total++;
    process.stdout.write(`[Test ${total}] ${name} ... `);
    try {
      await fn();
      console.log('PASSED');
      passed++;
    } catch (err) {
      console.log('FAILED');
      console.error(`   Error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    // 1. Health check
    await assertTest('Health check GET /health', async () => {
      const res = await request('/health');
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
      const data = JSON.parse(res.body);
      if (data.status !== 'ok') throw new Error(`Expected status: 'ok', got ${data.status}`);
      if (!Array.isArray(data.upstreams)) throw new Error('Missing upstreams array');
    });

    // 2. Models list
    await assertTest('Model discovery GET /v1/models', async () => {
      const res = await request('/v1/models');
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
      const data = JSON.parse(res.body);
      if (!Array.isArray(data.data) || data.data.length !== 3) throw new Error(`Expected exactly 3 models, got ${data.data?.length}`);
      const ids = data.data.map(m => m.id);
      if (!ids.includes('glm-5.3-flash-free')) throw new Error('Missing glm-5.3-flash-free');
      if (!ids.includes('deepseek-v4.1-flash-free')) throw new Error('Missing deepseek-v4.1-flash-free');
      if (!ids.includes('mimo-v2.6-flash-free')) throw new Error('Missing mimo-v2.6-flash-free');
    });

    // 3. GLM-5.3 Streaming Chat Completion
    await assertTest('Streaming Chat: glm-5.3 (or Fail-Fast 429)', async () => {
      const payload = {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'Say "GLM OK" in 2 words.' }],
        stream: true
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode === 200) {
        if (!res.body.includes('data:')) throw new Error('Response did not contain SSE data chunks');
      } else if (res.statusCode === 429) {
        const err = JSON.parse(res.body);
        if (err.error?.code !== 'free_usage_limit_exhausted') throw new Error(`Unexpected 429 error: ${res.body}`);
      } else {
        throw new Error(`Unexpected status ${res.statusCode}: ${res.body}`);
      }
    });

    // 4. DeepSeek V4.1 Non-Streaming Chat Completion
    await assertTest('Non-Streaming Chat: deepseek-v4.1 (or Fail-Fast 429)', async () => {
      const payload = {
        model: 'deepseek-v4.1',
        messages: [{ role: 'user', content: 'Say "DeepSeek JSON" in 2 words.' }],
        stream: false
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error('Invalid chat completion response structure');
        }
      } else if (res.statusCode === 429) {
        const err = JSON.parse(res.body);
        if (err.error?.code !== 'free_usage_limit_exhausted') throw new Error(`Unexpected 429 error: ${res.body}`);
      } else {
        throw new Error(`Unexpected status ${res.statusCode}: ${res.body}`);
      }
    });

    // 5. MiMo V2.6 Streaming Chat Completion
    await assertTest('Streaming Chat: mimo-v2.6 (or Fail-Fast 429)', async () => {
      const payload = {
        model: 'mimo-v2.6',
        messages: [{ role: 'user', content: 'Say "MiMo OK" in 2 words.' }],
        stream: true
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode === 200) {
        if (!res.body.includes('data:')) throw new Error('Response did not contain SSE data chunks');
      } else if (res.statusCode === 429) {
        const err = JSON.parse(res.body);
        if (err.error?.code !== 'free_usage_limit_exhausted') throw new Error(`Unexpected 429 error: ${res.body}`);
      } else {
        throw new Error(`Unexpected status ${res.statusCode}: ${res.body}`);
      }
    });

    // 6. Security: CORS Origin Check
    await assertTest('Security: CORS Preflight Origin Policy', async () => {
      // Untrusted external origin should be blocked with 403
      const untrustedRes = await request('/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://malicious-site.example',
          'Access-Control-Request-Method': 'POST'
        }
      });
      if (untrustedRes.statusCode !== 403) {
        throw new Error(`Expected 403 for untrusted origin, got ${untrustedRes.statusCode}`);
      }

      // Local origin should be permitted with 204
      const localRes = await request('/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST'
        }
      });
      if (localRes.statusCode !== 204) {
        throw new Error(`Expected 204 for local origin, got ${localRes.statusCode}`);
      }
      if (localRes.headers['access-control-allow-origin'] !== 'http://localhost:3000') {
        throw new Error(`Expected local origin reflected, got ${localRes.headers['access-control-allow-origin']}`);
      }
    });

    // 7. Security: Body Size Limit (HTTP 413 Payload Too Large)
    await assertTest('Security: Reject Oversized Body (>10MB) with 413', async () => {
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': (11 * 1024 * 1024).toString()
        }
      });
      if (res.statusCode !== 413) {
        throw new Error(`Expected 413 Payload Too Large, got ${res.statusCode}`);
      }
      const data = JSON.parse(res.body);
      if (!data.error?.message?.includes('Payload Too Large')) {
        throw new Error(`Unexpected error message: ${res.body}`);
      }
    });

  } finally {
    serverInstance.close();
    console.log(`\nResults: ${passed}/${total} tests passed.`);
  }

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
