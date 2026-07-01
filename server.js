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
