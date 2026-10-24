import { createHash } from 'node:crypto';
import { decodeGtfsFeed } from './gtfsrt.js';
import { nswDateTime, throttledRequest } from './tfnsw.js';
import { matchStaticLeg, staticPathForLeg, staticStopName } from './gtfs-static.js';

const API = 'https://api.transport.nsw.gov.au';
const TRACKABLE = new Set(['train', 'metro', 'bus', 'ferry', 'light_rail']);
// Only the paths below can be called. No user-supplied URLs or arbitrary API access.
export const FEEDS = Object.freeze({
  buses:           { label: 'Sydney buses',                  path: 'v1/gtfs',           suffix: 'buses' },
  sydneytrains:    { label: 'Sydney Trains',                 path: 'v2/gtfs',           suffix: 'sydneytrains' },
  nswtrains:       { label: 'NSW TrainLink',                 path: 'v1/gtfs',           suffix: 'nswtrains' },
  metro:           { label: 'Sydney Metro',                 path: 'v2/gtfs',           suffix: 'metro' },
  ferries:         { label: 'Sydney Ferries',               path: 'v1/gtfs',           suffix: 'ferries/sydneyferries' },
  innerwest:       { label: 'Inner West Light Rail (L1)',   path: 'v2/gtfs',           suffix: 'lightrail/innerwest' },
  cbd:             { label: 'CBD & South East (L2/L3)',     path: 'v1/gtfs',           suffix: 'lightrail/cbdandsoutheast' },
  parramatta:      { label: 'Parramatta Light Rail (L4)',   path: 'v1/gtfs',           suffix: 'lightrail/parramatta' },
  newcastle:       { label: 'Newcastle Light Rail',         path: 'v1/gtfs',           suffix: 'lightrail/newcastle' }
});

export function feedsForLeg(leg) {
  if (leg.feedId && FEEDS[leg.feedId]) return [leg.feedId];
  if (leg.mode === 'bus') return ['buses'];
  if (leg.mode === 'ferry') return ['ferries'];
  if (leg.mode === 'metro') return ['metro'];
  if (leg.mode === 'train') return ['sydneytrains', 'nswtrains'];
  if (leg.mode === 'light_rail') {
    const text = `${leg.line || ''} ${leg.from || ''} ${leg.to || ''}`.toUpperCase();
    if (/\bL1\b/.test(text)) return ['innerwest'];
    if (/\bL2\b|\bL3\b/.test(text)) return ['cbd'];
    if (/\bL4\b/.test(text)) return ['parramatta'];
    if (/NEWCASTLE|\bNLR\b/.test(text)) return ['newcastle'];
    return ['innerwest', 'cbd', 'parramatta', 'newcastle'];
  }
  return [];
}

function validId(value, limit = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
function validIso(s) { return typeof s === 'string' && Number.isFinite(Date.parse(s)); }
export function validateTrack(input) {
  if (!input || !validId(input.id, 80) || !/^[\w-]{1,80}$/.test(input.id) || !validId(input.label, 90)) throw new Error('Invalid tracked route.');
  if (!validIso(input.lockedAt) || !input.baseline || !validIso(input.baseline.departure) || !validIso(input.baseline.arrival)) throw new Error('Invalid frozen journey times.');
  if (!Array.isArray(input.legs) || !input.legs.length || input.legs.length > 30) throw new Error('A fixed journey must contain 1–30 public transport legs.');
  const lockedAt = Date.parse(input.lockedAt);
  if (lockedAt > Date.now() + 300_000 || lockedAt < Date.now() - 48 * 3600_000) throw new Error('Tracked journey is outside the 48-hour monitoring window. Unlock and select a new journey.');
  for (const leg of input.legs) {
    if (!TRACKABLE.has(leg.mode) || !validId(leg.id, 30) || !validId(leg.line, 140) || !validIso(leg.departure) || !validIso(leg.arrival)) throw new Error('Invalid fixed service leg.');
    if (leg.stageIndex !== undefined && (!Number.isInteger(leg.stageIndex) || leg.stageIndex < 0 || leg.stageIndex > 5)) throw new Error('Invalid transfer stage.');
    if (leg.feedId && !FEEDS[leg.feedId]) throw new Error('Unknown GTFS-Realtime feed.');
    if (leg.tripId && !validId(leg.tripId)) throw new Error('Invalid GTFS trip ID.');
    if (leg.startDate && !/^\d{8}$/.test(leg.startDate)) throw new Error('Invalid GTFS service date.');
    if (leg.staticPath) {
      const path=leg.staticPath;
      if (!leg.tripId || path.tripId!==leg.tripId || path.feedId!==leg.feedId || path.serviceDate!==leg.startDate ||
          path.version!==1 || !validIso(path.importedAt) || !Array.isArray(path.stops) || path.stops.length<2 || path.stops.length>150 ||
          path.stops.some((stop,i)=>!validId(stop.stopId) || !validId(stop.name,200) || !validIso(stop.scheduledArrival) ||
            !validIso(stop.scheduledDeparture) || !Number.isSafeInteger(stop.sequence) || stop.sequence<0 ||
            (i>0 && stop.sequence<=path.stops[i-1].sequence)) ||
          path.fromStopId!==path.stops[0].stopId || path.toStopId!==path.stops.at(-1).stopId) {
        throw new Error('Invalid saved timetable path. Clear the binding and sync the service again.');
      }
    }
    if (leg.tripIdCandidates && (!Array.isArray(leg.tripIdCandidates) || leg.tripIdCandidates.length > 10 || leg.tripIdCandidates.some(id => !validId(id)))) throw new Error('Invalid trip ID candidates.');
  }
  return input;
}

const CACHE_TTL_MS = 48_000;
const feedCache = new Map();
function cacheKey(key, feed, kind) { return `${createHash('sha256').update(key).digest('hex')}:${feed}:${kind}`; }
function pruneCache() {
  for (const [k, v] of feedCache) if (Date.now() >= v.expires) feedCache.delete(k);
  if (feedCache.size > 200) feedCache.clear();
}

export function feedUrl(feedId, kind) {
  const feed = FEEDS[feedId];
  if (!feed || !['vehicle', 'trip'].includes(kind)) throw new Error('Unknown GTFS feed.');
  return `${API}/${feed.path}/${kind === 'vehicle' ? 'vehiclepos' : 'realtime'}/${feed.suffix}`;
}

export async function loadFeed(feedId, kind, apiKey, fetchImpl = fetch) {
  pruneCache();
  const k = cacheKey(apiKey, feedId, kind);
  const cached = feedCache.get(k);
  if (cached && Date.now() < cached.expires) return cached.promise;
  const promise = throttledRequest(async () => {
    let response;
    try {
      response = await fetchImpl(feedUrl(feedId, kind), {
        headers: { Authorization: `apikey ${apiKey}`, Accept: 'application/x-google-protobuf, application/x-protobuf, application/octet-stream' },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      throw new Error(`GTFS feed unavailable (${error.name === 'TimeoutError' ? 'timeout' : 'network error'}).`);
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error(`GTFS feed access denied (HTTP ${response.status}); your key may need a separate real-time feed subscription.`);
      throw new Error(`GTFS feed returned HTTP ${response.status}.`);
    }
    // Limit downloads, including when Content-Length is missing or wrong.
    const MAX_BYTES = 25 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('GTFS feed exceeds the 25 MB safety limit.');
    const reader = response.body?.getReader();
    let bytes;
    if (!reader) {
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('GTFS feed too large.');
    } else {
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error('GTFS feed exceeds the 25 MB safety limit.');
          chunks.push(value);
        }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; }
      bytes = Buffer.concat(chunks, size);
    }
    return decodeGtfsFeed(bytes, kind);
  });
  feedCache.set(k, { expires: Date.now() + CACHE_TTL_MS, promise });
  promise.catch(() => { if (feedCache.get(k)?.promise === promise) feedCache.delete(k); });
  return promise;
}

function serviceDays(departure) {
  const date = new Date(departure);
  return new Set([nswDateTime(date).itdDate, nswDateTime(new Date(date.getTime() - 24 * 3600_000)).itdDate]);
}
function dateCompatible(trip, leg) {
  if (leg.startDate && trip.startDate && trip.startDate !== leg.startDate) return false;
  return !trip.startDate || serviceDays(leg.departure).has(trip.startDate);
}
function nameRoute(line) {
  // GTFS route_id may look like "2510_700", while Trip Planner labels it "700".
  const match = String(line).toUpperCase().match(/\b(?:T\d{1,2}|M\d{1,2}|L\d|F\d|\d{1,4}[A-Z]?)\b/);
  return match?.[0] || '';
}
function lineMatches(line, routeId) {
  const expected = nameRoute(line);
  if (!expected || !routeId) return false;
  const actual = String(routeId).toUpperCase();
  return actual === expected || actual.split(/[_:.\/-]/).includes(expected);
}
function nearBoarding(update, departure) {
  const scheduled = Date.parse(departure);
  let nearest = null;
  for (const stop of update.stops || []) {
    const times = [stop.departure?.time, stop.arrival?.time].filter(Boolean);
    for (const time of times) {
      const distance = Math.abs(Date.parse(time) - scheduled) / 60000;
      if (distance <= 9 && (nearest === null || distance < nearest)) nearest = distance;
    }
  }
  return nearest;
}
export function candidateServices(leg, feedData, now = new Date()) {
  if (Date.parse(leg.departure) + 45 * 60_000 < now.getTime()) return [];
  const matches = [];
  for (const [feedId, data] of Object.entries(feedData)) {
    for (const update of data.trip?.entities || []) {
      const descriptor = update.trip || {};
      if (!descriptor.tripId || !dateCompatible(descriptor, leg) || !lineMatches(leg.line, descriptor.routeId)) continue;
      const offset = nearBoarding(update, leg.departure);
      if (offset === null) continue;
      matches.push({ tripId: descriptor.tripId, routeId: descriptor.routeId, startDate: descriptor.startDate || '', feedId,
        minutesFromBoarding: Math.round(offset), reason: 'Same route and a nearby stop update; not proof this is your service' });
    }
  }
  return matches.sort((a, b) => a.minutesFromBoarding - b.minutesFromBoarding).slice(0, 8);
}

function findMatches(leg, feedData) {
  const ids = leg.tripId ? [leg.tripId] : (leg.tripIdCandidates || []);
  if (!ids.length) return [];
  const matches = new Map();
  for (const [feedId, data] of Object.entries(feedData)) {
    if (!feedsForLeg(leg).includes(feedId)) continue;
    for (const kind of ['vehicle', 'trip']) {
      for (const entity of data[kind]?.entities || []) {
        if (!ids.includes(entity.trip.tripId) || !dateCompatible(entity.trip, leg)) continue;
        const id = `${feedId}|${entity.trip.tripId}|${entity.trip.startDate || ''}`;
        if (!matches.has(id)) matches.set(id, { feedId, tripId: entity.trip.tripId, startDate: entity.trip.startDate || '', vehicle: null, trip: null });
        matches.get(id)[kind] = entity;
      }
    }
  }
  return [...matches.values()];
}
function freshTripUpdate(update, feedTimestamp, now) {
  const stamp = update?.timestamp || feedTimestamp;
  // Trip updates without timestamps exist on some TfNSW feeds. Do not invent
  // freshness; when a timestamp exists, suppress stale GTFS ETA predictions.
  return !stamp || Math.abs(now.getTime() - Date.parse(stamp)) <= 5 * 60_000;
}
function latestStopEvent(leg, update, path, now, feedTimestamp, kind = 'arrival') {
  const fallback = { time:leg[kind], basis:'locked-plan' };
  if (!update || !freshTripUpdate(update, feedTimestamp, now)) return fallback;
  const target = kind === 'arrival' ? path?.stops?.at(-1) : path?.stops?.[0];
  const stopId = kind === 'arrival' ? leg.toStopId : leg.fromStopId;
  const savedStop = kind === 'arrival' ? leg.stops?.at(-1) : leg.stops?.[0];
  const ids = new Set([kind === 'arrival' ? path?.toStopId : path?.fromStopId, stopId, savedStop?.id].filter(Boolean).map(String));
  const matches = (stop, point) => {
    // A sequence disambiguates repeated visits to the same stop on a loop.
    if (point && stop.stopSequence !== undefined) return Number(stop.stopSequence) === Number(point.sequence);
    return ids.has(String(stop.stopId));
  };
  const direct = update.stops?.find(stop => matches(stop,target));
  if (direct?.scheduleRelationship === 1) return {...fallback, skipped:true};
  if (direct?.scheduleRelationship === 2) return {...fallback, noData:true};
  const planned = target?.[kind === 'arrival' ? 'scheduledArrival' : 'scheduledDeparture'] ||
    leg[kind === 'arrival' ? 'plannedArrival' : 'plannedDeparture'];
  const event = direct?.[kind];
  if (event?.time) return {time:event.time,basis:'gtfs-stop'};
  if (Number.isFinite(event?.delaySeconds) && Math.abs(event.delaySeconds) <= 4*3600 && planned) {
    return {time:new Date(Date.parse(planned)+event.delaySeconds*1000).toISOString(),basis:'gtfs-stop-delay'};
  }
  // Propagate only updates known to precede this event. NO_DATA terminates
  // prediction propagation. SKIPPED does not terminate the preceding delay.
  let delay = update.delaySeconds;
  let basis = path ? 'gtfs-trip-delay-static' : 'gtfs-trip-delay';
  if (target) {
    const preceding = (update.stops || []).filter(stop => Number.isFinite(Number(stop.stopSequence)) &&
      (Number(stop.stopSequence) < Number(target.sequence) || stop === direct))
      .sort((a,b)=>Number(a.stopSequence)-Number(b.stopSequence));
    for (const stop of preceding) {
      if (stop.scheduleRelationship === 2) { delay=undefined; continue; }
      const event = kind === 'departure' || stop !== direct ? stop.departure || stop.arrival : stop.arrival || stop.departure;
      if (Number.isFinite(event?.delaySeconds)) { delay=event.delaySeconds; basis='gtfs-propagated-delay'; }
      else if (event?.time) {
        const scheduled = path.stops.find(point=>Number(point.sequence) === Number(stop.stopSequence));
        const reference = stop.departure === event ? scheduled?.scheduledDeparture : scheduled?.scheduledArrival;
        if (reference) { delay=(Date.parse(event.time)-Date.parse(reference))/1000; basis='gtfs-propagated-delay'; }
      }
    }
  }
  if (Number.isFinite(delay) && Math.abs(delay) <= 4*3600) {
    const base = planned || leg[kind];
    return {time:new Date(Date.parse(base)+delay*1000).toISOString(),basis};
  }
  return fallback;
}
function namedProgress(path,gps,now,delaySeconds=0) {
  if(!path?.stops?.length) return {label:'',nextStopName:null,stopProgressBasis:null,completedStops:0};
  const list=path.stops;
  if(gps) {
    const idx=list.findIndex(s=>gps.currentStopSequence!==null && gps.currentStopSequence!==undefined
      ? s.sequence===gps.currentStopSequence : gps.stopId && s.stopId===gps.stopId);
    if(idx>=0) {
      const stop=list[idx],isStopped=gps.currentStatus===1;
      const label=isStopped?`At ${stop.name}`:gps.currentStatus===0?`Approaching ${stop.name}`:`Heading towards ${stop.name}`;
      const completedStops=idx;
      return {label,nextStopName:isStopped?list[idx+1]?.name||null:stop.name,completedStops,stopProgressBasis:'gps-feed'};
    }
  }
  const at=now.getTime();
  let last=-1;
  for(let i=0;i<list.length;i++) if(Date.parse(list[i].scheduledDeparture)+delaySeconds*1000<=at) last=i;
  const next=list[Math.min(list.length-1,last+1)];
  if(last<0)return {label:`Scheduled departure: ${list[0].name}`,nextStopName:list[1]?.name||null,completedStops:0,stopProgressBasis:'timetable'};
  if(last===list.length-1)return {label:`Scheduled arrival time passed: ${list.at(-1).name}`,nextStopName:null,completedStops:last,stopProgressBasis:'timetable'};
  return {label:`Timetable estimate: ${list[last].name} → ${next.name}`,nextStopName:next.name,completedStops:last,stopProgressBasis:'timetable'};
}
function gpsFix(vehicle, now) {
  if (!vehicle?.position || !vehicle.timestamp) return null;
  const seconds = Math.round((now.getTime() - Date.parse(vehicle.timestamp)) / 1000);
  if (seconds < -90 || seconds > 150) return null;
  return { ...vehicle.position, observedAt: vehicle.timestamp, ageSeconds: Math.max(0, seconds),
    stopId: vehicle.stopId || null, currentStopSequence: vehicle.currentStopSequence ?? null,
    // GTFS-R: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
    currentStatus: vehicle.currentStatus ?? null, vehicleLabel: vehicle.vehicle?.label || null };
}
function legStatus(leg, available, now, data, errors, staticInfo = null) {
  const staticMatch=staticInfo?.status==='unique' ? staticInfo.match : null;
  const inferred=staticMatch && !leg.tripId;
  const sourceLeg=inferred ? {...leg,tripId:staticMatch.tripId,feedId:staticMatch.feedId,startDate:staticMatch.serviceDate} : leg;
  const path=staticInfo?.path || staticMatch?.path || null;
  const matches=findMatches(sourceLeg,data);
  const selected=matches.length===1?matches[0]:null;
  const bound=Boolean(sourceLeg.tripId);
  const result={
    id:leg.id,stageIndex:leg.stageIndex,mode:leg.mode,line:leg.line,from:leg.from,to:leg.to,
    departure:leg.departure,estimatedDeparture:leg.departure,departureBasis:'locked-plan',
    scheduledArrival:leg.arrival,estimatedArrival:leg.arrival,
    match:inferred?'timetable-linked':'unmatched',etaBasis:'locked-plan',gps:null,
    tripId:sourceLeg.tripId||null,feedId:sourceLeg.feedId||null,startDate:sourceLeg.startDate||null,
    candidates:[],feedError:errors.filter(e=>feedsForLeg(sourceLeg).includes(e.feedId)).map(e=>e.message).slice(0,2),
    currentStopId:null,cancelled:false,skippedStop:false,
    staticPath:path,staticStatus:staticInfo?.status||null,staticMissing:staticInfo?.missing||[],
    binding:inferred?{tripId:staticMatch.tripId,feedId:staticMatch.feedId,startDate:staticMatch.serviceDate,source:'static-auto'}:null,
    locationLabel:'',nextStopName:null,stopProgressBasis:null,completedStops:0
  };
  let tripDelay=0;
  if(selected){
    result.match='matched';result.tripId=selected.tripId;result.feedId=selected.feedId;
    result.startDate=selected.startDate||sourceLeg.startDate||null;
    result.gps=gpsFix(selected.vehicle,now);result.currentStopId=selected.vehicle?.stopId||null;
    result.cancelled=selected.trip?.trip?.scheduleRelationship===3||selected.vehicle?.trip?.scheduleRelationship===3;
    const timestamp=data[selected.feedId]?.trip?.feedTimestamp;
    const eta=latestStopEvent(leg,selected.trip,path,now,timestamp,'arrival');
    const departure=latestStopEvent(leg,selected.trip,path,now,timestamp,'departure');
    result.estimatedArrival=eta.time; result.etaBasis=eta.basis;
    result.estimatedDeparture=departure.time; result.departureBasis=departure.basis;
    result.skippedStop=Boolean(eta.skipped); result.skippedBoarding=Boolean(departure.skipped);
    result.tripUpdateAt=selected.trip?.timestamp||data[selected.feedId]?.trip?.feedTimestamp||null;
    tripDelay=freshTripUpdate(selected.trip,timestamp,now) && Number.isFinite(selected.trip?.delaySeconds)?selected.trip.delaySeconds:0;
  }else if(matches.length>1) result.match='ambiguous';
  else if(staticInfo?.status==='ambiguous' && !bound) result.match='static-ambiguous';
  else if(bound&&result.feedError.length) result.match=inferred?'timetable-linked':'feed-error';
  else if(bound) result.match=inferred?'timetable-linked':'not-observed';
  else if(result.feedError.length&&!available.length) result.match='feed-error';
  if(!bound&&result.match==='unmatched')result.candidates=candidateServices(leg,data,now);
  const position=namedProgress(path,result.gps,now,tripDelay);
  if(!position.label && result.gps?.stopId && staticInfo?.observedStopName){
    const name=staticInfo.observedStopName;
    position.label=result.gps.currentStatus===1?`At ${name}`:result.gps.currentStatus===0?`Approaching ${name}`:`Heading towards ${name}`;
    position.nextStopName=name;position.stopProgressBasis='gps-feed';
  }
  Object.assign(result,{locationLabel:position.label,nextStopName:position.nextStopName,
    stopProgressBasis:position.stopProgressBasis,completedStops:position.completedStops});
  return result;
}

function connectionBuffer(track, index) {
  const previous=track.legs[index-1], following=track.legs[index];
  const baseline=(track.baseline.stages || []).flatMap((stage,stageIndex)=>(stage.legs || []).map(leg=>({...leg,stageIndex})));
  const publicPositions=baseline.flatMap((leg,i)=>leg.mode!=='walk'?[i]:[]);
  const before=publicPositions[index-1], after=publicPositions[index];
  if (before !== undefined && after !== undefined && baseline[before].departure===previous.departure && baseline[after].departure===following.departure) {
    const walking=baseline.slice(before+1,after).filter(leg=>leg.mode==='walk')
      .reduce((minutes,leg)=>minutes+Math.max(0,(Date.parse(leg.arrival)-Date.parse(leg.departure))/60000 || 0),0);
    return walking+(baseline[before].stageIndex!==baseline[after].stageIndex ? track.transferMinutes ?? 5 : 0);
  }
  return previous.stageIndex !== following.stageIndex ? track.transferMinutes ?? 5 : 0;
}

export function updateFixedTrack(trackInput, feedData, now = new Date(), errors = [], staticResults = {}) {
  const track = validateTrack(trackInput);
  const available = Object.keys(feedData);
  const legs = track.legs.map(leg => legStatus(leg, available, now, feedData, errors, staticResults[leg.id]));
  const final = legs.at(-1);
  const lastBaseline = track.legs.at(-1).arrival;
  const delta = Number.isFinite(Date.parse(final?.estimatedArrival)) ? Date.parse(final.estimatedArrival) - Date.parse(lastBaseline) : 0;
  const arrival = new Date(Date.parse(track.baseline.arrival) + delta).toISOString();
  const departure = track.baseline.departure;
  let connectionRisk = false;
  for (let i = 1; i < legs.length; i++) {
    const previous = legs[i - 1], following = legs[i];
    const buffer = connectionBuffer(track,i);
    if (Date.parse(previous.estimatedArrival) + buffer * 60_000 > Date.parse(following.estimatedDeparture || following.departure)) connectionRisk = true;
  }
  const active = legs.find(leg => Date.parse(leg.estimatedDeparture || leg.departure) <= now.getTime() && Date.parse(leg.estimatedArrival) >= now.getTime());
  const confirmed = active?.gps ? active : legs.find(leg => leg.gps);
  let progress = 'Locked — service not yet departed', location = '';
  if (legs.some(leg => leg.cancelled)) progress = 'Fixed service cancelled — original selection retained';
  else if (legs.some(leg => leg.skippedStop || leg.skippedBoarding)) progress = 'Required stop skipped — fixed services unchanged';
  else if (connectionRisk) progress = 'Connection at risk — fixed services unchanged';
  else if (now.getTime() > Date.parse(arrival)) progress = 'Arrival time has passed (not confirmed)';
  else if (confirmed) {
    progress = 'Vehicle GPS observed';
    location = confirmed.locationLabel || (confirmed.gps.stopId ? `GPS: stop ${confirmed.gps.stopId}` : `GPS fix at ${confirmed.gps.observedAt}`);
  } else if (active) {
    progress = 'Service underway (timetable/forecast)';
    const original = track.baseline.stages?.flatMap(s => s.legs).find(l => l.line === active.line && l.departure === active.departure);
    location = active.locationLabel || original?.stops?.filter(s => Date.parse(s.departure || s.arrival) <= now.getTime()).at(-1)?.name || active.from;
  } else if (now.getTime() > Date.parse(departure)) progress = 'Between fixed services / waiting';
  const delayMinutes = Math.round((Date.parse(arrival) - Date.parse(track.baseline.plannedArrival || track.baseline.arrival)) / 60000);
  const snapshot = {
    id: track.id, label: track.label, departure, arrival,
    minutesFromNow: Math.max(0, Math.ceil((Date.parse(arrival) - now.getTime()) / 60000)),
    durationMinutes: Math.ceil((Date.parse(arrival) - Date.parse(departure)) / 60000),
    delayMinutes, transfers: track.baseline.transfers || 0,
    walkingMinutes: track.baseline.walkingMinutes || 0,
    realtime: legs.some(l => l.match === 'matched' && (l.gps || l.etaBasis !== 'locked-plan')),
    progress, location, stages: track.baseline.stages || [], updatedAt: now.toISOString(),
    fixed: {
      lockedAt: track.lockedAt, hasGps: Boolean(confirmed), connectionRisk,
      comparable: !connectionRisk && !legs.some(l => l.cancelled || l.skippedStop || l.skippedBoarding),
      legs, errors: errors.slice(0, 6)
    }
  };
  return snapshot;
}

export async function pollFixedTracks(inputs, apiKey, options = {}) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 12) throw new Error('Track 1–12 routes per request.');
  const tracks = inputs.map(validateTrack);
  if (tracks.reduce((sum, t) => sum + t.legs.length, 0) > 40) throw new Error('Too many tracked public transport services.');
  const ids = new Set();
  for (const t of tracks) { if (ids.has(t.id)) throw new Error('Duplicate tracked route ID.'); ids.add(t.id); }
  const feedIds = [...new Set(tracks.flatMap(track => track.legs.flatMap(feedsForLeg)))];
  const get = options.getFeed || loadFeed;
  const now = options.now || new Date();
  const tasks = feedIds.flatMap(feedId => ['vehicle', 'trip'].map(kind => ({ feedId, kind })));
  const settled = await Promise.allSettled(tasks.map(item => get(item.feedId, item.kind, apiKey)));
  const data = {}, errors = [];
  settled.forEach((settlement, index) => {
    const item = tasks[index];
    if (settlement.status === 'fulfilled') {
      (data[item.feedId] ||= {})[item.kind] = settlement.value;
    } else errors.push({ ...item, message: `${FEEDS[item.feedId].label} ${item.kind === 'trip' ? 'trip updates' : 'vehicle positions'}: ${settlement.reason?.message || 'feed error'}` });
  });
  // Resolve static indexes once per leg. Timetable failures never prevent the
  // real-time feed result from being returned to the user.
  const staticByTrack = new Map();
  const lookup = options.staticLookup || (async leg => leg.staticPath ?
    {status:'saved',path:leg.staticPath} : leg.tripId ?
    {status:'bound',path:await staticPathForLeg(leg)} : matchStaticLeg(leg,{now}));
  for(const track of tracks){
    const info={};
    for(const leg of track.legs){
      try {
        info[leg.id]=await lookup(leg);
        if(!info[leg.id]?.path && !info[leg.id]?.match?.path){
          const maybeIds=[leg.tripId,...(leg.tripIdCandidates||[])].filter(Boolean);
          for(const feedId of feedsForLeg(leg)){
            const current=data[feedId]?.vehicle?.entities?.find(e=>maybeIds.includes(e.trip.tripId) && e.stopId);
            if(current){
              info[leg.id].observedStopName=await (options.stopLookup||staticStopName)(feedId,current.stopId);
              break;
            }
          }
        }
      } catch(e){info[leg.id]={status:'unavailable',missing:feedsForLeg(leg)};}
    }
    staticByTrack.set(track.id,info);
  }
  return { updatedAt: now.toISOString(), results: tracks.map(t => ({ok:true,data:updateFixedTrack(t, data, now, errors, staticByTrack.get(t.id))})),
    feedStatus: { successful: settled.filter(s => s.status === 'fulfilled').length, total: tasks.length, errors } };
}
