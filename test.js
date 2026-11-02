const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  splitJpegs,
  toCommand,
  isLocalNetwork,
  checkAuth,
  loginPage,
  getCookieHeader,
  handleHttpRequest,
  TOKEN,
  HLS_DIR
} = require('./server.js');

let passed = 0;
let total = 0;

function it(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function itAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('\n--- Ejecutando Batería de Tests de Antigravity ---');

// 1. JPEG splitter
it('splitJpegs divide correctamente cuadros JPEG consecutivos', () => {
  const a = Buffer.from([0xff, 0xd8, 1, 0xff, 0x00, 0xff, 0xd9]);
  const b = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
  const frames = [];
  let rest = splitJpegs(Buffer.concat([a, b.subarray(0, 3)]), f => frames.push(f));
  rest = splitJpegs(Buffer.concat([rest, b.subarray(3)]), f => frames.push(f));
  assert.deepStrictEqual(frames, [a, b]);
  assert.strictEqual(rest.length, 0);
});

// 2. toCommand
it('toCommand convierte eventos de entrada correctamente y restringe valores', () => {
  assert.strictEqual(toCommand({ t: 'click', x: 0.5, y: 0.25 }), 'click 0.50000 0.25000');
  assert.strictEqual(toCommand({ t: 'rclick', x: 1.5, y: -0.1 }), 'rclick 1.00000 0.00000');
  assert.strictEqual(toCommand({ t: 'wheel', d: 1500 }), 'wheel 1200');
  assert.strictEqual(toCommand({ t: 'wheel', d: -3000 }), 'wheel -1200');
  assert.strictEqual(toCommand({ t: 'key', vk: 13 }), 'key 13');
  assert.strictEqual(toCommand({ t: 'key', vk: 999 }), null);
  assert.strictEqual(toCommand({ t: 'text', s: 'hola' }), `text ${Buffer.from('hola').toString('base64')}`);
  assert.strictEqual(toCommand({ t: 'unknown' }), null);
});

// 3. isLocalNetwork
it('isLocalNetwork identifica redes locales y bloquea túneles externos', () => {
  const localReq = { headers: {}, socket: { remoteAddress: '192.168.1.50' } };
  assert.strictEqual(isLocalNetwork(localReq), true);

  const loopbackReq = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.strictEqual(isLocalNetwork(loopbackReq), true);

  const tunnelReq = {
    headers: { 'cf-connecting-ip': '203.0.113.195', 'cf-ray': 'abc123' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.strictEqual(isLocalNetwork(tunnelReq), false);
});

// 4. checkAuth
it('checkAuth valida token por URL, headers y cookies', () => {
  const tunnelHeaders = { 'cf-connecting-ip': '203.0.113.195' };

  // URL query param
  const urlWithK = new URL(`http://x/remote?k=${TOKEN}`);
  assert.strictEqual(checkAuth({ headers: tunnelHeaders, socket: {} }, urlWithK), true);

  // Header x-k
  const urlWithoutK = new URL('http://x/remote');
  assert.strictEqual(checkAuth({ headers: { ...tunnelHeaders, 'x-k': TOKEN }, socket: {} }, urlWithoutK), true);

  // Cookie
  assert.strictEqual(checkAuth({ headers: { ...tunnelHeaders, cookie: `token=${TOKEN}` }, socket: {} }, urlWithoutK), true);

  // Sin autenticación desde Internet -> rechazar
  assert.strictEqual(checkAuth({ headers: tunnelHeaders, socket: {} }, urlWithoutK), false);
});

// 5. getCookieHeader
it('getCookieHeader aplica SameSite=None; Secure en HTTPS/Túnel', () => {
  const httpsReq = { headers: { 'x-forwarded-proto': 'https' } };
  const cookieHttps = getCookieHeader(httpsReq);
  assert(cookieHttps.includes('SameSite=None; Secure'));
  assert(cookieHttps.includes(`token=${TOKEN}`));

  const httpReq = { headers: {} };
  const cookieHttp = getCookieHeader(httpReq);
  assert(cookieHttp.includes('SameSite=Lax'));
});

// 6. loginPage
it('loginPage genera formulario de acceso con destino dinámico', () => {
  const htmlRemote = loginPage('/remote');
  assert(htmlRemote.includes("location.href = '/remote?k='"));
  assert(htmlRemote.includes('Token'));

  const htmlTv = loginPage('/tv');
  assert(htmlTv.includes("location.href = '/tv?k='"));
});

// 7. Servidor HTTP y Reescritura de HLS
(async () => {
  const testServer = http.createServer(handleHttpRequest);
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const testPort = testServer.address().port;

  const request = (path, headers = {}, method = 'GET', body = null) => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path,
        method,
        headers: { 'cf-connecting-ip': '203.0.113.195', ...headers } // simular acceso online
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };

  await itAsync('GET /remote sin token muestra login para acceso externo', async () => {
    const res = await request('/remote');
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('Control Remoto PC'));
    assert(res.data.includes('/remote?k='));
  });

  await itAsync('GET /remote?k=TOKEN entrega página y establece cookie', async () => {
    const res = await request(`/remote?k=${TOKEN}`);
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('<!DOCTYPE html>'));
    assert(res.headers['set-cookie']);
    assert(res.headers['set-cookie'][0].includes(`token=${TOKEN}`));
  });

  await itAsync('GET /tv sin token muestra login para acceso externo', async () => {
    const res = await request('/tv');
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('Control Remoto PC'));
    assert(res.data.includes('/tv?k='));
  });

  await itAsync('GET /preview sin autenticación devuelve 403 Forbidden', async () => {
    const res = await request('/preview');
    assert.strictEqual(res.status, 403);
  });

  await itAsync('POST /input sin token devuelve 403 Forbidden', async () => {
    const res = await request('/input', {}, 'POST', JSON.stringify({ t: 'click', x: 0.5, y: 0.5 }));
    assert.strictEqual(res.status, 403);
  });

  await itAsync('Reescritura de HLS: .m3u8 adjunta ?k=TOKEN a cada segmento .ts', async () => {
    fs.mkdirSync(HLS_DIR, { recursive: true });
    const manifestPath = path.join(HLS_DIR, 'test_playlist.m3u8');
    fs.writeFileSync(manifestPath, '#EXTM3U\n#EXTINF:1.0,\nlive0.ts\n#EXTINF:1.0,\nlive1.ts\n');

    const res = await request(`/hls/test_playlist.m3u8?k=${TOKEN}`);
    assert.strictEqual(res.status, 200);
    assert(res.data.includes(`live0.ts?k=${TOKEN}`));
    assert(res.data.includes(`live1.ts?k=${TOKEN}`));
    fs.unlinkSync(manifestPath);
  });

  testServer.close();

  console.log(`\nTests finalizados: ${passed} de ${total} pasaron.`);
  if (passed === total) {
    console.log('✓ Todos los tests pasaron exitosamente.\n');
  } else {
    process.exit(1);
  }
})();
