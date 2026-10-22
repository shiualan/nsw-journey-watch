import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildIndexFromZip, serviceTime, serviceDates, serviceIsActive, stationKey,
  matchStaticLeg, staticPathForLeg, scheduleUrl, csvRows, parseSeconds } from '../src/gtfs-static.js';
import { updateFixedTrack, pollFixedTracks } from '../src/tracking.js';
import { Readable } from 'node:stream';
const fixture = fileURLToPath(new URL('./fixtures/mini-bus.zip',import.meta.url));
const at='2026-10-22T00:00:00Z';
const make = () => buildIndexFromZip(fixture,'buses',at);
const leg = (overrides={}) => ({
  id:'0-0',stageIndex:0,mode:'bus',line:'700',from:'Blacktown Station',to:'Parramatta Station',
  fromStopId:'unknownEFA',toStopId:'unknownEFA2',
  departure:'2026-10-21T21:00:00.000Z',arrival:'2026-10-21T21:25:00.000Z',
  plannedDeparture:'2026-10-21T21:00:00.000Z',plannedArrival:'2026-10-21T21:25:00.000Z',
  tripIdCandidates:[] ,...overrides
});
const track = (l=leg()) => ({id:'r1',label:'Route A',lockedAt:'2026-10-21T20:55:00.000Z',
  baseline:{departure:l.departure,arrival:l.arrival,transfers:0,walkingMinutes:0,stages:[]},legs:[l]});

test('ZIP schedule importer indexes GTFS routes, stops, trips and quoted CSV fields',async()=>{
  const index=await make();
  assert.equal(index.meta.trips,3);assert.equal(index.meta.stopTimes,9);
  assert.equal(index.routes['700route'][0],'700');
  assert.equal(index.stops['2101'][0],'Blacktown Station, Stand A');
  assert.equal(index.stops['2104'][0],'A place with "quotes"');
  assert.equal(index.trips['B700-100'][4].length,3);
});
test('CSV reads an escaped quote split across stream chunks',async()=>{
  const chunks=['id,name,code\n1,"A, big "','"quoted','""","x"\n'];
  const rows=[]; for await (const r of csvRows(Readable.from(chunks)))rows.push(r);
  assert.deepEqual(rows,[['id','name','code'],['1','A, big "quoted"','x']]);
});
test('Sydney GTFS service clock supports +24-hour trips and a DST service date',()=>{
  assert.equal(serviceTime('20261022',8*3600),'2026-10-21T21:00:00.000Z');
  assert.equal(serviceTime('20261021',25*3600+5*60),'2026-10-21T14:05:00.000Z');
  assert.deepEqual(serviceDates('2026-10-21T14:05:00.000Z'),['20261022','20261021']);
  assert.equal(parseSeconds('25:05:00'),90300);
  assert.equal(parseSeconds('49:00:00'),null);
  assert.equal(stationKey('Blacktown Station, Platform 2'),stationKey('Blacktown Station'));
});
test('calendar exception removes a weekday even when base timetable includes it',async()=>{
  const index=await make();
  assert.equal(serviceIsActive(index,'weekday','20261022'),false);
  assert.equal(serviceIsActive(index,'weekday','20261023'),true);
  assert.equal(serviceIsActive(index,'weekday','20261024'),false);
});
test('static matcher finds a uniquely timed service and mapped boarding/alighting stops',async()=>{
  const index=await make();
  // Thu 22 Oct is removed by calendar_dates, so exercise Wed 21 Oct by
  // constructing the matching times for that local service day.
  const shift=24*3600_000;
  const l=leg({departure:new Date(Date.parse(leg().departure)-shift).toISOString(),
    plannedDeparture:new Date(Date.parse(leg().departure)-shift).toISOString(),
    arrival:new Date(Date.parse(leg().arrival)-shift).toISOString(),
    plannedArrival:new Date(Date.parse(leg().arrival)-shift).toISOString()});
  const result=await matchStaticLeg(l,{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  assert.equal(result.status,'unique');
  assert.equal(result.match.tripId,'B700-100');
  assert.equal(result.match.path.stops[1].name,'Seven Hills Station, Stand B');
  assert.equal(result.match.path.fromStopId,'2101');
  assert.equal(result.match.path.toStopId,'2103');
});
test('matcher leaves multiple equally plausible services ambiguous',async()=>{
  const index=await make();index.trips['duplicate']=[...index.trips['B700-100'].slice(0,4),index.trips['B700-100'][4].map(s=>[...s])];
  const l=leg({departure:'2026-10-20T21:00:00Z',arrival:'2026-10-20T21:25:00Z',plannedDeparture:'2026-10-20T21:00:00Z',plannedArrival:'2026-10-20T21:25:00Z'});
  const result=await matchStaticLeg(l,{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  assert.equal(result.status,'ambiguous');assert.equal(result.match,null);
});
test('station names alone cannot override service date exceptions',async()=>{
  const index=await make();
  const result=await matchStaticLeg(leg(),{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  assert.equal(result.status,'none');
});
test('GTFS timetable match can link a fixed journey and show named stops without claiming GPS',async()=>{
  const index=await make();
  const l=leg({departure:'2026-10-20T21:00:00Z',arrival:'2026-10-20T21:25:00Z',plannedDeparture:'2026-10-20T21:00:00Z',plannedArrival:'2026-10-20T21:25:00Z'});
  const result=await matchStaticLeg(l,{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  const snapshot=updateFixedTrack(track(l),{},new Date('2026-10-20T21:14:00Z'),[],{'0-0':result});
  assert.equal(snapshot.fixed.legs[0].match,'timetable-linked');
  assert.equal(snapshot.fixed.hasGps,false);
  assert.match(snapshot.location,/Seven Hills Station/);
  assert.match(snapshot.fixed.legs[0].locationLabel,/Timetable estimate:/);
  assert.equal(snapshot.fixed.legs[0].binding.source,'static-auto');
});
test('fresh GPS with matched timetable trip ID resolves current station by GTFS stop sequence',async()=>{
  const index=await make();
  const l=leg({departure:'2026-10-20T21:00:00Z',arrival:'2026-10-20T21:25:00Z',plannedDeparture:'2026-10-20T21:00:00Z',plannedArrival:'2026-10-20T21:25:00Z'});
  const match=await matchStaticLeg(l,{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  const now=new Date('2026-10-20T21:14:00Z');
  const vehicle={trip:{tripId:'B700-100',startDate:'20261021'},position:{latitude:-33.775,longitude:150.937},
    timestamp:'2026-10-20T21:13:20Z',currentStopSequence:2,currentStatus:1,stopId:'2102'};
  const update={trip:{tripId:'B700-100',startDate:'20261021'},stops:[{stopId:'2103',arrival:{delaySeconds:180}}]};
  const data={buses:{vehicle:{entities:[vehicle]},trip:{entities:[update],feedTimestamp:now.toISOString()}}};
  const snapshot=updateFixedTrack(track(l),data,now,[],{'0-0':match});
  const observed=snapshot.fixed.legs[0];
  assert.equal(observed.match,'matched');assert.equal(snapshot.fixed.hasGps,true);
  assert.match(snapshot.location,/At Seven Hills Station/);
  assert.equal(observed.nextStopName,'Parramatta Station, Stand C');
  assert.equal(observed.estimatedArrival,'2026-10-20T21:28:00.000Z');
  assert.equal(observed.etaBasis,'gtfs-stop-delay');
});
test('schedule endpoint pairs Sydney Trains static v1 with live v2',()=>{
  assert.equal(scheduleUrl('sydneytrains'),'https://api.transport.nsw.gov.au/v1/gtfs/schedule/sydneytrains');
  assert.equal(scheduleUrl('metro'),'https://api.transport.nsw.gov.au/v2/gtfs/schedule/metro');
  assert.throws(()=>scheduleUrl('../evil'),/Unsupported/);
});
test('GTFS destination stop marked SKIPPED blocks a fixed journey recommendation',async()=>{
  const index=await make();
  const l=leg({departure:'2026-10-20T21:00:00Z',arrival:'2026-10-20T21:25:00Z',plannedDeparture:'2026-10-20T21:00:00Z',plannedArrival:'2026-10-20T21:25:00Z'});
  const match=await matchStaticLeg(l,{readIndex:async id=>id==='buses'?index:null,now:new Date('2026-10-22T01:00:00Z')});
  const data={buses:{trip:{feedTimestamp:'2026-10-20T21:14:00Z',entities:[{
    trip:{tripId:'B700-100',startDate:'20261021'},stops:[{stopId:'2103',scheduleRelationship:1}]
  }]}}};
  const observed=updateFixedTrack(track(l),data,new Date('2026-10-20T21:14:00Z'),[],{'0-0':match});
  assert.equal(observed.fixed.legs[0].skippedStop,true);
  assert.equal(observed.fixed.comparable,false);
});
