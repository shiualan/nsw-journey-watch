import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root=await mkdtemp(join(tmpdir(),'journey-vercel-'));
process.env.GTFS_DATA_DIR=join(root,'warm');
process.env.TFNSW_API_KEY='must-not-be-used';
const {default:handler}=await import('../api/handler.js');
after(()=>rm(root,{recursive:true,force:true}));
async function request(route,{body,method=body?'POST':'GET',key='tab-key'}={}) {
  const req={url:`/api/handler?__route=${encodeURIComponent(route)}`,body,method,
    headers:{host:'journey.example','x-tfnsw-key':key,origin:'https://journey.example'}};
  const res={status:200,headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code,headers){this.status=code;Object.assign(this.headers,headers);},end(data){this.data=JSON.parse(data);}};
  await handler(req,res);return res;
}

test('Vercel rewrite adapter accepts HTTPS and parsed bodies, with no server key fallback',async t=>{
  const config=await request('config');
  assert.equal(config.status,200);assert.equal(config.data.serverKeyConfigured,false);
  const noKey=await request('stops',{key:''});assert.equal(noKey.status,400);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers.Authorization,'apikey tab-key');
    assert.equal(new URL(url).searchParams.get('name_sf'),'Central');
    return Response.json({locations:[{type:'stop',id:'central',name:'Central Station'}]});
  });
  const req={url:'/api/handler?__route=stops&q=Central',method:'GET',headers:{host:'journey.example',origin:'https://journey.example','x-tfnsw-key':'tab-key'}};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code){this.status=code;},end(data){this.data=JSON.parse(data);}};
  await handler(req,res);assert.equal(res.status,200);assert.equal(res.data.stops[0].id,'central');
  const invalid=await request('compare',{body:{routes:[]}});assert.equal(invalid.status,400);
});

test('completed timetable request returns a portable binding that survives a cold function',async t=>{
  const zip=await readFile(new URL('./fixtures/mini-bus.zip',import.meta.url));
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers.Authorization,'apikey tab-key');
    return String(url).includes('/schedule/')?new Response(zip):new Response(new Uint8Array());
  });
  const leg={id:'0-0',stageIndex:0,mode:'bus',line:'700',from:'Blacktown Station',to:'Parramatta Station',
    departure:'2026-10-20T21:00:00.000Z',arrival:'2026-10-20T21:25:00.000Z',
    plannedDeparture:'2026-10-20T21:00:00.000Z',plannedArrival:'2026-10-20T21:25:00.000Z',tripIdCandidates:[]};
  const track={id:'portable',label:'Portable bus',lockedAt:new Date().toISOString(),
    baseline:{departure:leg.departure,arrival:leg.arrival,stages:[]},legs:[leg]};
  const result=await request('static/sync',{body:{feeds:['buses'],tracks:[track]}});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.status.running,false);
  assert.equal(result.data.status.feeds.buses.job.status,'ready');
  const linked=result.data.results[0].data.fixed.legs[0];
  assert.equal(linked.match,'timetable-linked');
  assert.equal(linked.staticPath.stops.length,3);
  Object.assign(leg,{tripId:linked.tripId,feedId:linked.feedId,startDate:linked.startDate,staticPath:linked.staticPath});
  const cold=join(root,'cold');
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {readFileSync} from 'node:fs';
    import {pollFixedTracks} from './src/tracking.js';
    const track=JSON.parse(readFileSync(0,'utf8'));
    const result=await pollFixedTracks([track],'tab-key',{getFeed:async()=>({entities:[]})});
    console.log(JSON.stringify(result));
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,GTFS_DATA_DIR:cold},input:JSON.stringify(track),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const restored=JSON.parse(child.stdout).results[0].data.fixed.legs[0];
  assert.equal(restored.staticStatus,'saved');
  assert.deepEqual(restored.staticPath.stops,linked.staticPath.stops);
  assert.equal(restored.gps,null);
  assert.ok(!JSON.stringify(result.data).includes('tab-key'));
  await assert.rejects(readdir(cold),{code:'ENOENT'});
  leg.staticPath={...leg.staticPath,tripId:'wrong-service'};
  const rejected=await request('track',{body:{tracks:[track]}});assert.equal(rejected.status,400);
});

test('hosted sync limits work per request and does not start detached multi-feed jobs',async()=>{
  const result=await request('static/sync',{body:{feeds:['buses','sydneytrains']}});
  assert.equal(result.status,400);assert.match(result.data.error,/one timetable/);
});
