// Transmite la pantalla del PC a la TV (HLS) y la controla desde el teléfono.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = 8080;
const HLS_DIR = path.join(os.tmpdir(), 'tvcast');
const TOKEN_FILE = path.join(__dirname, '.token');

// Token fijo entre reinicios para no tener que reabrir el link en el teléfono.
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(4).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// ---------- Audio: busca un dispositivo que capture lo que suena en el PC ----------
function findAudioDevice() {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr;
  const names = [...out.matchAll(/"([^"]+)" \(audio\)/g)].map(m => m[1]);
  return names.find(n => /virtual-audio-capturer|stereo mix|mezcla est|cable output/i.test(n));
}

// ---------- ffmpeg: una captura -> HLS para la TV + MJPEG para el teléfono ----------
let latestFrame = null;
const previewClients = new Set();

function splitJpegs(buf, onFrame) {
  // En JPEG el byte 0xFF dentro de los datos va seguido de 0x00, así que FFD9 solo aparece al final.
  let end;
  while ((end = buf.indexOf(Buffer.from([0xff, 0xd9]))) !== -1) {
    onFrame(buf.subarray(0, end + 2));
    buf = buf.subarray(end + 2);
  }
  return buf;
}

if (process.argv.includes('--selftest')) {
  const assert = require('assert');
  const a = Buffer.from([0xff, 0xd8, 1, 0xff, 0x00, 0xff, 0xd9]), b = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
  const frames = [];
  let rest = splitJpegs(Buffer.concat([a, b.subarray(0, 3)]), f => frames.push(f));
  rest = splitJpegs(Buffer.concat([rest, b.subarray(3)]), f => frames.push(f));
  assert.deepStrictEqual(frames, [a, b]);
  assert.strictEqual(rest.length, 0);
  console.log('selftest ok');
  process.exit(0);
}

function startFfmpeg(audio) {
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });

  // Sincronización A/V (labios):
  //  - video: hora real de llegada SOLO del primer cuadro (STARTPTS); el resto sigue N/60.
  //  - audio: reloj nativo dshow ajustado a q0.
  // DirectShow tarda ~140ms más que ddagrab en inicializar y el buffer WASAPI agrega ~30ms.
  // AUDIO_OFFSET compensa ese retraso inicial fijo para alinear el sonido exacto con los labios.
  // aresample=async=1000 elimina el desvío progresivo en el tiempo sin encolar audio.
  const AUDIO_OFFSET = 0.150; // 150 ms de compensación de latencia de captura
  const t0 = (Date.now() / 1000).toFixed(3);
  const q0 = (Number(process.hrtime.bigint()) / 1e9).toFixed(3);
  const args = ['-hide_banner', '-loglevel', 'warning', '-copyts', '-use_wallclock_as_timestamps', '1', '-f', 'lavfi', '-i', 'ddagrab=framerate=60:output_idx=0'];
  if (audio) args.push('-f', 'dshow', '-audio_buffer_size', '20', '-i', `audio=${audio}`);
  args.push(
    '-filter_complex',
    // setpts=N/60: ddagrab entrega 60 cuadros/s pero con marcas desparejas (2–32 ms); al encajarlas en 60 fps fijos
    // ffmpeg descartaba unos y repetía otros (película de 24 fps con tirones). Marcas por número de cuadro = 1:1.
    // No usar la hora de llegada en cada cuadro: los que llegan juntos chocan y se descartan (bajó a ~8 fps).
    // shortcut: si la captura perdiera cuadros, el video se atrasaría respecto al audio; vigilar desfase de labios.
    `[0:v]hwdownload,format=bgra,setpts=N/(60*TB)+STARTPTS-${t0}/TB,split[a][b];[a]scale='min(1920,iw)':-2,format=nv12[tv];[b]fps=8,scale=640:-2[pv]` +
      (audio ? `;[1:a]asetpts=PTS-${q0}/TB-${AUDIO_OFFSET}/TB,aresample=async=1000:min_hard_comp=0.100000[au]` : ''),
    '-map', '[tv]', ...(audio ? ['-map', '[au]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : []),
    '-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cbr', '-b:v', '6M',
    // 60 = refresco del monitor: un video de 24 fps queda con el mismo ritmo que en el PC (a 30 fps se repetían cuadros de forma irregular).
    '-g', '60', '-bf', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    path.join(HLS_DIR, 'live.m3u8'),
    '-map', '[pv]', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'mjpeg', 'pipe:1'
  );

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  let lastFrameAt = Date.now();
  // ffmpeg puede quedarse colgado sin salir (p. ej. tras suspender/bloquear el PC): si no hay cuadros en 5 s, se reinicia.
  const watchdog = setInterval(() => {
    if (Date.now() - lastFrameAt > 5000) { console.log('ffmpeg sin cuadros 5 s, matándolo'); ff.kill(); }
  }, 1000);
  ff.stdout.on('data', chunk => {
    buf = splitJpegs(Buffer.concat([buf, chunk]), frame => {
      latestFrame = frame;
      lastFrameAt = Date.now();
      for (const res of previewClients) {
        if (res.writableNeedDrain) continue; // teléfono lento: salta el frame en vez de acumular retraso
        res.write(`--f\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      }
    });
  });
  ff.on('exit', code => {
    clearInterval(watchdog);
    console.log(`ffmpeg terminó (${code}), reiniciando en 2s...`);
    setTimeout(() => startFfmpeg(audio), 2000);
  });
}

// ---------- Entrada: PowerShell persistente que mueve mouse / teclado ----------
const input = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'input.ps1')], {
  stdio: ['pipe', 'inherit', 'inherit'],
});

const unit = v => Math.min(1, Math.max(0, Number(v) || 0)).toFixed(5);
function toCommand(m) {
  switch (m.t) {
    case 'click': case 'rclick': return `${m.t} ${unit(m.x)} ${unit(m.y)}`;
    case 'wheel': return `wheel ${Math.max(-1200, Math.min(1200, m.d | 0))}`;
    case 'key': return m.vk >= 1 && m.vk <= 254 ? `key ${m.vk | 0}` : null;
    case 'text': return typeof m.s === 'string' && m.s.length <= 500 ? `text ${Buffer.from(m.s).toString('base64')}` : null;
  }
  return null;
}

// ---------- HTTP y Seguridad ----------
const page = name => fs.readFileSync(path.join(__dirname, name));
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

function isLocalNetwork(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  const ip = req.socket.remoteAddress;
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' ||
         /^::ffff:192\.168\./.test(ip) || /^192\.168\./.test(ip) ||
         /^::ffff:10\./.test(ip) || /^10\./.test(ip) ||
         /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
         /^fe80::/.test(ip);
}

function checkAuth(req, url) {
  if (url.searchParams.get('k') === TOKEN) return true;
  if (req.headers['x-k'] === TOKEN) return true;
  const cookies = req.headers.cookie || '';
  if (cookies.includes(`token=${TOKEN}`)) return true;
  if (isLocalNetwork(req)) return true;
  return false;
}

function loginPage(error = false) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceso Remoto PC</title>
<style>
  :root { --bg: #111; --fg: #eee; --accent: #4af; --card: #1f1f1f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px system-ui, -apple-system, sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .card { background: var(--card); border-radius: 16px; padding: 28px 24px; width: 100%; max-width: 380px;
          text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.6); }
  h1 { font-size: 22px; margin: 0 0 12px; color: var(--accent); }
  p { font-size: 14px; color: #aaa; margin: 0 0 24px; line-height: 1.5; }
  input { width: 100%; background: #111; color: #fff; border: 1px solid #444; border-radius: 12px;
          padding: 14px; font-size: 20px; text-align: center; letter-spacing: 2px; outline: none; margin-bottom: 16px; }
  input:focus { border-color: var(--accent); }
  button { width: 100%; background: var(--accent); color: #000; font: inherit; font-size: 17px; font-weight: 600;
           border: 0; border-radius: 12px; padding: 14px; cursor: pointer; }
  button:active { opacity: 0.9; }
  .err { color: #f66; font-size: 13px; margin-top: 14px; }
</style>
</head>
<body>
<div class="card">
  <h1>🔒 Control Remoto PC</h1>
  <p>Introduce el token de seguridad para controlar tu PC desde el exterior.</p>
  <form onsubmit="event.preventDefault(); const t = document.getElementById('t').value.trim(); if (t) location.href = '/remote?k=' + encodeURIComponent(t);">
    <input id="t" placeholder="Token" autocomplete="off" autofocus required>
    <button>Conectar</button>
  </form>
  ${error ? '<div class="err">Token incorrecto</div>' : ''}
</div>
</body>
</html>`;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const authed = checkAuth(req, url);
  const setCookie = url.searchParams.get('k') === TOKEN
    ? { 'Set-Cookie': `token=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` }
    : {};

  // no-store: el navegador de la TV guardaba una versión vieja de la página y la seguía usando tras actualizarla.
  if (url.pathname === '/' || url.pathname === '/tv') {
    if (!authed) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage());
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...setCookie });
    return res.end(page('tv.html'));
  }
  if (url.pathname === '/remote') {
    if (!authed) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage());
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...setCookie });
    return res.end(page('remote.html'));
  }
  if (url.pathname.startsWith('/hls/')) {
    if (!authed) { res.writeHead(403); return res.end(); }
    const name = url.pathname.slice(5);
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(400); return res.end(); }
    return fs.readFile(path.join(HLS_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  }
  if (url.pathname === '/tvstat') { // DEBUG-LAG: solo avisa cuando la TV se queda casi sin colchón (riesgo de corte)
    if (Number(url.searchParams.get('ahead')) < 0.5) console.log(`[tvstat] ${new Date().toLocaleTimeString()} ${url.search}`);
    fs.appendFile(path.join(os.tmpdir(), 'tvstat.log'), `${new Date().toISOString()} ${url.search}\n`, () => {}); // DEBUG-LAG
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/preview') {
    if (!authed) { res.writeHead(403); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=f',
      'Cache-Control': 'no-cache, no-transform'
    });
    previewClients.add(res);
    req.on('close', () => previewClients.delete(res));
    return;
  }
  if (url.pathname === '/input' && req.method === 'POST') {
    const isInputAuth = req.headers['x-k'] === TOKEN ||
                        (req.headers.cookie && req.headers.cookie.includes(`token=${TOKEN}`)) ||
                        url.searchParams.get('k') === TOKEN ||
                        isLocalNetwork(req);
    if (!isInputAuth) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    return req.on('end', () => {
      let cmd = null;
      try { cmd = toCommand(JSON.parse(body)); } catch {}
      if (cmd) input.stdin.write(cmd + '\n');
      res.writeHead(cmd ? 204 : 400);
      res.end();
    });
  }
  res.writeHead(404);
  res.end();
}).on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`El puerto ${PORT} ya está en uso: el sistema ya está abierto en otra ventana.`);
  process.exit(1);
}).listen(PORT, () => {
  // "Conectar" UDP no envía nada; solo hace que el SO elija la interfaz de la ruta por defecto (la del router).
  const sock = require('dgram').createSocket('udp4');
  sock.connect(80, '8.8.8.8', () => { const ip = sock.address().address; sock.close(); ready(ip); });
});

// ---------- Cloudflare Tunnel (Acceso Remoto por Internet) ----------
let tunnelProc = null;
let tunnelUrl = null;

function ensureCloudflared() {
  const binDir = path.join(__dirname, 'bin');
  const binPath = path.join(binDir, 'cloudflared.exe');
  if (fs.existsSync(binPath)) return binPath;

  try {
    const test = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
    if (test.status === 0) return 'cloudflared';
  } catch {}

  try {
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    console.log('Descargando Cloudflare Tunnel para habilitar conexión remota...');
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    const res = spawnSync('curl.exe', ['-L', '-o', binPath, url], { stdio: 'inherit' });
    if (res.status === 0 && fs.existsSync(binPath)) {
      console.log('Cloudflare Tunnel descargado correctamente.');
      return binPath;
    }
  } catch (err) {
    console.error('Error al descargar cloudflared:', err.message);
  }
  return null;
}

function startTunnel() {
  const bin = ensureCloudflared();
  if (!bin) {
    console.log('\n[Aviso] No se pudo iniciar el túnel online (cloudflared no disponible).');
    return;
  }
  console.log('Iniciando túnel seguro a Internet (Cloudflare)...');
  tunnelProc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const onData = (buf) => {
    const text = buf.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      printOnlineReady(tunnelUrl);
    }
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);

  tunnelProc.on('exit', (code) => {
    tunnelUrl = null;
    if (code !== 0 && code !== null) {
      console.log(`Túnel desconectado (${code}), reconectando en 5s...`);
      setTimeout(startTunnel, 5000);
    }
  });
}

function printOnlineReady(url) {
  console.log('\n' + '='.repeat(64));
  console.log('         🌐 ACCESO ONLINE DESDE CUALQUIER LUGAR (INTERNET)');
  console.log('='.repeat(64));
  console.log(`Control Remoto: ${url}/remote?k=${TOKEN}`);
  console.log(`Transmisión TV: ${url}/tv?k=${TOKEN}`);
  console.log(`Token:          ${TOKEN}`);
  console.log('----------------------------------------------------------------');
  console.log('Escanea para abrir el control remoto en tu teléfono desde fuera:');
  try {
    require('qrcode-terminal').generate(`${url}/remote?k=${TOKEN}`, { small: true });
  } catch {}
  console.log('='.repeat(64) + '\n');
  try {
    fs.writeFileSync(path.join(__dirname, 'online.txt'), `Control: ${url}/remote?k=${TOKEN}\nTV: ${url}/tv?k=${TOKEN}\nToken: ${TOKEN}\n`);
  } catch {}
}

const cleanExit = () => {
  if (tunnelProc) {
    try { tunnelProc.kill(); } catch {}
  }
  process.exit();
};
process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('exit', () => {
  if (tunnelProc) {
    try { tunnelProc.kill(); } catch {}
  }
});

function ready(ip) {
  const audio = findAudioDevice();
  console.log('\n' + '='.repeat(64));
  console.log('         🏠 ACCESO LOCAL (MISMA RED WI-FI)');
  console.log('='.repeat(64));
  console.log(`TV:       http://${ip}:${PORT}/tv`);
  console.log(`Teléfono: http://${ip}:${PORT}/remote?k=${TOKEN}`);
  console.log('----------------------------------------------------------------');
  console.log('Escanea con la cámara del teléfono (misma red Wi-Fi):');
  require('qrcode-terminal').generate(`http://${ip}:${PORT}/remote?k=${TOKEN}`, { small: true });
  console.log(audio ? `Audio:    ${audio}` : 'Audio:    NO encontrado (instala virtual-audio-capturer o activa Mezcla estéreo). Transmitiendo sin sonido.');
  console.log('='.repeat(64) + '\n');
  startFfmpeg(audio);
  startTunnel();
}
