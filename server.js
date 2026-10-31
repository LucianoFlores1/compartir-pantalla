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
  // Ambos flujos (video y audio) se anclan al mismo reloj real de pared (wallclock) con -use_wallclock_as_timestamps 1
  // y a la hora de arranque t0 (STARTPTS - t0).
  //  - Video: avanza por número de cuadro a 60 fps: N/(60*TB).
  //  - Audio: avanza por número de muestras a 48 kHz: N/(SR*TB), sincronizado muestra a muestra con el video.
  // Con aresample=async=1000:min_hard_comp=0.100000 se evitan desvíos progresivos (drift) y microcortes.
  const t0 = (Date.now() / 1000).toFixed(3);
  const args = ['-hide_banner', '-loglevel', 'warning', '-copyts', '-use_wallclock_as_timestamps', '1', '-f', 'lavfi', '-i', 'ddagrab=framerate=60:output_idx=0'];
  if (audio) args.push('-use_wallclock_as_timestamps', '1', '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${audio}`);
  args.push(
    '-filter_complex',
    // setpts=N/60: ddagrab entrega 60 cuadros/s pero con marcas desparejas (2–32 ms); al encajarlas en 60 fps fijos
    // ffmpeg descartaba unos y repetía otros (película de 24 fps con tirones). Marcas por número de cuadro = 1:1.
    // No usar la hora de llegada en cada cuadro: los que llegan juntos chocan y se descartan (bajó a ~8 fps).
    // shortcut: si la captura perdiera cuadros, el video se atrasaría respecto al audio; vigilar desfase de labios.
    `[0:v]hwdownload,format=bgra,setpts=N/(60*TB)+STARTPTS-${t0}/TB,split[a][b];[a]scale='min(1920,iw)':-2,format=nv12[tv];[b]fps=8,scale=640:-2[pv]` +
      (audio ? `;[1:a]asetpts=N/(SR*TB)+STARTPTS-${t0}/TB,aresample=async=1000:min_hard_comp=0.100000[au]` : ''),
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

// ---------- HTTP ----------
const page = name => fs.readFileSync(path.join(__dirname, name));
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // no-store: el navegador de la TV guardaba una versión vieja de la página y la seguía usando tras actualizarla.
  if (url.pathname === '/' || url.pathname === '/tv') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page('tv.html'));
  }
  if (url.pathname === '/remote') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page('remote.html'));
  }
  if (url.pathname.startsWith('/hls/')) {
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
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=f', 'Cache-Control': 'no-cache' });
    previewClients.add(res);
    req.on('close', () => previewClients.delete(res));
    return;
  }
  if (url.pathname === '/input' && req.method === 'POST') {
    if (req.headers['x-k'] !== TOKEN) { res.writeHead(403); return res.end(); }
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

function ready(ip) {
  const audio = findAudioDevice();
  console.log(`TV:       http://${ip}:${PORT}/tv`);
  console.log(`Teléfono: http://${ip}:${PORT}/remote?k=${TOKEN}`);
  console.log('\nEscanea con la cámara del teléfono (misma red Wi-Fi):');
  require('qrcode-terminal').generate(`http://${ip}:${PORT}/remote?k=${TOKEN}`, { small: true });
  console.log(audio ? `Audio:    ${audio}` : 'Audio:    NO encontrado (instala virtual-audio-capturer o activa Mezcla estéreo). Transmitiendo sin sonido.');
  startFfmpeg(audio);
}
