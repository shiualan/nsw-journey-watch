import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConnection } from './src/connection.js';
import { findStops } from './src/tfnsw.js';
import { planRoute, validateRoute } from './src/planner.js';
import { pollFixedTracks, validateTrack } from './src/tracking.js';
import { staticStatus, syncStaticFeeds } from './src/gtfs-static.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function apiKey(req) {
  const raw = String(req.headers['x-tfnsw-key'] || '').trim().replace(/^apikey\s+/i, '');
  if (!raw || raw.length > 256 || /[\r\n]/.test(raw)) throw new Error('Enter a valid TfNSW API key under API settings.');
  return raw;
}

const MAX_BODY_BYTES=3_500_000; // Below Vercel’s 4.5 MB request limit, including saved paths.
async function getBody(req) {
  // Vercel may parse JSON before invoking a Node handler.
  if (req.body !== undefined) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request too large.');
    try { return JSON.parse(body); } catch { throw new Error('Invalid JSON request.'); }
  }
  let body = '';
  let bytes=0;
  for await (const chunk of req) {
    bytes+=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(chunk);
    body += chunk.toString('utf8');
    if (bytes > MAX_BODY_BYTES) throw new Error('Request too large.');
  }
  try { return JSON.parse(body); } catch { throw new Error('Invalid JSON request.'); }
}

function validateTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 12) throw new Error('Track 1–12 routes per request.');
  const validated=tracks.map(validateTrack);
  if (validated.reduce((sum,t)=>sum+t.legs.length,0)>40) throw new Error('Too many tracked public transport services.');
  if (new Set(validated.map(t=>t.id)).size!==validated.length) throw new Error('Duplicate tracked route ID.');
  return validated;
}

export async function handler(req, res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && ASSETS.has(url.pathname)) {
    const [name, contentType] = ASSETS.get(url.pathname);
    const file = await readFile(join(DIR, 'public', name));
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    return res.end(file);
  }
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, name: 'Journey Watch' });
  if (url.pathname.startsWith('/api/')) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site API access denied.' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin API access denied.' });
    if (url.pathname === '/api/static/status' && req.method === 'GET') {
      try { return json(res, 200, await staticStatus()); }
      catch { return json(res, 500, { error:'Cannot read timetable cache status.' }); }
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { serverKeyConfigured: false, keyMode:'browser-tab', timetableStorage:'temporary' });
    let key;
    try { key = apiKey(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (url.pathname === '/api/connection/check' && req.method === 'POST') {
      try {
        const body = await getBody(req);
        return json(res, 200, await checkConnection(body.feeds, key));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/static/sync' && req.method === 'POST') {
      try {
        const body = await getBody(req);
        if (!Array.isArray(body.feeds) || body.feeds.length !== 1) throw new Error('Sync one timetable feed per request.');
        const tracks = body.tracks === undefined ? [] : validateTracks(body.tracks);
        const synced = await syncStaticFeeds(body.feeds, key, {waitForCompletion:true});
        const status = await staticStatus();
        const failure = status.feeds[body.feeds[0]]?.job;
        if (failure?.status === 'error') return json(res, 502, {error:failure.error});
        const linked = tracks.length ? await pollFixedTracks(tracks,key) : {};
        return json(res, 200, {...synced,...linked,status});
      } catch (e) { return json(res, /already in progress/.test(e.message) ? 409 : 400, { error:e.message }); }
    }
    if (url.pathname === '/api/stops' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2 || q.length > 100) return json(res, 400, { error: 'Enter at least 2 characters.' });
      try { return json(res, 200, { stops: await findStops(q, key) }); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/api/track' && req.method === 'POST') {
      let tracks;
      try {
        const body = await getBody(req);
        tracks = validateTracks(body.tracks);
      } catch (e) { return json(res, 400, { error: e.message }); }
      try { return json(res, 200, await pollFixedTracks(tracks, key)); }
      catch (e) { return json(res, 502, { error: 'GTFS-Realtime processing failed; try refreshing.' }); }
    }
    if (url.pathname === '/api/compare' && req.method === 'POST') {
      let routes;
      try {
        const body = await getBody(req);
        if (!Array.isArray(body.routes) || body.routes.length < 1 || body.routes.length > 12) throw new Error('Choose 1-12 routes.');
        routes = body.routes.map(validateRoute);
      } catch (e) { return json(res, 400, { error: e.message }); }
      const now = new Date();
      const results = [];
      for (const route of routes) {
        try { results.push({ ok: true, data: await planRoute(route, key, { now }) }); }
        catch (e) { results.push({ ok: false, id: route.id, label: route.label, error: e.message }); }
      }
      return json(res, 200, { updatedAt: now.toISOString(), results });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch(error => {
    // Do not log URLs, request headers or API keys.
    console.error('Request error:', error.message);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error.' });
    else res.end();
  });
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => console.log(`Journey Watch running at http://${HOST}:${PORT}`));
}
