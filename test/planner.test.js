import test from 'node:test';
import assert from 'node:assert/strict';
import { nswDateTime, tripUrl, stopFinderUrl, normaliseStops, selectJourney, normaliseLeg } from '../src/tfnsw.js';
import { planRoute, validateRoute } from '../src/planner.js';

const dt = s => new Date(`2026-10-22T${s}:00+11:00`).toISOString();
const stop = (id,name) => ({id,name});
const blacktown = stop('10101252','Blacktown Station');
const parramatta = stop('10101132','Parramatta Station');
const central = stop('10101100','Central Station');
const mkLeg = (cls, from, to, dep, arr, shift = 0) => {
  const estimatedDep = shift ? dtShift(dep,shift) : null;
  const estimatedArr = shift ? dtShift(arr,shift) : null;
  return {
    origin: { ...from, departureTimePlanned:dt(dep), ...(estimatedDep ? {departureTimeEstimated:estimatedDep}: {}) },
    destination: { ...to, arrivalTimePlanned:dt(arr), ...(estimatedArr ? {arrivalTimeEstimated:estimatedArr}: {}) },
    transportation: { product:{class:cls,name: cls===1?'Train':cls===5?'Bus':'Walk'}, name:cls===5?'700':cls===1?'T1':'Walk' },
    stopSequence: [
      { ...from, departureTimePlanned:dt(dep), ...(estimatedDep?{departureTimeEstimated:estimatedDep}:{}) },
      { ...to, arrivalTimePlanned:dt(arr), ...(estimatedArr?{arrivalTimeEstimated:estimatedArr}:{}) }
    ]
  };
};
function dtShift(s, minutes) {return new Date(Date.parse(dt(s)) + 60000*minutes).toISOString();}

test('TfNSW Sydney time uses daylight saving correctly', () => {
  assert.deepEqual(nswDateTime(new Date('2026-10-22T08:30:00Z')), {itdDate:'20261022', itdTime:'1930'});
  assert.deepEqual(nswDateTime(new Date('2026-07-22T08:30:00Z')), {itdDate:'20260722', itdTime:'1830'});
});

test('mode filters exclude every non-selected transport class', () => {
  const u = tripUrl(blacktown,central,'train',new Date('2026-10-22T08:30:00Z'));
  assert.equal(u.host,'api.transport.nsw.gov.au');
  assert.equal(u.searchParams.get('TfNSWTR'),'true');
  assert.equal(u.searchParams.get('exclMOT_1'),null);
  for (const cls of [2,4,5,7,9,11]) assert.equal(u.searchParams.get(`exclMOT_${cls}`),'1');
  assert.equal(u.searchParams.get('name_origin'),blacktown.id);
  assert.ok(stopFinderUrl('Circular Quay').toString().includes('stop_finder'));
});

test('stop finder returns TfNSW stop identifiers, deduplicating platforms', () => {
  const payload = {locations:[
    {type:'stop',id:'A',name:'Central Station',modes:[1]},
    {type:'platform',id:'P',name:'Central Platform 1',parent:{type:'stop',id:'A',name:'Central Station'}},
    {type:'address',id:'X',name:'Central Address'},
    {type:'stop',id:'B',name:'Central Bus Stop',modes:[5]}
  ]};
  assert.deepEqual(normaliseStops(payload).map(s=>s.id),['A','B']);
});

test('selectJourney enforces bus-only and chooses earliest arrival using realtime values', () => {
  const now=new Date(dt('08:59'));
  const payload = {journeys:[
    {legs:[mkLeg(1,blacktown,parramatta,'09:02','09:14')]},
    {legs:[mkLeg(5,blacktown,parramatta,'09:06','09:30')]},
    {legs:[mkLeg(5,blacktown,parramatta,'09:03','09:22',4)]}
  ]};
  const best=selectJourney(payload,'bus',now);
  assert.equal(best.legs[0].mode,'bus');
  assert.equal(best.arrival,dt('09:26'));
  assert.equal(best.realtime,true);
  assert.equal(best.legs[0].stops.length,2);
});

test('mode filtering rejects a faster mixed-mode journey', () => {
  const now=new Date(dt('09:00'));
  const payload={journeys:[{legs:[mkLeg(5,blacktown,parramatta,'09:05','09:27'),mkLeg(1,parramatta,central,'09:31','10:02')]}]};
  assert.equal(selectJourney(payload,'bus',now),null);
});

test('multi-leg comparison applies transfer buffer before looking for following train',async () => {
  const now=new Date(dt('09:00'));
  const calls=[];
  const planner=async(from,to,mode,when)=>{
    calls.push({from:from.id,to:to.id,mode,when:when.toISOString()});
    if (mode==='bus') return selectJourney({journeys:[{legs:[mkLeg(5,blacktown,parramatta,'09:03','09:28',2)]}]},'bus',when);
    return selectJourney({journeys:[{legs:[mkLeg(1,parramatta,central,'09:38','10:13')]}]},'train',when);
  };
  const route={id:'bus-train',label:'Bus + train',points:[blacktown,parramatta,central],modes:['bus','train'],transferMinutes:5};
  const result=await planRoute(route,'not-real',{now,getJourney:planner});
  assert.equal(calls.length,2);
  assert.equal(calls[1].when,dt('09:35'));
  assert.equal(result.arrival,dt('10:13'));
  assert.equal(result.minutesFromNow,73);
  assert.equal(result.transfers,1);
  assert.equal(result.realtime,true);
});

test('in-progress indicator is inferred from last stop timestamp',async()=>{
  const now=new Date(dt('09:10'));
  const route={id:'direct',label:'Train',points:[blacktown,central],modes:['train'],transferMinutes:5};
  const stage=selectJourney({journeys:[{legs:[mkLeg(1,blacktown,central,'09:05','09:42')]}]},'train',new Date(dt('09:00')));
  const result=await planRoute(route,'key',{now,getJourney:async()=>stage});
  assert.equal(result.progress,'Service underway (estimated)');
  assert.match(result.location,/Blacktown/);
});

test('reject invalid route descriptions and impossible stops',()=>{
  assert.throws(()=>validateRoute({id:'bad',label:'',points:[blacktown,central],modes:['train']}),/label/);
  assert.throws(()=>validateRoute({id:'good',label:'Missing mode',points:[blacktown,central],modes:[]}),/mode/);
  assert.throws(()=>validateRoute({id:'good',label:'Same stop',points:[blacktown,blacktown],modes:['train']}),/different/);
});

test('specific lines reject other lines and transfers, without matching prefixes', () => {
  const leg = (line, dep='09:05', arr='09:30') => {
    const raw=mkLeg(5,blacktown,parramatta,dep,arr);
    raw.transportation.name=line;
    return raw;
  };
  const payload={journeys:[
    {legs:[leg('700X','09:01','09:10')]},
    {legs:[leg('701','09:02','09:12')]},
    {legs:[leg('700','09:03','09:15'),leg('700','09:16','09:20')]},
    {legs:[leg('700')]}
  ]};
  assert.equal(selectJourney(payload,'bus',new Date(dt('09:00')),{line:'700'}).arrival,dt('09:30'));
  assert.equal(selectJourney(payload,'bus',new Date(dt('09:00')),{line:'999'}),null);
  assert.equal(selectJourney(payload,'bus',new Date(dt('09:06')),{line:'700'}),null);
});

test('service timing and line choices flow through all legs while respecting connections', async () => {
  const calls=[];
  const route={id:'selected',label:'700 then T1',points:[blacktown,parramatta,central],modes:['bus','train'],transferMinutes:5,
    services:[{line:'700',departureAfter:dt('09:10')},{line:'T1',departureAfter:dt('09:20')}]};
  const result=await planRoute(route,'key',{now:new Date(dt('09:00')),getJourney:async(from,to,mode,when,key,fetchImpl,service)=>{
    calls.push({when:when.toISOString(),line:service.line});
    return selectJourney({journeys:[{legs:[mkLeg(mode==='bus'?5:1,from,to,mode==='bus'?'09:10':'09:40',mode==='bus'?'09:30':'10:10')]}]},mode,when,service);
  }});
  assert.deepEqual(calls,[{when:dt('09:10'),line:'700'},{when:dt('09:35'),line:'T1'}]);
  assert.equal(result.arrival,dt('10:10'));
  assert.deepEqual(result.services,route.services);
});

test('service settings validate optional legacy routes and reject malformed choices', () => {
  const route={id:'selected',label:'Train',points:[blacktown,central],modes:['train']};
  assert.deepEqual(validateRoute(route).services,[{line:'',departureAfter:''}]);
  for (const services of [[],[false],[{line:700}],[{line:'T1',departureAfter:'tomorrow'}],[{departureAfter:'2026-10-22T09:00'}]]) {
    assert.throws(()=>validateRoute({...route,services}));
  }
  assert.throws(()=>validateRoute({...route,modes:['any'],services:[{line:'T1'}]}),/mode/);
});
