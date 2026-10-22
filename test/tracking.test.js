import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGtfsFeed } from '../src/gtfsrt.js';
import { feedsForLeg, feedUrl, candidateServices, updateFixedTrack, pollFixedTracks, loadFeed } from '../src/tracking.js';

const now = new Date();
const iso = minutes => new Date(now.getTime() + minutes * 60000).toISOString();
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Australia/Sydney', year:'numeric', month:'2-digit', day:'2-digit'}).format(now).replace(/-/g,'');
const encodeVarint = n => {
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const result = [];
  do {
    let b = Number(v & 127n);
    v >>= 7n;
    if (v) b |= 128;
    result.push(b);
  } while (v);
  return Buffer.from(result);
};
const tag = (n, wire) => encodeVarint(n * 8 + wire);
const vi = (n, value) => Buffer.concat([tag(n, 0), encodeVarint(value)]);
const st = (n, value) => nested(n, Buffer.from(value));
const nested = (n, val) => Buffer.concat([tag(n, 2), encodeVarint(val.length), val]);
const f32 = (n, value) => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return Buffer.concat([tag(n,5), bytes]); };
const msg = (...parts) => Buffer.concat(parts);
const startDate = today;
const timeSec = value => Math.floor(Date.parse(value)/1000);
const id = '12345_GTFS_SERVICE';
const descriptor = (tripId=id, routeId='2510_700') => msg(st(1,tripId), st(3,startDate), st(5,routeId));
const feedHeader = () => nested(1,msg(st(1,'2.0'),vi(2,0),vi(3,timeSec(iso(0)))));
function makeVehicle({tripId=id, routeId='2510_700', observation=iso(0), position=true, currentStatus=2}={}) {
  return msg(nested(1,descriptor(tripId,routeId)),
    ...(position ? [nested(2,msg(f32(1,-33.76942),f32(2,150.90743),f32(3,100)))]:[]),
    vi(3,7),vi(4,currentStatus),vi(5,timeSec(observation)),st(7,'GTFS-STOP-B'),nested(8,st(2,'Bus 11')));
}
function makeTrip({tripId=id, routeId='2510_700', delay=120, stopId='GTFS-STOP-B'}={}) {
  return msg(nested(1,descriptor(tripId,routeId)),
    nested(2,msg(vi(1,7),nested(2,msg(vi(1,delay),vi(2,timeSec(iso(12))))),st(4,stopId))),
    vi(4,timeSec(iso(0))),vi(5,delay));
}
function makeFeed(kind, contents) {
  return msg(feedHeader(), ...contents.map((record,i) => nested(2,msg(st(1,`entity-${i}`),nested(kind==='vehicle'?4:3,record),st(1999,'TfNSW vendor extension')))));
}
const mkTrack = (overrides={}) => ({
  id:'r-bus-train', label:'Bus then train', lockedAt: iso(-3), transferMinutes:5,
  baseline: {id:'r-bus-train',label:'Bus then train',departure:iso(4),arrival:iso(40),transfers:1,walkingMinutes:0,
    stages:[{legs:[{mode:'bus',line:'700',departure:iso(4),arrival:iso(19),stops:[{name:'Blacktown',departure:iso(4)}]}]},
      {legs:[{mode:'train',line:'T1',departure:iso(25),arrival:iso(40),stops:[{name:'Central',arrival:iso(40)}]}]}]},
  legs:[
    {id:'0-0',mode:'bus',line:'700',from:'Blacktown',to:'Parramatta',departure:iso(4),arrival:iso(19),plannedArrival:iso(19),toStopId:'GTFS-STOP-B',tripIdCandidates:[id]},
    {id:'1-0',mode:'train',line:'T1',from:'Parramatta',to:'Central',departure:iso(25),arrival:iso(40),plannedArrival:iso(40),tripIdCandidates:['TRAIN-ID']}
  ], ...overrides
});
const data = (busVehicle, busTrip, trainVehicle=[], trainTrip=[]) => ({
  buses: {vehicle:{entities:busVehicle,feedTimestamp:iso(0)},trip:{entities:busTrip,feedTimestamp:iso(0)}},
  sydneytrains: {vehicle:{entities:trainVehicle,feedTimestamp:iso(0)},trip:{entities:trainTrip,feedTimestamp:iso(0)}}
});

test('GTFS-Realtime Protocol Buffers decode vehicle location and signed delays', () => {
  const vehicle = decodeGtfsFeed(makeFeed('vehicle',[makeVehicle()]),'vehicle');
  assert.equal(vehicle.entities.length,1);
  assert.equal(vehicle.entities[0].trip.tripId,id);
  assert.equal(vehicle.entities[0].trip.startDate,today);
  assert.ok(Math.abs(vehicle.entities[0].position.latitude + 33.76942) < 0.00002);
  assert.ok(Math.abs(vehicle.entities[0].position.longitude - 150.90743) < 0.00002);
  assert.equal(vehicle.entities[0].currentStopSequence,7);
  assert.equal(vehicle.entities[0].stopId,'GTFS-STOP-B');
  const trip = decodeGtfsFeed(makeFeed('trip',[makeTrip({delay:-120})]),'trip');
  assert.equal(trip.entities[0].delaySeconds,-120);
  assert.equal(trip.entities[0].stops[0].arrival.delaySeconds,-120);
  assert.equal(trip.entities[0].stops[0].stopId,'GTFS-STOP-B');
  assert.equal(trip.feedTimestamp,new Date(timeSec(iso(0))*1000).toISOString());
});

test('binary decoder rejects corrupt data and ignores a GPS fix at 0,0', () => {
  assert.throws(() => decodeGtfsFeed(Buffer.from([0x12,0xff]),'vehicle'), /varint|length|Truncated/);
  const zero = msg(nested(1,descriptor()),nested(2,msg(f32(1,0),f32(2,0))),vi(5,timeSec(iso(0))));
  const decoded = decodeGtfsFeed(makeFeed('vehicle',[zero]),'vehicle');
  assert.equal(decoded.entities[0].position,null);
});

test('GTFS endpoints use the correct v1/v2 URLs for each transport mode', () => {
  assert.equal(feedUrl('sydneytrains','vehicle'),'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/sydneytrains');
  assert.equal(feedUrl('innerwest','trip'),'https://api.transport.nsw.gov.au/v2/gtfs/realtime/lightrail/innerwest');
  assert.equal(feedUrl('buses','vehicle'),'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses');
  assert.deepEqual(feedsForLeg({mode:'light_rail',line:'L4'}), ['parramatta']);
  assert.deepEqual(feedsForLeg({mode:'light_rail',line:'L2'}), ['cbd']);
  assert.ok(feedsForLeg({mode:'train'}).includes('nswtrains'));
  assert.throws(()=>feedUrl('https://example.com','vehicle'), /Unknown/);
});

test('fixed service matching uses exact GTFS ID, not similar line or nearby time', () => {
  const snap = mkTrack();
  const report = updateFixedTrack(snap, data(
    [{...decodeGtfsFeed(makeFeed('vehicle',[makeVehicle()]),'vehicle').entities[0]}],
    [{...decodeGtfsFeed(makeFeed('trip',[makeTrip()]),'trip').entities[0]}]
  ), now);
  assert.equal(report.fixed.legs[0].match,'matched');
  assert.equal(report.fixed.legs[0].tripId,id);
  assert.equal(report.fixed.legs[0].etaBasis,'gtfs-stop');
  assert.ok(report.fixed.legs[0].gps);
  assert.equal(report.fixed.hasGps,true);
  assert.equal(report.fixed.legs[1].match,'unmatched');
  assert.equal(report.baseline,undefined);
  assert.equal(report.departure,snap.baseline.departure);
  assert.equal(report.stages[0].legs[0].line,'700');
});

test('service with different GTFS trip_id cannot be treated as confirmed GPS', () => {
  const wrong = decodeGtfsFeed(makeFeed('vehicle',[makeVehicle({tripId:'OTHER-TRIP'})]),'vehicle').entities;
  const fixed = updateFixedTrack(mkTrack(),data(wrong,[]),now);
  assert.equal(fixed.fixed.legs[0].match,'unmatched');
  assert.equal(fixed.fixed.legs[0].gps,null);
  assert.equal(fixed.fixed.hasGps,false);
});

test('unverified suggestions require route name and a stop update close to boarding', () => {
  const leg = mkTrack().legs[0];
  const update = {
    trip:{tripId:'SUGGESTED',routeId:'2510_700',startDate:today},
    stops:[{departure:{time:iso(5)}}]
  };
  const candidates=candidateServices(leg,{buses:{trip:{entities:[update]}}},now);
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].tripId,'SUGGESTED');
  assert.match(candidates[0].reason,/not proof/);
  const notSameRoute={...update,trip:{...update.trip,routeId:'400'}};
  assert.equal(candidateServices(leg,{buses:{trip:{entities:[notSameRoute]}}},now).length,0);
});

test('stale vehicle fixes are not displayed as fresh GPS', () => {
  const stale = decodeGtfsFeed(makeFeed('vehicle',[makeVehicle({observation:iso(-15)})]),'vehicle').entities;
  const fixed = updateFixedTrack(mkTrack(),data(stale,[]),now);
  assert.equal(fixed.fixed.legs[0].match,'matched');
  assert.equal(fixed.fixed.legs[0].gps,null);
  assert.equal(fixed.fixed.hasGps,false);
});

test('bus delays show connection risk but do not replace the selected train', () => {
  const updates=[{trip:{tripId:id,startDate:today},delaySeconds:900,stops:[]}];
  const fixed=updateFixedTrack(mkTrack(),data([],updates),now);
  assert.equal(fixed.fixed.connectionRisk,true);
  assert.equal(fixed.fixed.comparable,false);
  assert.equal(fixed.fixed.legs[0].etaBasis,'gtfs-trip-delay');
  assert.equal(fixed.fixed.legs[1].line,'T1');
  assert.equal(fixed.fixed.legs[1].departure,mkTrack().legs[1].departure);
});

test('cancellation excludes a locked option without silently replanning it', () => {
  const snap = mkTrack();
  const updates = [{trip:{tripId:id,startDate:today,scheduleRelationship:3},stops:[]}];
  const fixed = updateFixedTrack(snap,data([],updates),now);
  assert.equal(fixed.fixed.legs[0].cancelled,true);
  assert.equal(fixed.fixed.comparable,false);
  assert.match(fixed.progress,/cancelled/i);
  assert.equal(fixed.stages[0].legs[0].line,'700');
});

test('explicitly bound trip ID does not auto switch to another service', () => {
  const track=mkTrack();
  track.legs[0].tripId='EXACT-BUS'; track.legs[0].tripIdCandidates=[id];
  const vehicles=decodeGtfsFeed(makeFeed('vehicle',[makeVehicle()]),'vehicle').entities;
  const fixed=updateFixedTrack(track,data(vehicles,[]),now);
  assert.equal(fixed.fixed.legs[0].match,'not-observed');
  assert.equal(fixed.fixed.legs[0].tripId,'EXACT-BUS');
});

test('polling batches feed fetches once for multiple fixed alternatives and keeps partial errors', async () => {
  const snap=mkTrack();
  const track2=mkTrack({id:'r-two',label:'Different option'});
  const calls=[];
  const getFeed=async(feed,kind)=>{
    calls.push(`${feed}:${kind}`);
    if (feed==='nswtrains') throw new Error('Access denied');
    return {entities:[],feedTimestamp:iso(0)};
  };
  const result=await pollFixedTracks([snap,track2],'mock-key',{now,getFeed,staticLookup:async()=>({status:'none',missing:[]})});
  assert.equal(calls.length,6); // 3 feed ids (buses, Sydney Trains, NSW TrainLink) x 2 types
  assert.equal(result.results.length,2);
  assert.equal(result.feedStatus.errors.length,2);
  assert.equal(result.results[0].data.fixed.legs[0].match,'unmatched');
});

test('GTFS download is decoded and cached for an API key without saving raw key in files', async () => {
  const binary=makeFeed('vehicle',[makeVehicle()]);
  const key=`unit-test-${Date.now()}`;
  let calls=0;
  const fetchImpl=async(url,options)=>{
    calls++;
    assert.match(url,/vehiclepos\/buses$/);
    assert.equal(options.headers.Authorization,`apikey ${key}`);
    return new Response(binary,{status:200,headers:{'content-type':'application/x-protobuf'}});
  };
  const first=await loadFeed('buses','vehicle',key,fetchImpl);
  const second=await loadFeed('buses','vehicle',key,fetchImpl);
  assert.equal(first.entities.length,1);
  assert.equal(first,second);
  assert.equal(calls,1);
});

test('connection risk follows the delayed train departure without replacing the fixed train', () => {
  const snap=mkTrack();
  snap.legs[0].stageIndex=0; snap.legs[1].stageIndex=1;
  snap.legs[1].fromStopId='TRAIN-BOARDING';
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:600,stops:[]}];
  const train=[{trip:{tripId:'TRAIN-ID',startDate:today},timestamp:iso(0),delaySeconds:600,
    stops:[{stopId:'TRAIN-BOARDING',departure:{time:iso(35)}}]}];
  const result=updateFixedTrack(snap,data([],bus,[],train),now);
  assert.equal(result.fixed.legs[0].estimatedArrival,iso(29));
  assert.equal(result.fixed.legs[1].estimatedDeparture,iso(35));
  assert.equal(result.fixed.legs[1].departure,iso(25));
  assert.equal(result.fixed.legs[1].tripId,'TRAIN-ID');
  assert.equal(result.fixed.connectionRisk,false);
  assert.equal(result.fixed.comparable,true);
});

test('a skipped boarding stop excludes a fixed alternative even when its destination is served', () => {
  const snap=mkTrack(); snap.legs[0].fromStopId='BUS-BOARDING';
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),stops:[{stopId:'BUS-BOARDING',scheduleRelationship:1}]}];
  const result=updateFixedTrack(snap,data([],bus),now);
  assert.equal(result.fixed.legs[0].skippedBoarding,true);
  assert.equal(result.fixed.legs[0].skippedStop,false);
  assert.equal(result.fixed.comparable,false);
  assert.match(result.progress,/stop skipped/);
});

const busPath=()=>({fromStopId:'BUS-A',toStopId:'GTFS-STOP-B',stops:[
  {stopId:'BUS-A',sequence:1,scheduledArrival:iso(4),scheduledDeparture:iso(4)},
  {stopId:'BUS-MIDDLE',sequence:2,scheduledArrival:iso(10),scheduledDeparture:iso(11)},
  {stopId:'GTFS-STOP-B',sequence:3,scheduledArrival:iso(19),scheduledDeparture:iso(19)}
]});

test('NO_DATA at the destination suppresses a trip-wide delay', () => {
  const snap=mkTrack();
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:600,
    stops:[{stopId:'GTFS-STOP-B',stopSequence:3,scheduleRelationship:2}]}];
  const result=updateFixedTrack(snap,data([],bus),now,[],{'0-0':{path:busPath()}});
  assert.equal(result.fixed.legs[0].estimatedArrival,iso(19));
  assert.equal(result.fixed.legs[0].etaBasis,'locked-plan');
});

test('NO_DATA upstream stops delay propagation until a later prediction resumes it', () => {
  const snap=mkTrack();
  const update={trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:600,
    stops:[{stopSequence:1,departure:{delaySeconds:180}}, {stopSequence:2,scheduleRelationship:2}]};
  const first=updateFixedTrack(snap,data([],[update]),now,[],{'0-0':{path:busPath()}});
  assert.equal(first.fixed.legs[0].estimatedArrival,iso(19));
  update.stops.push({stopSequence:3,arrival:{delaySeconds:120}});
  const next=updateFixedTrack(snap,data([],[update]),now,[],{'0-0':{path:busPath()}});
  assert.equal(next.fixed.legs[0].estimatedArrival,iso(21));
});

test('stop-specific delay overrides the trip-wide delay at subsequent scheduled stops', () => {
  const snap=mkTrack();
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:600,
    stops:[{stopSequence:2,departure:{delaySeconds:120}}]}];
  const result=updateFixedTrack(snap,data([],bus),now,[],{'0-0':{path:busPath()}});
  assert.equal(result.fixed.legs[0].estimatedArrival,iso(21));
  assert.equal(result.fixed.legs[0].etaBasis,'gtfs-propagated-delay');
});

test('stop sequence disambiguates repeated visits to the same stop on a loop', () => {
  const snap=mkTrack();
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),stops:[
    {stopId:'GTFS-STOP-B',stopSequence:1,arrival:{time:iso(5)}},
    {stopId:'GTFS-STOP-B',stopSequence:3,arrival:{time:iso(22)}}]}];
  const result=updateFixedTrack(snap,data([],bus),now,[],{'0-0':{path:busPath()}});
  assert.equal(result.fixed.legs[0].estimatedArrival,iso(22));
});

test('stale departure predictions do not make an otherwise missed connection look safe', () => {
  const snap=mkTrack();
  snap.legs[1].fromStopId='TRAIN-BOARDING';
  const bus=[{trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:900,stops:[]}];
  const train=[{trip:{tripId:'TRAIN-ID',startDate:today},timestamp:iso(-10),
    stops:[{stopId:'TRAIN-BOARDING',departure:{time:iso(45)}}]}];
  const result=updateFixedTrack(snap,data([],bus,[],train),now);
  assert.equal(result.fixed.legs[1].estimatedDeparture,iso(25));
  assert.equal(result.fixed.legs[1].departureBasis,'locked-plan');
  assert.equal(result.fixed.connectionRisk,true);
});


test('connection risk includes the planned walk between two services within a journey', () => {
  const snap=mkTrack();
  const bus=snap.baseline.stages[0].legs[0];
  const train=snap.baseline.stages[1].legs[0];
  snap.baseline.stages=[{legs:[bus,{mode:'walk',departure:iso(19),arrival:iso(24)},train]}];
  snap.legs.forEach(leg=>{leg.stageIndex=0;});
  // Three minutes late leaves only three minutes for a five-minute walk.
  const result=updateFixedTrack(snap,data([],[{trip:{tripId:id,startDate:today},timestamp:iso(0),delaySeconds:180,stops:[]}]),now);
  assert.equal(result.fixed.legs[0].estimatedArrival,iso(22));
  assert.equal(result.fixed.connectionRisk,true);
  assert.equal(result.fixed.comparable,false);
});


test('GPS stop sequence takes priority over a repeated stop ID when showing progress', () => {
  const snap=mkTrack();
  const path=busPath();
  path.stops[0].stopId='GTFS-STOP-B';
  const vehicle={trip:{tripId:id,startDate:today},timestamp:iso(0),
    position:{latitude:-33.8,longitude:151.0},stopId:'GTFS-STOP-B',currentStopSequence:3,currentStatus:0};
  const result=updateFixedTrack(snap,data([vehicle],[]),now,[],{'0-0':{path}});
  assert.equal(result.fixed.legs[0].completedStops,2);
  assert.equal(result.fixed.legs[0].stopProgressBasis,'gps-feed');
});
