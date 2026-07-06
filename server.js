const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Carga .env si existe (desarrollo local)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  });
}

const { scheduleCrawler, getCachedDestinations } = require('./crawler');

const PORT = process.env.PORT || 3456;
const API_HOST = process.env.API_HOST;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

if (!API_HOST || !API_KEY || !API_SECRET) {
  console.error('ERROR: Variables de entorno API_HOST, API_KEY y API_SECRET son requeridas.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function generateSignature() {
  const ts = Math.floor(Date.now() / 1000);
  return crypto.createHash('sha256').update(API_KEY + API_SECRET + ts).digest('hex');
}

// Endpoints Hotelbeds permitidos a traves del proxy
const ALLOWED_API = [
  { method: 'POST',   pattern: /^\/hotel-api\/1\.0\/hotels$/ },
  { method: 'POST',   pattern: /^\/hotel-api\/1\.0\/checkrates$/ },
  { method: 'POST',   pattern: /^\/hotel-api\/1\.0\/bookings$/ },
  { method: 'DELETE', pattern: /^\/hotel-api\/1\.0\/bookings\/[^/]+(\?.*)?$/ },
  { method: 'GET',    pattern: /^\/hotel-content-api\/1\.0\/hotels\?.*$/ },
  { method: 'GET',    pattern: /^\/hotel-content-api\/1\.0\/locations\/destinations.*$/ },
];

// Origenes permitidos para usar el proxy (vacio en Origin/Referer = misma pagina)
const ALLOWED_HOSTS = ['xotics.mx', 'www.xotics.mx', 'localhost', '127.0.0.1'];
function originAllowed(req) {
  const ref = req.headers.origin || req.headers.referer || '';
  if (!ref) return true;
  try {
    const host = new URL(ref).hostname;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

// Rate limit simple por IP: 40 peticiones al proxy por minuto
const rateMap = new Map();
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateMap.set(ip, entry);
  if (rateMap.size > 5000) rateMap.clear();
  return entry.count > 40;
}

const server = http.createServer((req, res) => {
  // Endpoint: destinos desde cache del servidor (evita llamadas API del cliente)
  if (req.url === '/destinations') {
    const cached = getCachedDestinations();
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cached));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cache de destinos no disponible aun. Reintenta en unos segundos.' }));
    }
    return;
  }

  if (req.url.startsWith('/api/')) {
    const apiPath = req.url.replace('/api', '');

    // Proteccion del proxy: origen, rate limit y lista blanca de endpoints
    if (!originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Origen no permitido' } }));
      return;
    }
    if (rateLimited(req)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Demasiadas peticiones, intenta en un minuto' } }));
      return;
    }
    if (!ALLOWED_API.some(a => a.method === req.method && a.pattern.test(apiPath))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Endpoint no disponible' } }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const options = {
        hostname: API_HOST,
        path: apiPath,
        method: req.method,
        headers: {
          'Api-key': API_KEY,
          'X-Signature': generateSignature(),
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip',
        }
      };
      if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

      const proxyReq = https.request(options, proxyRes => {
        const encoding = proxyRes.headers['content-encoding'];
        let stream = proxyRes;
        if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());

        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        stream.pipe(res);
      });

      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
      });

      proxyReq.setTimeout(90000, () => {
        proxyReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Timeout — la API no respondió en 90s' } }));
      });

      if (body) proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  let filePath = path.join(__dirname, req.url === '/' ? '/hotelbeds-test.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Xotics Hotel Testing → http://localhost:${PORT}`);
  console.log('Proxy API → https://' + API_HOST);
  scheduleCrawler();
});
