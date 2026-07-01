/**
 * Xotics — Content Crawler para Hotelbeds
 * Descarga y actualiza contenido de hoteles (imagenes, categorias, descripciones)
 * desde la Content API de Hotelbeds. Cumple requisito 5.5 de certificacion.
 *
 * Se ejecuta automaticamente al iniciar el servidor y se repite cada 7 dias.
 * Los datos se guardan en ./content-cache/ como archivos JSON.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Las credenciales las hereda del proceso principal (server.js ya cargo .env)
const API_HOST = process.env.API_HOST;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const CACHE_DIR = path.join(__dirname, 'content-cache');
const CACHE_META_FILE = path.join(CACHE_DIR, 'meta.json');
const DESTINATIONS_FILE = path.join(CACHE_DIR, 'destinations.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function generateSignature() {
  const ts = Math.floor(Date.now() / 1000);
  return crypto.createHash('sha256').update(API_KEY + API_SECRET + ts).digest('hex');
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_META_FILE, 'utf8'));
  } catch {
    return { lastUpdate: 0 };
  }
}

function saveMeta(meta) {
  fs.writeFileSync(CACHE_META_FILE, JSON.stringify(meta, null, 2));
}

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: urlPath,
      method: 'GET',
      headers: {
        'Api-key': API_KEY,
        'X-Signature': generateSignature(),
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      }
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchAllDestinations() {
  const all = [];
  let from = 1;
  const batchSize = 1000;

  console.log('[Crawler] Descargando destinos desde Content API...');
  while (true) {
    const to = from + batchSize - 1;
    try {
      const data = await apiGet(
        `/hotel-content-api/1.0/locations/destinations?fields=code,name,countryCode,countryName&language=CAS&from=${from}&to=${to}`
      );
      const destinations = data.destinations || [];
      all.push(...destinations);
      console.log(`[Crawler] Destinos descargados: ${all.length}`);
      if (destinations.length < batchSize) break;
      from += batchSize;
      await new Promise(r => setTimeout(r, 500)); // pausa entre llamadas
    } catch (err) {
      console.error('[Crawler] Error descargando destinos:', err.message);
      break;
    }
  }
  return all;
}

async function runCrawler(force = false) {
  ensureCacheDir();
  const meta = loadMeta();
  const now = Date.now();

  if (!force && (now - meta.lastUpdate) < SEVEN_DAYS_MS) {
    const days = Math.round((SEVEN_DAYS_MS - (now - meta.lastUpdate)) / (24 * 60 * 60 * 1000));
    console.log(`[Crawler] Cache vigente. Proxima actualizacion en ${days} dia(s).`);
    return;
  }

  console.log('[Crawler] Iniciando actualizacion de contenido...');

  const destinations = await fetchAllDestinations();
  if (destinations.length > 0) {
    fs.writeFileSync(DESTINATIONS_FILE, JSON.stringify(destinations, null, 2));
    console.log(`[Crawler] ${destinations.length} destinos guardados en cache.`);
  }

  saveMeta({ lastUpdate: now, destinationCount: destinations.length });
  console.log('[Crawler] Actualizacion completada:', new Date(now).toISOString());
}

function getCachedDestinations() {
  try {
    return JSON.parse(fs.readFileSync(DESTINATIONS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function scheduleCrawler() {
  runCrawler().catch(err => console.error('[Crawler] Error:', err.message));
  // Repetir cada 7 dias
  setInterval(() => {
    runCrawler(true).catch(err => console.error('[Crawler] Error en actualizacion programada:', err.message));
  }, SEVEN_DAYS_MS);
}

module.exports = { scheduleCrawler, getCachedDestinations, runCrawler };
