import { MODES, getBestJourney } from './tfnsw.js';

function validStop(stop) {
  return stop && typeof stop.id === 'string' && /^[\w.:-]{1,45}$/.test(stop.id) &&
    typeof stop.name === 'string' && stop.name.trim().length > 0 && stop.name.length <= 160;
}

export function validateRoute(route) {
  if (!route || typeof route !== 'object') throw new Error('Missing route.');
  if (typeof route.id !== 'string' || !/^[\w-]{1,80}$/.test(route.id)) throw new Error('Invalid route ID.');
  if (typeof route.label !== 'string' || route.label.trim().length < 1 || route.label.length > 90) throw new Error('Invalid route label.');
  if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 5 || route.points.some(p => !validStop(p))) {
    throw new Error('Choose 2-5 valid TfNSW stops for each route.');
  }
  if (!Array.isArray(route.modes) || route.modes.length !== route.points.length - 1 || route.modes.some(m => !MODES.includes(m))) {
    throw new Error('Choose a transport mode for every segment.');
  }
  if (route.points.some((point, i) => i > 0 && point.id === route.points[i - 1].id)) throw new Error('Consecutive stops must be different.');
  if (route.services !== undefined && (!Array.isArray(route.services) || route.services.length !== route.modes.length)) throw new Error('Choose service settings for every segment.');
  const services = route.modes.map((mode, i) => {
    const service = route.services?.[i] ?? {};
    if (!service || typeof service !== 'object' || Array.isArray(service)) throw new Error('Invalid service settings.');
    const line = service.line ?? '';
    if (typeof line !== 'string' || line.length > 40 || /[<>\r\n]/.test(line)) throw new Error('Invalid service line.');
    if (line.trim() && mode === 'any') throw new Error('Choose a transport mode for a specific line.');
    const departureAfter = service.departureAfter || '';
    if (typeof departureAfter !== 'string' || (departureAfter && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(departureAfter) || !Number.isFinite(Date.parse(departureAfter))))) throw new Error('Invalid service departure time.');
    return {line:line.trim(), departureAfter};
  });
  const buffer = Number(route.transferMinutes ?? 5);
  if (!Number.isFinite(buffer) || buffer < 0 || buffer > 30) throw new Error('Transfer buffer must be between 0 and 30 minutes.');
  return { ...route, services, transferMinutes: buffer };
}

export async function planRoute(routeInput, apiKey, options = {}) {
  const route = validateRoute(routeInput);
  const now = options.now || new Date();
  const getJourney = options.getJourney || getBestJourney;
  let at = now;
  const stages = [];
  for (let i = 0; i < route.modes.length; i++) {
    const from = route.points[i], to = route.points[i + 1];
    const service = route.services[i];
    if (service.departureAfter) at = new Date(Math.max(at.getTime(), Date.parse(service.departureAfter)));
    let journey;
    try { journey = await getJourney(from, to, route.modes[i], at, apiKey, undefined, service); }
    catch (e) { throw new Error(`${from.name} to ${to.name}: ${e.message}`); }
    if (!journey) {
      throw new Error(`No ${service.line ? `${service.line} ` : ''}${route.modes[i].replace('_', ' ')} option returned for ${from.name} to ${to.name}. Try a later departure, more specific stops, or a different line or mode.`);
    }
    stages.push({ from, to, mode: route.modes[i], ...journey });
    at = new Date(Date.parse(journey.arrival) + route.transferMinutes * 60_000);
  }
  const departure = stages[0].departure;
  const arrival = stages.at(-1).arrival;
  const publicLegs = stages.flatMap(s => s.legs).filter(l => l.mode !== 'walk');
  const walkingMinutes = stages.reduce((sum, s) => sum + s.walkingMinutes, 0);
  const minutesFromNow = Math.max(0, Math.ceil((Date.parse(arrival) - now.getTime()) / 60000));
  const durationMinutes = Math.ceil((Date.parse(arrival) - Date.parse(departure)) / 60000);
  let progress = 'Not departed';
  let location = '';
  const currentPublicLeg = publicLegs.find(l => Date.parse(l.departure || arrival) <= now.getTime() && Date.parse(l.arrival || departure) >= now.getTime());
  if (currentPublicLeg) {
    progress = 'Service underway (estimated)';
    const pastStops = currentPublicLeg.stops.filter(s => s.arrival || s.departure)
      .filter(s => Date.parse(s.departure || s.arrival) <= now.getTime());
    location = pastStops.at(-1)?.name || `Departed ${currentPublicLeg.from}`;
  } else if (Date.parse(arrival) <= now.getTime()) {
    progress = 'Expected to have arrived';
    location = route.points.at(-1).name;
  } else if (Date.parse(departure) <= now.getTime()) {
    progress = 'Between connections (estimated)';
    const previous = publicLegs.filter(l => Date.parse(l.arrival || 0) < now.getTime()).at(-1);
    location = previous?.to || '';
  }
  return {
    id: route.id, label: route.label, points: route.points, modes: route.modes, services: route.services,
    departure, arrival, minutesFromNow, durationMinutes,
    delayMinutes: Math.round((Date.parse(publicLegs.at(-1)?.arrival || arrival) - Date.parse(publicLegs.at(-1)?.plannedArrival || publicLegs.at(-1)?.arrival || arrival)) / 60000),
    transfers: Math.max(0, publicLegs.length - 1),
    walkingMinutes: Math.round(walkingMinutes),
    realtime: stages.some(s => s.realtime),
    progress, location, stages, updatedAt: now.toISOString()
  };
}
