import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.TFNSW_API_KEY = 'server-test-secret';
const { handler } = await import('../server.js');

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost:4173', 'x-tfnsw-key':'tab-secret', ...headers } });
  const res = {
    headers: {}, status: 200, text: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.text = String(value); }
  };
  await handler(req, res);
  return res;
}

test('configuration requires tab credentials even if a server environment key exists and denies cross-site access', async () => {
  const result = await request('/api/config');
  assert.equal((await request('/api/stops?q=Central',{headers:{'x-tfnsw-key':''}})).status,400);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { serverKeyConfigured: false, keyMode:'browser-tab', timetableStorage:'temporary' });
  assert.ok(!result.text.includes(process.env.TFNSW_API_KEY));
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal((await request('/api/config', {headers:{origin:'https://example.org'}})).status, 403);
  assert.equal((await request('/api/stops?q=Central', {headers:{'sec-fetch-site':'cross-site'}})).status, 403);
  assert.equal((await request('/.env')).status, 404);
});

test('stop search uses only the request key and reports upstream denial', async t => {
  const keys = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.hostname, 'api.transport.nsw.gov.au');
    keys.push(options.headers.Authorization);
    return Response.json({locations:[{id:'10101100',type:'stop',name:'Central Station'}]});
  });
  const result = await request('/api/stops?q=Central');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).stops[0].name, 'Central Station');
  await request('/api/stops?q=Central', {headers:{'x-tfnsw-key':'apikey tab-secret'}});
  assert.deepEqual(keys, ['apikey tab-secret','apikey tab-secret']);
  globalThis.fetch.mock.mockImplementation(async () => new Response('', {status:401}));
  const failure = await request('/api/stops?q=Central');
  assert.equal(failure.status, 502);
  assert.match(JSON.parse(failure.text).error, /key rejected/);
  assert.ok(!failure.text.includes('server-test-secret'));
});


test('connection check route validates feeds and returns safe diagnostic results', async t => {
  const rejected=await request('/api/connection/check',{method:'POST',body:{feeds:['https://example.org']}});
  assert.equal(rejected.status,400);
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({locations:[{id:'10101100',type:'stop',name:'Central Station'}]});});
  const result=await request('/api/connection/check',{method:'POST',body:{feeds:[]}});
  assert.equal(result.status,200);
  assert.equal(JSON.parse(result.text).results[0].ok,true);
  assert.equal(calls,1);
  assert.ok(!result.text.includes(process.env.TFNSW_API_KEY));
});
