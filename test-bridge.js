/**
 * Automated Verification Suite for OpenCode Dual Frontier Bridge
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
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('=== [OpenCode Dual Frontier Bridge: Test Suite] ===\n');
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
  }

  try {
    // 1. Health check
    await assertTest('Health check GET /health', async () => {
      const res = await request('/health');
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
      const data = JSON.parse(res.body);
      if (data.status !== 'ok') throw new Error(`Expected status: 'ok', got ${data.status}`);
    });

    // 2. Models list
    await assertTest('Model discovery GET /v1/models', async () => {
      const res = await request('/v1/models');
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
      const data = JSON.parse(res.body);
      if (!Array.isArray(data.data) || data.data.length === 0) throw new Error('Models array is empty');
      const ids = data.data.map(m => m.id);
      if (!ids.includes('glm-5.3-flash-free')) throw new Error('Missing glm-5.3-flash-free');
      if (!ids.includes('deepseek-v4.1-flash-free')) throw new Error('Missing deepseek-v4.1-flash-free');
    });

    // 3. GLM-5.3 Streaming Chat Completion
    await assertTest('Streaming Chat: glm-5.3-flash-free', async () => {
      const payload = {
        model: 'glm-5.3-flash-free',
        messages: [{ role: 'user', content: 'Say "GLM OK" in 2 words.' }],
        stream: true
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${res.body}`);
      if (!res.body.includes('data:')) throw new Error('Response did not contain SSE data chunks');
      if (!res.body.includes('[DONE]')) throw new Error('SSE stream was not terminated with [DONE]');
    });

    // 4. GLM-5.3 Non-Streaming Chat Completion
    await assertTest('Non-Streaming Chat: glm-5.3-flash-free', async () => {
      const payload = {
        model: 'glm-5.3-flash-free',
        messages: [{ role: 'user', content: 'Say "GLM JSON" in 2 words.' }],
        stream: false
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${res.body}`);
      const data = JSON.parse(res.body);
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid chat completion response structure');
      }
      if (!data.choices[0].message.content) {
        throw new Error('Assistant content was empty');
      }
    });

    // 5. DeepSeek V4.1 Streaming Chat Completion
    await assertTest('Streaming Chat: deepseek-v4.1-flash-free', async () => {
      const payload = {
        model: 'deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'Say "DeepSeek OK" in 2 words.' }],
        stream: true
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${res.body}`);
      if (!res.body.includes('data:')) throw new Error('Response did not contain SSE data chunks');
      if (!res.body.includes('[DONE]')) throw new Error('SSE stream was not terminated with [DONE]');
    });

    // 6. DeepSeek V4.1 Non-Streaming Chat Completion
    await assertTest('Non-Streaming Chat: deepseek-v4.1-flash-free', async () => {
      const payload = {
        model: 'deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'Say "DeepSeek JSON" in 2 words.' }],
        stream: false
      };
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);
      if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${res.body}`);
      const data = JSON.parse(res.body);
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid chat completion response structure');
      }
      if (!data.choices[0].message.content) {
        throw new Error('Assistant content was empty');
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
