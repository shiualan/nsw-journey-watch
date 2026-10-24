/**
 * Dependency-free GTFS Schedule importer and matcher.
 * Download only TfNSW's allowlisted operator-specific schedule ZIPs. CSV data
 * are parsed from ZIP streams and persisted under a private local data dir.
 * A unique two-stop, time-and-route-consistent timetable match is required
 * before a service can be auto-bound to the GTFS-Realtime trip ID.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw, createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { nswDateTime, throttledRequest } from './tfnsw.js';
import { FEEDS, feedsForLeg } from './tracking.js';

const ROOT = resolve(process.env.GTFS_DATA_DIR || join(tmpdir(),'journey-watch-gtfs'));
const STATIC_PATHS = Object.freeze({
  buses: 'v1/gtfs/schedule/buses',
  sydneytrains: 'v1/gtfs/schedule/sydneytrains', // IMPORTANT: v1 static pairs with v2 real-time
  nswtrains: 'v1/gtfs/schedule/nswtrains',
  metro: 'v2/gtfs/schedule/metro',
  ferries: 'v1/gtfs/schedule/ferries/sydneyferries',
  innerwest: 'v1/gtfs/schedule/lightrail/innerwest',
  cbd: 'v1/gtfs/schedule/lightrail/cbdandsoutheast',
  parramatta: 'v1/gtfs/schedule/lightrail/parramatta',
  newcastle: 'v1/gtfs/schedule/lightrail/newcastle'
});
const FILE_NAMES = ['routes.txt','stops.txt','calendar.txt','calendar_dates.txt','trips.txt','stop_times.txt'];
const MAX_ZIP = 220 * 1024 * 1024;
const MAX_EXTRACTED = 1_100 * 1024 * 1024;
const FRESH_MS = 36 * 3600_000;
const inMemory = new Map(); // LRU; max 3 operator indexes at a time
const syncJobs = new Map();
let syncRunning = false;
export const SCHEDULE_FEEDS = Object.keys(STATIC_PATHS);

export function scheduleUrl(feedId) {
  if (!STATIC_PATHS[feedId]) throw new Error('Unsupported timetable feed.');
  return `https://api.transport.nsw.gov.au/${STATIC_PATHS[feedId]}`;
}
function validFeed(feed) { return typeof feed === 'string' && Object.hasOwn(STATIC_PATHS, feed); }
function filePaths(feedId) { return { archive:join(ROOT,`${feedId}.zip.tmp`), index:join(ROOT,`${feedId}.json.gz`), meta:join(ROOT,`${feedId}.meta.json`) }; }

async function downloadSchedule(feedId, key, dest, fetchImpl = fetch) {
  return throttledRequest(async () => {
    let res;
    try { res = await fetchImpl(scheduleUrl(feedId), {
      headers: { Authorization:`apikey ${key}`, Accept:'application/zip, application/octet-stream' },
      signal:AbortSignal.timeout(150_000)
    }); } catch (e) { throw new Error(`Schedule download failed (${e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`); }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(`Schedule access denied (HTTP ${res.status}); check the timetable API subscription.`);
      throw new Error(`TfNSW schedule returned HTTP ${res.status}.`);
    }
    if (Number(res.headers.get('content-length')) > MAX_ZIP) throw new Error('Schedule ZIP exceeds 220 MB limit.');
    if (!res.body) throw new Error('Empty schedule response.');
    const out = createWriteStream(dest, { flags:'w', mode:0o600 });
    let bytes = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        bytes += chunk.length;
        if (bytes > MAX_ZIP) throw new Error('Schedule ZIP exceeds 220 MB limit.');
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end(); await once(out, 'finish');
    } catch (e) { out.destroy(); await rm(dest,{force:true}).catch(()=>{}); throw e; }
    return bytes;
  });
}

// Locate desired members of a ZIP through its central directory. ZIP64 and
// encrypted entries are intentionally refused, and arbitrary paths ignored.
export async function zipDirectory(path) {
  const handle = await open(path,'r');
  try {
    const length = (await handle.stat()).size;
    if (length < 22) throw new Error('Schedule is not a ZIP archive.');
    const tailLen = Math.min(length, 65557);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail,0,tailLen,length-tailLen);
    let eocd = -1;
    for(let i=tailLen-22;i>=0;i--){ if(tail.readUInt32LE(i)===0x06054b50 && i+22+tail.readUInt16LE(i+20)===tailLen){eocd=i;break;} }
    if(eocd<0) throw new Error('Schedule ZIP directory missing.');
    const count = tail.readUInt16LE(eocd+10), size=tail.readUInt32LE(eocd+12), start=tail.readUInt32LE(eocd+16);
    if(count===0xffff||size===0xffffffff||start===0xffffffff||start+size>length||size>10_000_000) throw new Error('Unsupported or excessive ZIP directory.');
    const central=Buffer.alloc(size); await handle.read(central,0,size,start);
    const found=new Map(); let offset=0;
    for(let i=0;i<count;i++){
      if(offset+46>size||central.readUInt32LE(offset)!==0x02014b50) throw new Error('Malformed ZIP directory.');
      const flags=central.readUInt16LE(offset+8),method=central.readUInt16LE(offset+10);
      const compressed=central.readUInt32LE(offset+20), uncompressed=central.readUInt32LE(offset+24);
      const n=central.readUInt16LE(offset+28),extra=central.readUInt16LE(offset+30),comment=central.readUInt16LE(offset+32);
      const local=central.readUInt32LE(offset+42);
      const fullName=central.subarray(offset+46,offset+46+n).toString('utf8');
      offset+=46+n+extra+comment;
      const name=fullName.split('/').at(-1);
      if(FILE_NAMES.includes(name)) {
        if(found.has(name)||flags&1||![0,8].includes(method)||uncompressed>MAX_EXTRACTED||compressed>MAX_ZIP||local>=length) throw new Error(`Unsafe or duplicate GTFS member: ${name}`);
        const header=Buffer.alloc(30); await handle.read(header,0,30,local);
        if(header.readUInt32LE(0)!==0x04034b50) throw new Error('Malformed ZIP local header.');
        const dataOffset=local+30+header.readUInt16LE(26)+header.readUInt16LE(28);
        if(dataOffset+compressed>length) throw new Error('Malformed ZIP member range.');
        found.set(name,{dataOffset,compressed,uncompressed,method});
      }
    }
    for(const required of ['routes.txt','stops.txt','trips.txt','stop_times.txt']) if(!found.has(required)) throw new Error(`GTFS archive missing ${required}.`);
    return found;
  } finally { await handle.close(); }
}

function zipMemberStream(path, entry) {
  const stream = createReadStream(path,{start:entry.dataOffset,end:entry.dataOffset+entry.compressed-1});
  const decompressed=entry.method===8 ? stream.pipe(createInflateRaw()) : stream;
  let total=0;
  const limit=new Transform({ transform(chunk,_enc,cb) {
    total+=chunk.length;
    if(total>MAX_EXTRACTED||total>entry.uncompressed+1024) return cb(new Error('GTFS entry exceeds declared uncompressed size.'));
    cb(null,chunk);
  }});
  // Upstream source/decompression failures must reach the CSV consumer.
  stream.on('error',error=>limit.destroy(error));
  if(decompressed!==stream)decompressed.on('error',error=>limit.destroy(error));
  return decompressed.pipe(limit);
}

/** CSV parser supports BOM, escaped quotes, CRLF and quoted newlines. */
export async function* csvRows(stream) {
  const decoder = new TextDecoder();
  let field='', row=[], quoted=false, atStart=true, afterQuote=false, fieldLength=0;
  for await (const bytes of stream) {
    const text=decoder.decode(typeof bytes==='string'?Buffer.from(bytes):bytes,{stream:true});
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(atStart){atStart=false;if(ch==='\ufeff') continue;}
      if(quoted){
        if(ch==='"'){quoted=false;afterQuote=true;}
        else field+=ch;
      } else if (afterQuote && ch==='"'){field+='"';quoted=true;afterQuote=false;}
      else if (ch==='"' && field==='' && !afterQuote) quoted=true;
      else if(ch===','){row.push(field);field='';afterQuote=false;fieldLength=0;}
      else if(ch==='\n'){
        row.push(field.endsWith('\r') ? field.slice(0,-1) : field);
        field='';fieldLength=0;afterQuote=false;
        if(row.some(cell=>cell.length)) yield row;
        row=[];
      } else if(ch==='\r') {if(!afterQuote) field+=ch;}
      else if(afterQuote && ch===' '){/* tolerate whitespace after closing quote */}
      else {field+=ch;afterQuote=false;}
      if(++fieldLength>120_000) throw new Error('GTFS CSV field too large.');
    }
  }
  if(quoted) throw new Error('Unclosed GTFS CSV quoted field.');
  if(field.length||row.length){row.push(field);yield row;}
}

export function parseSeconds(input) {
  const match=String(input||'').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if(!match) return null;
  const [h,m,s]=match.slice(1).map(Number);
  return h<48&&m<60&&s<60 ? h*3600+m*60+s : null;
}
function isSafeId(id) {return typeof id==='string'&&id.length>0&&id.length<220&&!/[\x00-\x1f\x7f]/.test(id);}

export async function buildIndexFromZip(zipPath,feedId,importedAt = new Date().toISOString()) {
  if(!validFeed(feedId)) throw new Error('Invalid GTFS operator.');
  const entries=await zipDirectory(zipPath);
  const index={ meta:{version:1,feedId,importedAt,stops:0,routes:0,trips:0,stopTimes:0,calendarServices:0},stops:Object.create(null),routes:Object.create(null),calendar:Object.create(null),exceptions:Object.create(null),trips:Object.create(null)};
  async function readTable(name, processRow) {
    const entry=entries.get(name); if(!entry) return;
    const rows=csvRows(zipMemberStream(zipPath,entry));
    let keys=null;
    for await (const row of rows) {
      if(!keys){keys=row.map(k=>k.trim().replace(/^\ufeff/,''));continue;}
      const obj=Object.create(null); keys.forEach((k,i)=>{obj[k]=row[i]??'';});
      processRow(obj);
    }
  }
  await readTable('routes.txt', r=>{if(!isSafeId(r.route_id))return;index.routes[r.route_id]=[r.route_short_name||'',r.route_long_name||'',Number(r.route_type)||0];index.meta.routes++;});
  await readTable('stops.txt',r=>{if(!isSafeId(r.stop_id))return;index.stops[r.stop_id]=[r.stop_name||r.stop_id,r.parent_station||'',r.stop_lat||'',r.stop_lon||''];index.meta.stops++;});
  await readTable('calendar.txt',r=>{
    if(!isSafeId(r.service_id)||!/^[0-9]{8}$/.test(r.start_date)||!/^[0-9]{8}$/.test(r.end_date))return;
    const mask=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].reduce((bits,k,i)=>bits|(r[k]==='1'?(1<<i):0),0);
    index.calendar[r.service_id]=[r.start_date,r.end_date,mask];index.meta.calendarServices++;
  });
  await readTable('calendar_dates.txt',r=>{
    if(isSafeId(r.service_id)&&/^\d{8}$/.test(r.date)&&['1','2'].includes(r.exception_type)) (index.exceptions[r.service_id] ||= Object.create(null))[r.date]=Number(r.exception_type);
  });
  await readTable('trips.txt',r=>{
    if(!isSafeId(r.trip_id)||!isSafeId(r.route_id)||!isSafeId(r.service_id))return;
    index.trips[r.trip_id]=[r.route_id,r.service_id,r.trip_headsign||'',r.direction_id||'',[]];index.meta.trips++;
  });
  await readTable('stop_times.txt',r=>{
    const trip=index.trips[r.trip_id];if(!trip||!isSafeId(r.stop_id))return;
    const arrival=parseSeconds(r.arrival_time),departure=parseSeconds(r.departure_time);
    if(arrival===null&&departure===null)return;
    const seq=Number(r.stop_sequence);
    if(!Number.isInteger(seq)||seq<0||seq>9999)return;
    trip[4].push([r.stop_id,arrival??departure,departure??arrival,seq]);index.meta.stopTimes++;
  });
  for(const [tripId,trip] of Object.entries(index.trips)) {
    if(trip[4].length<2){delete index.trips[tripId];index.meta.trips--;continue;}
    trip[4].sort((a,b)=>a[3]-b[3]);
  }
  if(index.meta.trips===0||index.meta.stops===0||index.meta.stopTimes===0) throw new Error('GTFS ZIP contains no usable timetable records.');
  return index;
}

function touch(feedId,value) {
  inMemory.delete(feedId); inMemory.set(feedId,value);
  while(inMemory.size>3) inMemory.delete(inMemory.keys().next().value);
}
async function persistIndex(feedId,index) {
  await mkdir(ROOT,{recursive:true,mode:0o700});
  const paths=filePaths(feedId);
  const tmp=`${paths.index}.${process.pid}.tmp`;
  try {
    await pipeline(Readable.from([Buffer.from(JSON.stringify(index))]),createGzip({level:5}),createWriteStream(tmp,{mode:0o600}));
    await rename(tmp,paths.index);
    await writeFile(paths.meta,JSON.stringify(index.meta),{mode:0o600});
    touch(feedId, index);
  } finally {await rm(tmp,{force:true}).catch(()=>{});}
}
export async function readIndex(feedId) {
  if(!validFeed(feedId)) return null;
  if(inMemory.has(feedId)) {const value=inMemory.get(feedId);touch(feedId,value);return value;}
  try {
    const data=await readFile(filePaths(feedId).index);
    const chunks=[];
    const gunzip=createGunzip();
    for await (const chunk of Readable.from([data]).pipe(gunzip)) chunks.push(chunk);
    const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(parsed.meta.version!==1||parsed.meta.feedId!==feedId) throw new Error('Unknown index version.');
    touch(feedId,parsed);return parsed;
  } catch(e) {if(e.code==='ENOENT')return null;throw e;}
}

export async function importGtfsZip(zipPath,feedId,at) {
  const index=await buildIndexFromZip(zipPath,feedId,at);
  await persistIndex(feedId,index);
  return index.meta;
}
export async function staticStatus() {
  const jobs={};
  await Promise.all(SCHEDULE_FEEDS.map(async id=>{
    let meta=null;
    try {meta=JSON.parse(await readFile(filePaths(id).meta,'utf8'));}
    catch(e){if(e.code!=='ENOENT')meta={error:'Cannot read cached GTFS metadata.'};}
    jobs[id]={ label: FEEDS[id].label, cachedAt:meta?.importedAt||null, meta:meta?.version===1?meta:null,
      stale:!meta?.importedAt||Date.now()-Date.parse(meta.importedAt)>FRESH_MS,
      job:syncJobs.get(id)||null };
  }));
  return {feeds:jobs, running:syncRunning, storage:'temporary', syncMode:'request'};
}
export async function syncStaticFeeds(feedIds,key,options={}) {
  if(!Array.isArray(feedIds)||feedIds.length===0||feedIds.length>9||feedIds.some(id=>!validFeed(id))||new Set(feedIds).size!==feedIds.length) throw new Error('Choose 1–9 supported timetable feeds.');
  if(syncRunning) throw new Error('A timetable synchronisation is already in progress.');
  syncRunning=true;
  for(const id of feedIds) syncJobs.set(id,{status:'queued',startedAt:new Date().toISOString()});
  const doSync=async()=>{
    try {
      await mkdir(ROOT,{recursive:true,mode:0o700});
      for(const feedId of feedIds) {
        const startedAt=new Date().toISOString();
        syncJobs.set(feedId,{status:'downloading',startedAt});
        const paths=filePaths(feedId);
        try {
          await downloadSchedule(feedId,key,paths.archive,options.fetchImpl);
          syncJobs.set(feedId,{status:'indexing',startedAt});
          const meta=await importGtfsZip(paths.archive,feedId);
          syncJobs.set(feedId,{status:'ready',finishedAt:new Date().toISOString(),trips:meta.trips,stops:meta.stops});
        } catch(e) {syncJobs.set(feedId,{status:'error',finishedAt:new Date().toISOString(),error:String(e.message).slice(0,160)});}
        finally {await rm(paths.archive,{force:true}).catch(()=>{});}
      }
    } finally { syncRunning=false; }
  };
  // Hosted requests wait for ingestion; no work is abandoned after responding.
  if (options.waitForCompletion) await doSync();
  else void doSync().catch(()=>{syncRunning=false;});
  return { started:feedIds };
}

export function serviceDates(date) {
  const local=nswDateTime(new Date(date)).itdDate;
  const y=Number(local.slice(0,4)),m=Number(local.slice(4,6)),d=Number(local.slice(6,8));
  const previous=new Date(Date.UTC(y,m-1,d-1));
  const prev=`${previous.getUTCFullYear()}${String(previous.getUTCMonth()+1).padStart(2,'0')}${String(previous.getUTCDate()).padStart(2,'0')}`;
  return [local,prev];
}
const serviceDayEpochs=new Map();
const offsetFormatter=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function localOffsetAt(epoch) {
  const p=Object.fromEntries(offsetFormatter.formatToParts(new Date(epoch)).map(v=>[v.type,v.value]));
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-Math.floor(epoch/60000)*60000;
}
function serviceEpoch(date,seconds) {
  let midnight=serviceDayEpochs.get(date);
  if(midnight===undefined){
    const y=+date.slice(0,4),m=+date.slice(4,6),d=+date.slice(6,8);
    const utc=Date.UTC(y,m-1,d,0,0,0);
    // Australian midnight is on the prior UTC day; use its local offset.
    midnight=utc-localOffsetAt(utc-10*3600_000);
    serviceDayEpochs.set(date,midnight);
    if(serviceDayEpochs.size>32)serviceDayEpochs.delete(serviceDayEpochs.keys().next().value);
  }
  return midnight+seconds*1000;
}
export function serviceTime(date,seconds) { return new Date(serviceEpoch(date,seconds)).toISOString(); }

export function serviceIsActive(index,serviceId,date) {
  const exception=index.exceptions?.[serviceId]?.[date];
  if(exception===1)return true;
  if(exception===2)return false;
  const rule=index.calendar?.[serviceId];if(!rule||date<rule[0]||date>rule[1])return false;
  const day=new Date(Date.UTC(+date.slice(0,4),+date.slice(4,6)-1,+date.slice(6,8))).getUTCDay();
  return Boolean(rule[2]&(1<<((day+6)%7)));
}
export function stationKey(name) {
  return String(name||'').normalize('NFKD').toLowerCase()
    .replace(/\b(?:railway\s+station|train\s+station|station|platform\s+[a-z0-9/]+|stand\s+[a-z0-9/]+|wharf\s+\d+|interchange)\b/gi,' ')
    .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function stopScore(efaId, efaName, gtfsId, index) {
  const stop=index.stops[gtfsId];if(!stop)return 0;
  if(efaId&&String(efaId)===gtfsId)return 5;
  if(efaId&&String(efaId)===stop[1])return 4;
  const wanted=stationKey(efaName),got=stationKey(stop[0]);
  if(wanted.length<4||got.length<4)return 0;
  if(wanted===got)return 3;
  // Platform/stand name prefixes are sometimes omitted by Trip Planner;
  // only accept a substantial whole-word prefix for a timetable candidate.
  if(wanted.length>=7&&got.startsWith(`${wanted} `))return 2;
  return 0;
}
function lineCode(text){return String(text||'').toUpperCase().match(/\b(?:T\d{1,2}|M\d{1,2}|L\d|F\d|\d{1,4}[A-Z]?)\b/)?.[0]||'';}
function modeType(mode,gtfsType) {
  if(mode==='bus')return [3,700,701,702,703,704,705,706,707,708,709,710,711,712,713,714,715,716].includes(gtfsType);
  if(mode==='train')return [2,100,101,102,103,104,105,106,109].includes(gtfsType);
  if(mode==='metro')return [1,2,400,401,402].includes(gtfsType);
  if(mode==='ferry')return [4,1000,1200].includes(gtfsType);
  if(mode==='light_rail')return [0,900,901,902,903,904,905,906].includes(gtfsType);
  return false;
}
function makeRouteIndex(index) {
  const codes=new Map(), byMode=new Map();
  for(const [tripId,trip] of Object.entries(index.trips)) {
    const route=index.routes[trip[0]];if(!route)continue;
    const code=lineCode(route[0]);
    if(code){const list=codes.get(code)||[];list.push([tripId,trip]);codes.set(code,list);}
    const type=route[2];const list=byMode.get(type)||[];list.push([tripId,trip]);byMode.set(type,list);
  }
  return {codes,byMode};
}
function routeIndex(feedId,index) {
  if(index._routeIndex)return index._routeIndex;
  Object.defineProperty(index,'_routeIndex',{value:makeRouteIndex(index),configurable:true});
  return index._routeIndex;
}
function matchedPath(index,trip,originIndex,destinationIndex,serviceDate,feedId,tripId) {
  const points=trip[4].slice(originIndex,destinationIndex+1).slice(0,150).map(s=>({
    stopId:s[0],name:index.stops[s[0]]?.[0]||`Stop ${s[0]}`,sequence:s[3],
    scheduledArrival:serviceTime(serviceDate,s[1]),scheduledDeparture:serviceTime(serviceDate,s[2]),
    lat:index.stops[s[0]]?.[2]?Number(index.stops[s[0]][2]):null,
    lon:index.stops[s[0]]?.[3]?Number(index.stops[s[0]][3]):null
  }));
  return {version:1,importedAt:index.meta.importedAt,feedId,tripId,serviceDate,route:index.routes[trip[0]]?.[0]||'',fromStopId:trip[4][originIndex][0],toStopId:trip[4][destinationIndex][0],stops:points};
}
function evaluateTrip(index,leg,feedId,tripId,trip,dates=serviceDates(leg.departure)) {
  const wantDep=Date.parse(leg.plannedDeparture||leg.departure), wantArr=Date.parse(leg.plannedArrival||leg.arrival);
  const stops=trip[4];let result=null;
  for(const date of dates) {
    if(!serviceIsActive(index,trip[1],date))continue;
    for(let i=0;i<stops.length-1;i++) {
      const start=stops[i], fromMatch=stopScore(leg.fromStopId||leg.stops?.[0]?.id,leg.from,start[0],index);
      if(fromMatch<2)continue;
      const depDiff=Math.abs(serviceEpoch(date,start[2])-wantDep)/1000;
      if(depDiff>240)continue;
      for(let j=i+1;j<stops.length;j++){
        const end=stops[j], toMatch=stopScore(leg.toStopId||leg.stops?.at(-1)?.id,leg.to,end[0],index);
        if(toMatch<2)continue;
        const arrDiff=Math.abs(serviceEpoch(date,end[1])-wantArr)/1000;
        if(arrDiff>300)continue;
        const short=index.routes[trip[0]]?.[0]||'';
        const label=lineCode(leg.line),routeConfirmed=label&&lineCode(short)===label;
        const score=120+fromMatch*12+toMatch*12+ (routeConfirmed?25:0) - depDiff/8-arrDiff/10;
        if(!result||score>result.score)result={feedId,tripId,serviceDate:date,score,depDiff,arrDiff,fromMatch,toMatch,
          path:matchedPath(index,trip,i,j,date,feedId,tripId)};
      }
    }
  }
  return result;
}

/** Return exact static timetable attachment or safely unconfirmed suggestions. */
export async function matchStaticLeg(leg, options={}) {
  const ids=feedsForLeg(leg),read=options.readIndex||readIndex, now=options.now||new Date();
  const candidates=[],missing=[],dates=serviceDates(leg.departure);
  for(const feedId of ids){
    const index=await read(feedId);
    if(!index||Date.parse(index.meta.importedAt)<now.getTime()-FRESH_MS) { missing.push(feedId);continue; }
    const {codes,byMode}=routeIndex(feedId,index);
    const line=lineCode(leg.line);
    // A line is considered known only when it occurs in this GTFS operator.
    const selected=line&&codes.has(line)?codes.get(line) :
      [...byMode.entries()].filter(([type])=>modeType(leg.mode,type)).flatMap(([,rows])=>rows);
    // Mode fallback for unknown route IDs is expensive for the large bus feed.
    if(!line&&selected.length>200_000)continue;
    for(const [tripId,trip] of selected){
      if(leg.tripId&&tripId!==leg.tripId)continue;
      const result=evaluateTrip(index,leg,feedId,tripId,trip,dates);
      if(result)candidates.push(result);
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0];
  const second=candidates[1];
  const unique=best&&!second || best&&second&&best.score-second.score>=16;
  const confidence=best&&best.fromMatch>=3&&best.toMatch>=3&&best.depDiff<=120&&best.arrDiff<=180;
  const result=unique&&confidence ? 'unique' : candidates.length?'ambiguous':'none';
  return {status:result,match:result==='unique'?best:null,
    suggestions:candidates.slice(0,4).map(c=>({feedId:c.feedId,tripId:c.tripId,serviceDate:c.serviceDate,
      route:c.path.route,departure:c.path.stops[0]?.scheduledDeparture,score:Math.round(c.score)})),missing};
}

export async function staticPathForLeg(leg,options={}) {
  const ids=leg.feedId?[leg.feedId]:feedsForLeg(leg),read=options.readIndex||readIndex;
  for(const id of ids){
    const index=await read(id);
    if(!index||!leg.tripId||!index.trips[leg.tripId]) continue;
    const match=evaluateTrip(index,leg,id,leg.tripId,index.trips[leg.tripId]);
    if(match)return match.path;
  }
  return null;
}

/** For exact realtime trip bindings, a stop name may be known even when an
 * EFA-to-GTFS timetable path cannot be reconstructed confidently. */
export async function staticStopName(feedId,stopId) {
  if(!validFeed(feedId) || !stopId) return null;
  const index=await readIndex(feedId);
  return index?.stops?.[String(stopId)]?.[0] || null;
}
