const BASE = 'https://api.transport.nsw.gov.au/v1/tp';
const PT_CLASSES = [1, 2, 4, 5, 7, 9, 11];
const ALLOWED = {
  any: PT_CLASSES,
  train: [1],
  metro: [2],
  light_rail: [4],
  bus: [5, 7, 11],
  ferry: [9]
};

export const MODES = Object.keys(ALLOWED);

export function nswDateTime(when) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(when).map(p => [p.type, p.value])
  );
  return { itdDate: `${parts.year}${parts.month}${parts.day}`, itdTime: `${parts.hour}${parts.minute}` };
}

export function tripUrl(from, to, mode, when) {
  if (!ALLOWED[mode]) throw new Error('Unsupported transport mode.');
  const url = new URL(`${BASE}/trip`);
  const query = {
    outputFormat: 'rapidJSON', coordOutputFormat: 'EPSG:4326',
    depArrMacro: 'dep', ...nswDateTime(when),
    type_origin: 'stop', name_origin: from.id,
    type_destination: 'stop', name_destination: to.id,
    calcNumberOfTrips: '10', TfNSWTR: 'true',
    ptOptionsActive: '1', itOptionsActive: '1'
  };
  if (mode !== 'any') {
    query.excludedMeans = 'checkbox';
    PT_CLASSES.filter(c => !ALLOWED[mode].includes(c)).forEach(c => { query[`exclMOT_${c}`] = '1'; });
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

export function stopFinderUrl(query) {
  const url = new URL(`${BASE}/stop_finder`);
  const params = {
    outputFormat: 'rapidJSON', type_sf: 'any', name_sf: query,
    coordOutputFormat: 'EPSG:4326', anyMaxSizeHitList: '20', TfNSWSF: 'true'
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function normaliseStops(response) {
  const found = response?.locations || response?.stopFinder?.locations || [];
  const map = new Map();
  for (const item of found) {
    const stop = item.type === 'platform' && item.parent?.id ? item.parent : item;
    if (stop.type !== 'stop' || stop.id === undefined || stop.id === null) continue;
    const id = String(stop.id);
    const name = String(stop.name || item.name || stop.disassembledName || '').trim();
    if (!id || !name || map.has(id)) continue;
    const modes = Array.isArray(stop.modes) ? stop.modes : Array.isArray(item.modes) ? item.modes : [];
    map.set(id, { id, name, modes });
  }
  return [...map.values()].slice(0, 15);
}

export function productClass(transport) {
  const cls = Number(transport?.product?.class);
  if (Number.isFinite(cls) && cls > 0) return cls;
  const name = [transport?.product?.name, transport?.name, transport?.description].filter(Boolean).join(' ').toLowerCase();
  if (/walk|foot|pedestrian|cycle|bike/.test(name)) return 100;
  if (/light rail|tram/.test(name)) return 4;
  if (/metro/.test(name)) return 2;
  if (/train|rail/.test(name)) return 1;
  if (/ferr|boat/.test(name)) return 9;
  if (/bus|coach/.test(name)) return 5;
  return 0;
}

function classMode(code) {
  return ({1:'train', 2:'metro', 4:'light_rail', 5:'bus', 7:'bus', 9:'ferry', 11:'bus'})[code] || 'walk';
}

function stopTime(stop, kind) {
  const planned = stop?.[`${kind}TimePlanned`] ?? null;
  const estimate = stop?.[`${kind}TimeEstimated`] ?? null;
  return { planned, value: estimate || planned, realtime: Boolean(estimate) };
}

function isoOrNull(s) {
  if (!s) return null;
  const date = new Date(s);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toStopInfo(stop, index = 0) {
  const arr = stopTime(stop, 'arrival');
  const dep = stopTime(stop, 'departure');
  return {
    id: String(stop?.id ?? index),
    name: String(stop?.name || stop?.disassembledName || 'Stop'),
    arrival: isoOrNull(arr.value), departure: isoOrNull(dep.value),
    realtime: arr.realtime || dep.realtime
  };
}

export function normaliseLeg(raw) {
  const origin = raw?.origin || {};
  const destination = raw?.destination || {};
  const dep = stopTime(origin, 'departure');
  const arr = stopTime(destination, 'arrival');
  const code = productClass(raw?.transportation);
  const mode = classMode(code);
  let stops = Array.isArray(raw?.stopSequence) ? raw.stopSequence.map(toStopInfo) : [];
  if (!stops.length) stops = [toStopInfo(origin, 0), toStopInfo(destination, 1)];
  const depValue = dep.value || raw?.stopSequence?.[0]?.departureTimeEstimated || raw?.stopSequence?.[0]?.departureTimePlanned;
  const arrValue = arr.value || raw?.stopSequence?.at(-1)?.arrivalTimeEstimated || raw?.stopSequence?.at(-1)?.arrivalTimePlanned;
  const transportation = raw?.transportation || {};
  const line = [transportation.disassembledName, transportation.number, transportation.name]
    .find(v => typeof v === 'string' && v.trim()) || transportation.product?.name || (mode === 'walk' ? 'Walk' : mode);
  // EFA/Trip Planner IDs do not always equal GTFS-R trip_id. Only exact GTFS-R
  // matches are attached automatically; uncertain matches need user confirmation.
  const props = transportation.properties || {};
  const possibleIds = [props.gtfsTripId, props.gtfs_trip_id, props.tripId,
    transportation.gtfsTripId, transportation.tripId, transportation.id]
    .filter(v => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 160)
    .map(String);
  return {
    mode, class: code, line: String(line),
    tripIdCandidates: [...new Set(possibleIds)],
    direction: String(transportation.destination?.name || transportation.direction || '').slice(0, 100),
    from: String(origin.name || origin.disassembledName || stops[0]?.name || ''),
    to: String(destination.name || destination.disassembledName || stops.at(-1)?.name || ''),
    departure: isoOrNull(depValue), arrival: isoOrNull(arrValue),
    plannedDeparture: isoOrNull(dep.planned), plannedArrival: isoOrNull(arr.planned),
    realtime: dep.realtime || arr.realtime || stops.some(s => s.realtime),
    stops
  };
}

export function normaliseJourney(journey, requiredMode = 'any') {
  if (!Array.isArray(journey?.legs) || !journey.legs.length) return null;
  const legs = journey.legs.map(normaliseLeg);
  const publicLegs = legs.filter(leg => leg.mode !== 'walk');
  if (!publicLegs.length) return null;
  if (requiredMode !== 'any' && publicLegs.some(leg => leg.mode !== requiredMode)) return null;
  const departure = legs.find(l => l.departure)?.departure;
  const arrival = [...legs].reverse().find(l => l.arrival)?.arrival;
  if (!departure || !arrival || Date.parse(arrival) <= Date.parse(departure)) return null;
  return {
    departure, arrival, legs,
    realtime: publicLegs.some(l => l.realtime),
    transfers: Math.max(0, publicLegs.length - 1),
    walkingMinutes: legs.filter(l => l.mode === 'walk' && l.departure && l.arrival)
      .reduce((total, l) => total + Math.max(0, (Date.parse(l.arrival) - Date.parse(l.departure)) / 60000), 0)
  };
}

export function selectJourney(payload, mode, notBefore, service = {}) {
  if (!MODES.includes(mode)) throw new Error('Invalid mode.');
  const raw = Array.isArray(payload?.journeys) ? payload.journeys : [];
  const viable = raw.map(j => normaliseJourney(j, mode)).filter(Boolean)
    .filter(j => {
      if (!service.line) return true;
      const publicLegs = j.legs.filter(l => l.mode !== 'walk');
      return publicLegs.length === 1 && publicLegs[0].line.trim().toUpperCase() === service.line.trim().toUpperCase();
    })
    .filter(j => Date.parse(j.departure) >= notBefore.getTime() - (service.departureAfter || service.line ? 0 : 90_000))
    .sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival) || Date.parse(a.departure) - Date.parse(b.departure));
  return viable[0] || null;
}

const MIN_REQUEST_GAP_MS = 275;
let tail = Promise.resolve();
let lastStarted = 0;
export function throttledRequest(task) {
  const run = tail.then(async () => {
    const gap = Math.max(0, MIN_REQUEST_GAP_MS - (Date.now() - lastStarted));
    if (gap) await new Promise(resolve => setTimeout(resolve, gap));
    lastStarted = Date.now();
    return task();
  });
  tail = run.catch(() => {});
  return run;
}

export async function tfnswGet(url, key, fetchImpl = fetch) {
  return throttledRequest(async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `apikey ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new Error(`Could not reach TfNSW (${error.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
    if (!response.ok) {
      let message;
      if (response.status === 401) message = 'API key rejected or quota exceeded. Check your TfNSW key.';
      else if (response.status === 403) message = 'TfNSW rate or daily quota limit reached, or access denied.';
      else message = `TfNSW returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    try { return await response.json(); }
    catch { throw new Error('TfNSW did not return valid JSON.'); }
  });
}

export async function findStops(query, key, fetchImpl = fetch) {
  const response = await tfnswGet(stopFinderUrl(query), key, fetchImpl);
  return normaliseStops(response);
}

export async function getBestJourney(from, to, mode, when, key, fetchImpl = fetch, service = {}) {
  const response = await tfnswGet(tripUrl(from, to, mode, when), key, fetchImpl);
  return selectJourney(response, mode, when, service);
}
