import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../src/connection.js';
import { scheduleUrl } from '../src/gtfs-static.js';
import { feedUrl } from '../src/tracking.js';

const stops = {locations:[{type:'stop',id:'10101100',name:'Central Station'}]};

test('API access check uses operator-specific versions and HEAD without downloading feeds', async () => {
  const calls = [];
  const result = await checkConnection(['innerwest','innerwest'], 'test-only-key', async (url, options) => {
    calls.push({url:String(url), method:options.method || 'GET'});
    assert.equal(options.headers.Authorization, 'apikey test-only-key');
    return options.method === 'HEAD' ? new Response(null, {status:200}) : Response.json(stops);
  });
  assert.equal(result.results.length, 4);
  assert.ok(result.results.every(r => r.ok));
  assert.deepEqual(calls.slice(1), [
    {url:scheduleUrl('innerwest'), method:'HEAD'},
    {url:feedUrl('innerwest','trip'), method:'HEAD'},
    {url:feedUrl('innerwest','vehicle'), method:'HEAD'}
  ]);
  assert.match(calls[1].url, /v1\/gtfs\/schedule\/lightrail\/innerwest$/);
  assert.match(calls[2].url, /v2\/gtfs\/realtime\/lightrail\/innerwest$/);
  assert.match(calls[3].url, /v2\/gtfs\/vehiclepos\/lightrail\/innerwest$/);
  assert.ok(!JSON.stringify(result).includes('test-only-key'));
});

test('API access check reports partial access and unsupported HEAD honestly', async () => {
  const status = [401,403,405];
  const result = await checkConnection(['metro'], 'test-only-key', async (url, options) => {
    if (options.method !== 'HEAD') return Response.json(stops);
    return new Response(null,{status:status.shift()});
  });
  assert.equal(result.results[0].ok,true);
  assert.deepEqual(result.results.slice(1).map(r=>r.status),[401,403,405]);
  assert.ok(result.results.slice(1).every(r=>!r.ok));
  assert.match(result.results[1].message,/not subscribed/);
  assert.match(result.results[2].message,/quota/);
  assert.match(result.results[3].message,/does not support/);
});

test('API access check rejects arbitrary URLs before making any upstream call', async () => {
  let calls=0;
  await assert.rejects(checkConnection(['https://example.org'], 'key', async()=>{ calls++; }), /valid timetable feeds/);
  await assert.rejects(checkConnection('metro', 'key'), /valid timetable feeds/);
  assert.equal(calls,0);
});

test('all supported static schedules match the supplied v1/v2 timetable specifications', () => {
  for (const id of ['buses','sydneytrains','nswtrains','ferries','innerwest','cbd','parramatta','newcastle']) {
    assert.match(scheduleUrl(id), /\/v1\/gtfs\/schedule\//);
  }
  assert.match(scheduleUrl('metro'), /\/v2\/gtfs\/schedule\/metro$/);
});


test('realtime HEAD gateway failures fall back to GET headers and cancel the stream', async () => {
  let cancelled=0;
  const calls=[];
  const result=await checkConnection(['sydneytrains'],'key',async(url,options)=>{
    calls.push({url:String(url),method:options.method || 'GET'});
    if (String(url).includes('/tp/')) return Response.json(stops);
    if (String(url).includes('/schedule/')) return new Response(null,{status:200});
    if (options.method==='HEAD') return new Response(null,{status:502});
    return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:200});
  });
  assert.ok(result.results.every(item=>item.ok));
  assert.equal(cancelled,2);
  assert.deepEqual(result.results.slice(2).map(item=>item.method),['GET','GET']);
  assert.equal(calls.filter(item=>item.method==='GET'&&!item.url.includes('/tp/')).length,2);
});
