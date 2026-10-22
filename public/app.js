const API_INTERVAL_MS = 60_000;
const STORAGE_KEY = 'journey-watch:routes:v1';
const TRACKS_STORAGE_KEY = 'journey-watch:fixed:v2';
const AUTO_SYNC_KEY = 'journey-watch:gtfs-autosync:v3';
const SCHEDULE_FEED_NAMES = {buses:'Sydney buses',sydneytrains:'Sydney Trains',nswtrains:'NSW TrainLink / intercity',metro:'Sydney Metro',ferries:'Sydney Ferries',innerwest:'Inner West Light Rail (L1)',cbd:'CBD & South East Light Rail (L2/L3)',parramatta:'Parramatta Light Rail (L4)',newcastle:'Newcastle Light Rail'};
const MODE_LABEL = { any: 'Any transport', train: 'Train', metro: 'Metro', light_rail: 'Light rail', bus: 'Bus / coach', ferry: 'Ferry' };
const MODE_ICON = { any: '\u21c4', train: '\u25a4', metro: '\u25cf', light_rail: '\u25a6', bus: '\u25a3', ferry: '\u224b', walk: '\u2192' };
const $ = id => document.getElementById(id);
const safe = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const formatTime = v => v ? new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Sydney', hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(v)).replace(/\s/g, ' ').toLowerCase() : '--:--';
const relativeMinutes = (iso, base = Date.now()) => Math.max(0, Math.ceil((Date.parse(iso) - base) / 60000));
const plusMinutes = min => min > 0 ? `+${min} min late` : min < 0 ? `${Math.abs(min)} min early` : 'On schedule';
const makeId = () => `r-${Math.random().toString(36).slice(2, 11)}`;

function readRoutes() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(r => typeof r.id === 'string' && Array.isArray(r.points) && r.points.length >= 2 && Array.isArray(r.modes));
  } catch { return []; }
}

function readTracks() {
  try {
    const list = JSON.parse(localStorage.getItem(TRACKS_STORAGE_KEY) || '[]');
    if (!Array.isArray(list)) return new Map();
    const stillSaved = new Set(readRoutes().map(route => route.id));
    return new Map(list.filter(t => stillSaved.has(t.id) && t.baseline && Array.isArray(t.legs)).map(t => [t.id, t]));
  } catch { return new Map(); }
}
let routes = readRoutes();
let tracks = readTracks();
let trackedResults = new Map();
let serverKeyConfigured = false;
let disconnected = false;
const connected = () => !disconnected && Boolean(key || serverKeyConfigured);
let key = ''; // Intentionally never persisted to storage.
let routeResults = new Map();
let routeChanges = new Map();
let refreshInProgress = false;
let refreshVersion = 0;
let checkingConnection = false;
let lastRefreshAt = 0;
let nextRefreshAt = 0;
let lastSuccessfulAt = '';
let lastRefreshErrors = false;
let draft = null;
let editingId = null;
let stopLookups = new Map();
let statusBanner = '';
let bannerIsError = false;
let scheduleStatus = null;
let selectedScheduleFeeds = new Set();
let scheduleSelectionInitialised = false;
let autoSyncSchedules = false;
try { autoSyncSchedules = localStorage.getItem(AUTO_SYNC_KEY) === 'yes'; } catch { /* Storage is optional. */ }
let lastAutoSyncAttempt = 0;

function storeTracks() {
  try { localStorage.setItem(TRACKS_STORAGE_KEY, JSON.stringify([...tracks.values()])); }
  catch { showBanner('Browser storage is unavailable; locked journeys may not survive a reload.', true); }
}
function visibleResult(route) {
  if (!tracks.has(route.id)) return routeResults.get(route.id);
  const latest = trackedResults.get(route.id);
  if (latest?.ok) return latest;
  const track = tracks.get(route.id);
  return { ok: true, data: { ...track.baseline, fixed: {
    lockedAt: track.lockedAt, connectionRisk: false, comparable: !latest?.error, hasGps: false,
    errors: latest?.error ? [{message:latest.error}] : [],
    legs: track.legs.map(leg => ({...leg, match: 'unmatched', gps: null, estimatedArrival: leg.arrival,
      etaBasis: 'locked-plan', candidates:[], feedError:[]}))
  } } };
}
function freezePlan(route, result) {
  const data = result.data;
  const legs = data.stages.flatMap((stage, i) => stage.legs
    .filter(leg => leg.mode !== 'walk').map((leg, j) => ({
      id: `${i}-${j}`, stageIndex:i, mode: leg.mode, line: leg.line, from: leg.from, to: leg.to,
      fromStopId: leg.stops?.[0]?.id || '', toStopId: leg.stops?.at(-1)?.id || '',
      stops: leg.stops?.map(x => ({id:x.id, name:x.name})) || [],
      departure: leg.departure, arrival: leg.arrival,
      plannedDeparture: leg.plannedDeparture, plannedArrival: leg.plannedArrival,
      tripIdCandidates: leg.tripIdCandidates || [], tripId: '', feedId: '', startDate: ''
    })));
  if (!legs.length || legs.length > 30) throw new Error('Cannot lock a journey without supported public transport legs.');
  return {
    id: route.id, label: route.label, lockedAt: new Date().toISOString(),
    transferMinutes: route.transferMinutes ?? 5,
    baseline: data, legs
  };
}
function storeRoutes() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(routes)); }
  catch { showBanner('Browser storage is unavailable. Routes will not persist after this tab closes.', true); }
}
function showBanner(message, error = false) { statusBanner = message; bannerIsError = error; renderBanner(); }
function clearBanner() { statusBanner = ''; renderBanner(); }
function renderBanner() {
  const el = $('banner'); el.hidden = !statusBanner;
  el.textContent = statusBanner;
  el.classList.toggle('error', bannerIsError);
}
function updateClock() {
  $('clock').textContent = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Sydney', hour:'2-digit', minute:'2-digit', hour12:false}).format(new Date());
  const seconds = connected() && routes.length ? Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)) : null;
  $('countdown').innerHTML = seconds === null ? '--<span>s</span>' : `${String(seconds).padStart(2,'0')}<span>s</span>`;
  if (!refreshInProgress && connected() && routes.length && nextRefreshAt && Date.now() >= nextRefreshAt && document.visibilityState === 'visible') refreshRoutes();
}
function setConnectionUI() {
  $('monitorState').textContent = !connected() ? 'NOT CONNECTED' : lastRefreshErrors ? 'UPDATE ISSUES' : lastSuccessfulAt ? routes.some(route=>visibleResult(route)?.data?.realtime) ? 'LIVE DATA' : 'RESULTS READY' : serverKeyConfigured && !key ? 'SERVER KEY READY' : 'KEY ENTERED';
  document.querySelector('.pulsing-indicator').classList.toggle('connected', connected());
  $('refreshCaption').textContent = !connected() ? 'Connect your API key to begin' : !routes.length ? 'Add routes to begin monitoring' : refreshInProgress ? 'Checking TfNSW services...' : 'Automatic updates while this tab is open';
  $('dataStatus').textContent = !connected() ? 'No API key' : refreshInProgress ? 'Fetching live data...' : lastRefreshErrors ? 'Some updates unavailable' : lastSuccessfulAt ? `Last checked ${formatTime(lastSuccessfulAt)}` : 'Ready to connect';
  $('refreshNow').disabled = !connected() || !routes.length || refreshInProgress;
  $('lockAll').disabled = !connected() || refreshInProgress || !routes.some(r => !tracks.has(r.id) && routeResults.get(r.id)?.ok);
  $('lockAll').textContent = `Lock shown journeys${tracks.size ? ` (${tracks.size} locked)` : ''}`;
}
function groupRoutes() {
  const groups = new Map();
  for (const route of routes) {
    const first = route.points[0], last = route.points.at(-1);
    if (!first || !last) continue;
    const id = `${first.id}|${last.id}`;
    if (!groups.has(id)) groups.set(id, { origin:first, destination:last, routes:[] });
    groups.get(id).routes.push(route);
  }
  return [...groups.values()];
}

function renderOverview(groups) {
  const live = routes.map(visibleResult).filter(r => r?.ok);
  $('routeCount').textContent = String(routes.length).padStart(2, '0');
  $('liveCount').textContent = String(live.length).padStart(2, '0');
  const arrivals = live.map(r => r.data).filter(d => d?.arrival && d.fixed?.comparable !== false && Date.parse(d.arrival) > Date.now()).sort((a,b) => Date.parse(a.arrival)-Date.parse(b.arrival));
  $('bestArrival').textContent = arrivals.length && groups.length === 1 ? formatTime(arrivals[0].arrival) : '--:--';
  $('bestArrivalCaption').textContent = groups.length > 1 ? 'See fastest option in each group' : arrivals.length ? `${relativeMinutes(arrivals[0].arrival)} min from now` : 'Waiting for comparison';
  $('lastUpdated').textContent = lastSuccessfulAt ? formatTime(lastSuccessfulAt) : '--:--';
  $('updatedCaption').textContent = lastSuccessfulAt ? 'API response received' : 'No live data yet';
  $('groupCount').textContent = groups.length;
}

function modePills(data, savedRoute) {
  const unique = data ? data.stages.flatMap(s => s.legs).filter(l => l.mode !== 'walk').map(l => ({mode:l.mode,label:l.line})).slice(0, 7)
    : savedRoute.modes.map(mode => ({mode,label:MODE_LABEL[mode]}));
  return unique.map((part,i) => `${i ? '<span class="leg-arrow">&rarr;</span>' : ''}<span class="mode-pill">${safe(MODE_ICON[part.mode] || '')} ${safe(part.label)}</span>`).join('');
}
function stopTimeline(leg, currentMs) {
  const list = leg.stops || [];
  if (!list.length) return '<p class="pending-line">No stop sequence available.</p>';
  return `<div class="timeline">${list.map(stop => {
    const when = stop.departure || stop.arrival;
    const hasPassed = when && Date.parse(when) <= currentMs;
    return `<div class="timeline-segment ${hasPassed?'passed':''}"><h4>${safe(stop.name)}</h4><div class="caption">${formatTime(when)} ${stop.realtime ? '&middot; live estimate' : '&middot; timetable'} ${hasPassed ? '&middot; time has passed' : ''}</div></div>`;
  }).join('')}</div>`;
}
function stagesHtml(data) {
  return `<details class="stops-details" data-persist="original-${safe(data.id)}"><summary>${data.fixed ? 'Original locked stop estimates' : 'View journey legs &amp; stop estimates'}</summary>${data.stages.map((stage,i)=>{
    const body = stage.legs.map(leg => {
      if (leg.mode === 'walk') return `<div class="projection"><div class="projection-copy"><strong>Walk / interchange</strong><span>${safe(leg.from)} to ${safe(leg.to)} &middot; ${formatTime(leg.departure)}&ndash;${formatTime(leg.arrival)}</span></div></div>`;
      return `<div class="stage-title">${safe(MODE_LABEL[leg.mode] || leg.mode)} &middot; ${safe(leg.line)}</div><div class="group-sub">${safe(leg.from)} &rarr; ${safe(leg.to)} &middot; ${formatTime(leg.departure)}&ndash;${formatTime(leg.arrival)}</div>${stopTimeline(leg, Date.now())}`;
    }).join('');
    return `<div class="stage-title">Segment ${i+1}: ${safe(stage.from.name)} &rarr; ${safe(stage.to.name)}</div>${body}`;
  }).join('')}</details>`;
}

function trackingHtml(route, data) {
  const fixed = data.fixed;
  if (!fixed) return '';
  const track = tracks.get(route.id);
  const feedErrors = fixed.errors || [];
  return `<div class="tracking-panel">
    <div class="tracking-heading"><span class="tracking-dot"></span><strong>FIXED JOURNEY TRACKING</strong><span>Locked ${formatTime(fixed.lockedAt)}</span></div>
    <p class="tracking-intro">Original services remain fixed. GPS appears only after an exact GTFS trip ID match; a missing fix is not proof a service has stopped.</p>
    ${fixed.connectionRisk ? '<div class="connection-risk">Connection at risk: the preceding service may arrive too late for the next service’s updated departure. Arrival comparison excluded.</div>' : ''}
    ${fixed.legs.some(leg => leg.cancelled) ? '<div class="connection-risk">A fixed service is marked cancelled. This alternative is excluded from the fastest-route comparison.</div>' : ''}
    <details class="tracking-details" data-persist="track-${safe(route.id)}"><summary>Vehicle tracking, named stops &amp; service IDs (${fixed.legs.length} legs)</summary>
    ${fixed.legs.map((leg, i) => {
      const status = leg.gps ? 'LIVE GPS' : leg.match === 'matched' ? 'MATCHED · NO FRESH GPS' :
        leg.match === 'timetable-linked' ? 'SCHEDULE LINKED' :
        leg.match === 'static-ambiguous' ? 'AMBIGUOUS TIMETABLE' :
        leg.match === 'ambiguous' ? 'AMBIGUOUS ID' : leg.match === 'feed-error' ? 'FEED ERROR' :
        leg.match === 'not-observed' ? 'NOT OBSERVED' : 'UNLINKED';
      const gps = leg.gps;
      const mapUrl = gps ? `https://www.openstreetmap.org/?mlat=${gps.latitude.toFixed(6)}&mlon=${gps.longitude.toFixed(6)}#map=15/${gps.latitude.toFixed(6)}/${gps.longitude.toFixed(6)}` : '';
      const candidates = leg.candidates || [];
      const original = track?.legs.find(t => t.id === leg.id);
      const selected = Boolean(original?.tripId);
      const badge = gps ? 'gps' : ['matched','timetable-linked'].includes(leg.match) ? 'linked' : 'unlinked';
      const basis = leg.etaBasis === 'gtfs-stop' ? 'Live GTFS stop ETA' : leg.etaBasis === 'gtfs-stop-delay' ? 'GTFS stop delay + planned time' :
        leg.etaBasis === 'gtfs-propagated-delay' ? 'Delay from a preceding stop + timetable' : leg.etaBasis === 'gtfs-trip-delay-static' ? 'GTFS trip delay + static timetable' : leg.etaBasis === 'gtfs-trip-delay' ? 'Trip-wide delay approximation' : 'ETA frozen at lock time';
      const staticStops = leg.staticPath?.stops || [];
      const next = leg.locationLabel ? `<div class="stop-callout"><strong>${leg.stopProgressBasis === 'gps-feed' ? 'GPS-reported service progress' : 'Timetable-based progress (not GPS)'}</strong><span>${safe(leg.locationLabel || 'No stop estimate')}</span></div>` : '';
      const seq = staticStops.length ? `<details class="named-stops" data-persist="stops-${safe(route.id)}-${safe(leg.id)}"><summary>Named stop sequence · ${staticStops.length} stops · ${leg.stopProgressBasis === 'gps-feed' ? 'GPS progress' : 'scheduled times'}</summary><ol class="named-stop-list">${staticStops.map((stop,k)=>`<li class="named-stop ${k < leg.completedStops ? 'passed' : ''} ${k === leg.completedStops ? 'current' : ''}"><span class="stop-index">${k+1}</span><span class="stop-copy"><strong>${safe(stop.name)}</strong><small>${safe(stop.stopId)}</small></span><time>${formatTime(stop.scheduledArrival)}</time></li>`).join('')}</ol></details>` : '';

      return `<div class="track-leg" data-leg="${safe(leg.id)}">
        <div class="track-leg-head"><strong>${safe(MODE_LABEL[leg.mode] || leg.mode)} · ${safe(leg.line)}</strong><span class="track-status ${badge}">${safe(status)}</span></div>
        <p>${safe(leg.from)} → ${safe(leg.to)} · ${formatTime(leg.estimatedDeparture || leg.departure)}–${formatTime(leg.estimatedArrival)}</p>
        ${leg.departureBasis && leg.departureBasis!=='locked-plan' ? `<div class="track-timing">Updated departure ${formatTime(leg.estimatedDeparture)} · original selection ${formatTime(leg.departure)}</div>` : ''}
        <div class="track-timing">${safe(basis)}${leg.cancelled ? ' · Service flagged cancelled' : ''}${leg.skippedStop ? ' · Destination stop skipped' : ''}${leg.skippedBoarding ? ' · Boarding stop skipped' : ''}</div>
        ${next}
        ${gps ? `<div class="gps-location"><span>GPS observed ${gps.ageSeconds}s ago · ${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}</span><a target="_blank" rel="noopener noreferrer" href="${mapUrl}">Open map ↗</a></div>` : '<div class="gps-none">No fresh GPS fix for this exact service.</div>'}
        ${seq}
        ${leg.tripId ? `<div class="trip-code">GTFS trip: <code>${safe(leg.tripId)}</code> · ${safe(leg.feedId || '')}${leg.startDate ? ` · ${safe(leg.startDate)}` : ''}${original?.bindingSource === 'static-auto' || leg.binding?.source === 'static-auto' ? ' · Matched via static timetable' : ''}</div>` : ''}
        ${leg.staticMissing?.length && !staticStops.length ? `<p class="static-missing">Static timetable not synced/fresh: ${safe(leg.staticMissing.join(', '))}. Manage timetables in API settings.</p>` : ''}
        ${leg.feedError?.length ? `<p class="track-error">${leg.feedError.map(safe).join(' · ')}</p>` : ''}
        ${!selected && candidates.length ? `<label class="binding-label">Possible service matches — verify before choosing</label><select data-action="select-candidate" data-id="${safe(route.id)}" data-leg="${safe(leg.id)}"><option value="">Choose a GTFS trip (unverified suggestions)</option>${candidates.map((c,j) => `<option value="${j}">${safe(c.routeId)} · ${safe(c.tripId)} · within ${c.minutesFromBoarding} min · ${safe(c.feedId)}</option>`).join('')}</select>` : ''}
        <div class="manual-bind"><input class="manual-trip-id" maxlength="160" placeholder="Exact GTFS trip_id" aria-label="GTFS trip ID for ${safe(leg.line)}" value="${selected ? safe(original.tripId) : ''}"><button type="button" data-action="manual-bind" data-id="${safe(route.id)}" data-leg="${safe(leg.id)}">Bind ID</button>${selected ? `<button type="button" data-action="un-bind" data-id="${safe(route.id)}" data-leg="${safe(leg.id)}">Clear</button>` : ''}</div>
      </div>`;
    }).join('')}
    ${feedErrors.length ? `<p class="track-error">${feedErrors.map(error=>safe(error.message)).join("<br>")}</p>` : ''}
    </details>
  </div>`;
}

function renderRouteCard(route, result, fastestAt, optionCount) {
  const data = result?.ok ? result.data : null;
  const winner = data && data.fixed?.comparable !== false && optionCount > 1 && fastestAt && Date.parse(data.arrival) === fastestAt;
  const delta = routeChanges.get(route.id);
  let contents;
  if (!data) {
    const failure = result && !result.ok;
    contents = `<div class="pending-line">${!connected() ? 'Connect your TfNSW API key to see a live itinerary.' : failure ? 'A live route is not available at this time.' : 'Waiting for the first live update.'}</div><div class="leg-pills pending-pills">${modePills(null,route)}</div>${failure ? `<div class="route-error">${safe(result.error)}</div>` : '<div class="skeleton-bar"></div>'}`;
  } else {
    const delay = data.delayMinutes;
    const nowMinutes = relativeMinutes(data.arrival);
    const slower = fastestAt ? Math.max(0, Math.round((Date.parse(data.arrival)-fastestAt)/60000)) : 0;
    const difference = data.fixed?.comparable === false ? 'Connection or service unavailable — arrival not comparable' : winner ? 'Current earliest arrival among these routes' : optionCount > 1 && fastestAt ? `${slower} min behind the earliest option` : optionCount > 1 ? 'No comparable arrival estimate yet' : 'Your current predicted journey time';
    const location = data.location ? `${data.fixed ? '' : 'Last indicated stop: '}${safe(data.location)}` : data.fixed ? 'Exact vehicle position is not yet available' : 'No departure confirmed';
    contents = `
      ${winner ? '<div class="fastest-label">Earliest arrival</div>' : ''}
      <div class="card-metric"><strong>${nowMinutes}</strong><span>MIN FROM NOW</span></div>
      <div class="card-sentence">${safe(difference)}</div>
      <div class="times"><div><span class="label">${data.fixed ? 'Locked departure' : 'Next departure'}</span><strong>${formatTime(data.departure)}</strong></div><div><span class="label">Est. arrival</span><strong>${formatTime(data.arrival)}</strong>${delay ? `<span class="${delay>0?'late':'early'}">${safe(plusMinutes(delay))}</span>` : ''}</div></div>
      <div class="leg-pills">${modePills(data,route)}</div>
      <div class="projection"><div class="projection-copy"><strong>${safe(data.progress)}</strong><span>${location}</span></div><div class="source">${data.fixed ? data.fixed.hasGps ? 'LIVE GPS' : data.realtime ? 'GTFS UPDATES' : 'LOCKED PLAN' : data.realtime ? 'REAL-TIME DATA' : 'TIMETABLE'}</div></div>
      <div class="card-foot"><span><strong>${data.transfers}</strong> transfers &middot; <strong>${data.walkingMinutes}</strong> min walking</span><span class="${delta>0?'delta':delta<0?'better':''}">${typeof delta === 'number' && delta !== 0 ? `ETA ${delta>0?'+':''}${delta} min vs last refresh` : `Journey ${data.durationMinutes} min`}</span></div>
      ${data.fixed ? trackingHtml(route,data) : ''}
      ${stagesHtml(data)}`;
  }
  return `<article class="route-card ${winner?'winner':''}"><div class="card-top"><div><div class="route-tag">${data?.fixed ? 'FIXED SERVICE · NO REPLANNING' : 'Saved alternative · live re-planning'}</div><h3 class="card-title">${safe(route.label)}</h3></div><div class="card-controls"><button type="button" data-action="edit" data-id="${safe(route.id)}" title="Edit route" aria-label="Edit ${safe(route.label)}">Edit</button><button type="button" data-action="delete" data-id="${safe(route.id)}" title="Delete route" aria-label="Delete ${safe(route.label)}">&times;</button></div></div>${contents}<div class="lock-controls">${tracks.has(route.id) ? `<button class="button button-outline" type="button" data-action="unlock" data-id="${safe(route.id)}">Unlock &amp; re-plan</button>` : `<button class="button button-outline" type="button" data-action="lock" data-id="${safe(route.id)}" ${data && connected() ? '' : 'disabled'}>Lock this journey</button>`}</div></article>`;
}
function render() {
  const groups = groupRoutes();
  renderBanner(); setConnectionUI(); renderOverview(groups); renderScheduleBand();
  $('emptyState').hidden = routes.length !== 0;
  const openDetails = new Set([...$('comparisonGroups').querySelectorAll('details[data-persist][open]')].map(x=>x.dataset.persist));
  $('comparisonGroups').innerHTML = groups.map((group) => {
    const valid = group.routes.map(visibleResult).filter(r => r?.ok && r.data.fixed?.comparable !== false && Date.parse(r.data.arrival) > Date.now());
    const earliestArrival = valid.length ? Math.min(...valid.map(r => Date.parse(r.data.arrival))) : null;
    return `<section class="comparison-group"><div class="group-header"><div><div class="group-title">${safe(group.origin.name)} <span>&rarr;</span> ${safe(group.destination.name)}</div><div class="group-sub">${group.routes.length} alternative${group.routes.length!==1?'s':''} ${valid.length ? `&middot; ${valid.length} live result${valid.length>1?'s':''}` : '&middot; awaiting live results'} &middot; ${group.routes.filter(r=>tracks.has(r.id)).length} fixed, ${group.routes.filter(r=>!tracks.has(r.id)).length} re-planning</div></div>${valid.length && group.routes.length>1?`<div class="group-key">EARLIEST ETA ${formatTime(new Date(earliestArrival).toISOString())}</div>`:''}</div><div class="route-grid">${group.routes.map(route => renderRouteCard(route, visibleResult(route), earliestArrival, group.routes.length)).join('')}</div></section>`;
  }).join('');
  $('comparisonGroups').querySelectorAll('details[data-persist]').forEach(x=>{if(openDetails.has(x.dataset.persist))x.open=true;});
}

async function fetchApi(path, opts = {}) {
  if (!connected()) throw new Error('Connect your TfNSW API key first.');
  const result = await fetch(path, {
    ...opts, headers: { ...(key ? {'X-TfNSW-Key': key} : {}), ...(opts.body ? {'Content-Type':'application/json'} : {}) },
    cache: 'no-store'
  });
  let payload;
  try { payload = await result.json(); } catch { throw new Error('The local app did not return valid JSON.'); }
  if (!result.ok) throw new Error(payload?.error || `Request failed with HTTP ${result.status}.`);
  return payload;
}
async function refreshRoutes() {
  if (!connected() || !routes.length || refreshInProgress) return;
  const version = refreshVersion;
  refreshInProgress = true; lastRefreshAt = Date.now(); nextRefreshAt = lastRefreshAt + API_INTERVAL_MS;
  render();
  const previous = new Map(routes.map(r => [r.id, visibleResult(r)]));
  const toPlan = routes.filter(r => !tracks.has(r.id));
  const toTrack = routes.map(r => tracks.get(r.id)).filter(Boolean);
  let successes = 0; const errors = [];
  // A failure in the EFA planner must not prevent updating locked GTFS services, or vice versa.
  const results = await Promise.allSettled([
    toPlan.length ? fetchApi('/api/compare', {method:'POST',body:JSON.stringify({routes:toPlan})}) : Promise.resolve(null),
    toTrack.length ? fetchApi('/api/track', {method:'POST',body:JSON.stringify({tracks:toTrack})}) : Promise.resolve(null)
  ]);
  if (version !== refreshVersion) {
    refreshInProgress = false; render();
    if (connected()) void refreshRoutes();
    return;
  }
  if (results[0].status === 'fulfilled' && results[0].value) {
    const payload = results[0].value;
    routeResults = new Map((payload.results || []).map(item => [item.ok ? item.data.id : item.id,item]));
    if ([...routeResults.values()].some(r => r.ok)) successes++;
    const failed = [...routeResults.values()].filter(r => !r.ok);
    if (failed.length) errors.push(`${failed.length} re-planned route(s) unavailable`);
  } else if (results[0].status === 'rejected') {
    errors.push(`Trip Planner: ${results[0].reason.message}`);
    for (const route of toPlan) routeResults.set(route.id, {ok:false,id:route.id,error:results[0].reason.message});
  }
  if (results[1].status === 'fulfilled' && results[1].value) {
    const payload = results[1].value;
    trackedResults = new Map((payload.results || []).map(item => [item.data.id,item]));
    let changed = false;
    for (const item of payload.results || []) {
      const track = tracks.get(item.data.id);
      if (!track) continue;
      for (const leg of item.data.fixed?.legs || []) {
        const original = track.legs.find(l=>l.id === leg.id);
        if (original && !original.tripId && (leg.binding?.source === 'static-auto' || leg.match === 'matched')) {
          original.tripId = leg.tripId;
          original.feedId = leg.feedId;
          original.startDate = leg.startDate || '';
          original.bindingSource = leg.binding?.source || 'realtime-exact';
          changed = true;
        }
      }
    }
    if (changed) storeTracks();
    if (payload.feedStatus?.errors?.length) errors.push(`${payload.feedStatus.errors.length} GTFS feed(s) unavailable; see tracking details`);
    successes++;
  } else if (results[1].status === 'rejected') {
    errors.push(`Fixed tracking: ${results[1].reason.message}`);
    for (const track of toTrack) trackedResults.set(track.id, {ok:false,error:results[1].reason.message});
  }
  const changes = new Map();
  for (const route of routes) {
    const next = visibleResult(route), prev = previous.get(route.id);
    if (next?.ok && prev?.ok) changes.set(route.id, Math.round((Date.parse(next.data.arrival)-Date.parse(prev.data.arrival))/60_000));
  }
  routeChanges = changes;
  if (successes) lastSuccessfulAt = new Date().toISOString();
  lastRefreshErrors=errors.length>0;
  if (errors.length) showBanner(errors.join('. '),true);
  else if (successes) clearBanner();
  refreshInProgress = false; nextRefreshAt = Date.now() + API_INTERVAL_MS; render(); updateClock();
}

function lockRoute(id, quiet = false) {
  const route = routes.find(r => r.id === id);
  const result = routeResults.get(id);
  if (!route || !result?.ok || tracks.has(id)) return false;
  try { refreshVersion++; tracks.set(id, freezePlan(route,result)); storeTracks(); }
  catch(e) { showBanner(`Cannot lock ${route.label}: ${e.message}`,true); return false; }
  if (!quiet) { showBanner(`${route.label} frozen to its currently selected services. Searching for exact GTFS-Realtime IDs.`); render(); refreshRoutes(); }
  return true;
}
function unlockRoute(id) {
  if (!tracks.has(id)) return;
  refreshVersion++;
  tracks.delete(id); trackedResults.delete(id); routeResults.delete(id);
  storeTracks(); render(); showBanner('Journey unlocked. The next refresh will choose newly available services.'); refreshRoutes();
}
function bindTripId(routeId, legId, tripId, feedId = '', startDate = '') {
  const track = tracks.get(routeId);
  const leg = track?.legs.find(l => l.id === legId);
  if (!leg) return;
  if (tripId && (tripId.length > 160 || /[\x00-\x1f\x7f]/.test(tripId))) { showBanner('Enter a valid GTFS trip ID (maximum 160 characters).',true); return; }
  refreshVersion++;
  leg.tripId = tripId;
  leg.feedId = feedId;
  leg.startDate = startDate;
  storeTracks();
  trackedResults.delete(routeId);
  render();
  showBanner(tripId ? 'Trip ID selected. Checking GTFS feeds for that exact service.' : 'Trip ID cleared; exact auto-matching is enabled again.');
  refreshRoutes();
}

let stopPickerId = 0;
function stopPicker(label, getLocation, setLocation, canRemove, onRemove) {
  const outer = document.createElement('div'); outer.className = 'stop-field';
  const name = document.createElement('label'); name.textContent = label;
  const input = document.createElement('input'); input.type='text'; input.placeholder='Search station, stop or wharf'; input.autocomplete='off'; input.value = getLocation()?.name || '';
  input.setAttribute('aria-label',label);
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-expanded','false');
  const note = document.createElement('div'); note.className='selected-hint';
  const drop = document.createElement('div'); drop.className='autocomplete'; drop.hidden=true;
  drop.id=`stop-options-${++stopPickerId}`; drop.setAttribute('role','listbox');
  input.setAttribute('aria-controls',drop.id);
  const redrawNote = () => { note.textContent = getLocation() ? `Selected TfNSW stop ID: ${getLocation().id}` : 'Choose a stop from the search results'; note.classList.toggle('has-selection',Boolean(getLocation())); };
  redrawNote();
  outer.append(name,input,note,drop);
  if (canRemove) {
    const button = document.createElement('button'); button.type='button'; button.className='stop-remove'; button.textContent='Remove interchange'; button.addEventListener('click',onRemove); outer.appendChild(button);
  }
  let debounce, sequence=0, active=-1, options=[];
  function closeOptions() {
    sequence++; clearTimeout(debounce);
    drop.hidden=true; active=-1;
    input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant');
  }
  function selectChoice(choice) {
    setLocation(choice); input.value=choice.name; closeOptions(); redrawNote();
  }
  function activate(index) {
    active=index;
    [...drop.children].forEach((option,i)=>{
      option.classList.toggle('active',i===index);
      option.setAttribute('aria-selected',String(i===index));
    });
    const option=drop.children[index];
    if (option) { input.setAttribute('aria-activedescendant',option.id); option.scrollIntoView({block:'nearest'}); }
  }
  function showOptions(choices, message = '') {
    options=choices; active=-1;
    drop.replaceChildren(); drop.hidden=false; input.setAttribute('aria-expanded','true');
    input.removeAttribute('aria-activedescendant');
    if (message) { const el = document.createElement('div'); el.className='lookup-message'; el.setAttribute('role','status'); el.textContent=message; drop.append(el); return; }
    if (!choices.length) { showOptions([], 'No stops matched. Try a more specific name.'); return; }
    for (const [i,choice] of choices.entries()) {
      const btn = document.createElement('button'); btn.type='button';
      btn.id=`${drop.id}-${i}`; btn.tabIndex=-1; btn.setAttribute('role','option'); btn.setAttribute('aria-selected','false');
      btn.addEventListener('mousedown',event=>event.preventDefault());
      const title=document.createElement('span'); title.textContent=choice.name;
      const sub=document.createElement('small'); sub.textContent=`Stop ${choice.id}`;
      btn.append(title,sub);
      btn.addEventListener('click', () => selectChoice(choice));
      drop.append(btn);
    }
  }
  input.addEventListener('input', () => {
    setLocation(null); redrawNote(); clearTimeout(debounce);
    const query=input.value.trim(); const thisSequence=++sequence;
    if (query.length < 2) { closeOptions(); return; }
    if (!connected()) { showOptions([], 'Add your API key first to search NSW stops.'); return; }
    showOptions([], 'Searching TfNSW stops...');
    debounce=setTimeout(async () => {
      try {
        const cacheEntry=stopLookups.get(query.toLowerCase());
        const stops=cacheEntry && Date.now()-cacheEntry.at<150000 ? cacheEntry.stops : (await fetchApi(`/api/stops?q=${encodeURIComponent(query)}`)).stops;
        if (!cacheEntry || Date.now()-cacheEntry.at>=150000) stopLookups.set(query.toLowerCase(), {stops,at:Date.now()});
        if (sequence!==thisSequence || !outer.isConnected || input.value.trim()!==query) return;
        showOptions(stops);
      } catch (e) { if (sequence===thisSequence && outer.isConnected) showOptions([], e.message); }
    },300);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !drop.hidden) { event.preventDefault(); event.stopPropagation(); closeOptions(); return; }
    if (drop.hidden || !options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activate(event.key === 'ArrowDown' ? (active+1)%options.length : active<=0 ? options.length-1 : active-1);
    } else if (event.key === 'Enter' && active>=0) {
      event.preventDefault(); selectChoice(options[active]);
    }
  });
  input.addEventListener('blur', closeOptions);
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && !getLocation()) input.dispatchEvent(new Event('input')); });
  return outer;
}

function renderRouteBuilder() {
  const container = $('routeBuilder'); container.replaceChildren();
  const locations = [draft.origin, ...draft.vias, draft.destination];
  for (let i=0;i<locations.length;i++) {
    const index=i;
    let caption = i===0 ? 'ORIGIN' : i===locations.length-1 ? 'DESTINATION' : `INTERCHANGE ${i}`;
    const getter = () => i===0 ? draft.origin : i===locations.length-1 ? draft.destination : draft.vias[i-1];
    const setter = loc => { if (index===0) draft.origin=loc; else if (index===locations.length-1) draft.destination=loc; else draft.vias[index-1]=loc; };
    const remove = () => { draft.vias.splice(index-1,1); draft.modes.splice(index,1); renderRouteBuilder(); };
    container.append(stopPicker(caption, getter, setter, index>0 && index<locations.length-1, remove));
    if (i < locations.length-1) {
      const part=document.createElement('div');part.className='mode-between';
      const span=document.createElement('span'); span.textContent='Travel by';
      const select=document.createElement('select'); select.setAttribute('aria-label', `Transport mode for leg ${i+1}`);
      for (const [value,text] of Object.entries(MODE_LABEL)) { const op=document.createElement('option');op.value=value;op.textContent=text;op.selected=draft.modes[i]===value;select.append(op); }
      select.addEventListener('change', () => {draft.modes[index]=select.value;});
      part.append(span,select);container.append(part);
    }
  }
  $('addInterchange').disabled = draft.vias.length >= 3;
}

function openRouteEditor(id = null) {
  if (!connected() && !id) { openSettings('Connect an API key to search for stops before adding a route.'); return; }
  const route = routes.find(r => r.id === id);
  editingId = route?.id || null;
  draft = route ? {
    origin:{...route.points[0]}, destination:{...route.points.at(-1)},
    vias:route.points.slice(1,-1).map(p=>({...p})), modes:[...route.modes],
    transferMinutes:route.transferMinutes ?? 5, label:route.label
  } : { origin:null, destination:null, vias:[], modes:['any'], transferMinutes:5,label:'' };
  $('routeDialogTitle').textContent=route ? 'Edit alternative' : 'Add an alternative';
  $('routeLabel').value=draft.label;
  $('transferMinutes').value=draft.transferMinutes;
  $('routeError').textContent='';
  renderRouteBuilder();$('routeDialog').showModal();
}
function saveRoute(event) {
  event.preventDefault();
  const label=$('routeLabel').value.trim();
  const points=[draft.origin,...draft.vias,draft.destination];
  const transferMinutes=Number($('transferMinutes').value);
  if (!label || points.some(p => !p?.id)) { $('routeError').textContent='Enter a route name and select each stop from the TfNSW suggestions.'; return; }
  if (points.some((p,i) => i>0 && p.id===points[i-1].id)) { $('routeError').textContent='Consecutive stops must be different.'; return; }
  if (!Number.isFinite(transferMinutes) || transferMinutes<0 || transferMinutes>30) { $('routeError').textContent='Transfer buffer must be between 0 and 30 minutes.'; return; }
  if (!editingId && routes.length >= 12) { $('routeError').textContent='This version supports a maximum of 12 saved routes to manage API usage.'; return; }
  const entry={id:editingId || makeId(),label,points,modes:draft.modes,transferMinutes};
  refreshVersion++;
  if (editingId) routes=routes.map(r=>r.id===editingId?entry:r);
  else routes=[...routes,entry];
  if (tracks.has(entry.id)) { tracks.delete(entry.id); trackedResults.delete(entry.id); storeTracks(); }
  storeRoutes();routeResults.delete(entry.id); routeChanges.delete(entry.id);
  $('routeDialog').close();showBanner('Saved route. Checking the latest departures now.');render();refreshRoutes();
}
function relevantScheduleFeeds() {
  const needed = new Set();
  const legs = [...tracks.values()].flatMap(t=>t.legs);
  if(legs.length){
    for(const leg of legs){
      if(leg.feedId && SCHEDULE_FEED_NAMES[leg.feedId]){needed.add(leg.feedId);continue;}
      addMode(leg.mode,leg.line);
    }
  } else for(const route of routes) for(const mode of route.modes) addMode(mode,'');
  function addMode(mode,line){
    if(mode==='train'){needed.add('sydneytrains');needed.add('nswtrains');}
    else if(mode==='bus')needed.add('buses');
    else if(mode==='metro')needed.add('metro');
    else if(mode==='ferry')needed.add('ferries');
    else if(mode==='light_rail'){
      if(/\bL1\b/i.test(line))needed.add('innerwest');
      else if(/\bL[23]\b/i.test(line))needed.add('cbd');
      else if(/\bL4\b/i.test(line))needed.add('parramatta');
      else {needed.add('innerwest');needed.add('cbd');needed.add('parramatta');needed.add('newcastle');}
    } else if(mode==='any') {needed.add('buses');needed.add('sydneytrains');needed.add('metro');needed.add('ferries');}
  }
  return [...needed];
}
function renderScheduleSettings() {
  const feeds=scheduleStatus?.feeds || {};
  $('timetableFeedList').innerHTML = Object.entries(SCHEDULE_FEED_NAMES).map(([id,name])=>{
    const info=feeds[id]||{};
    const date=info.cachedAt?new Date(info.cachedAt).toLocaleDateString('en-AU',{day:'numeric',month:'short',timeZone:'Australia/Sydney'}):'';
    const state=info.job?.status==='error' ? `Error: ${info.job.error}` :
      ['queued','downloading','indexing'].includes(info.job?.status) ? info.job.status :
      info.cachedAt ? `${info.stale?'Stale':'Ready'} · ${date} · ${info.meta?.trips?.toLocaleString('en-AU')||'?'} trips`:'Not downloaded';
    return `<label class="schedule-option"><input type="checkbox" data-feed="${id}" ${selectedScheduleFeeds.has(id)?'checked':''}><span><strong>${safe(name)}</strong><small class="${info.job?.status==='error'?'sync-error':''}">${safe(state)}</small></span></label>`;
  }).join('');
  $('syncTimetables').disabled=!connected()||!selectedScheduleFeeds.size||scheduleStatus?.running;
  $('syncTimetables').textContent=scheduleStatus?.running?'Synchronising...':'Sync selected timetables';
  const selected=[...selectedScheduleFeeds].filter(id=>feeds[id]?.cachedAt && !feeds[id].stale);
  $('syncMessage').textContent=scheduleStatus?.running?'Downloading/indexing schedules on your local server. Live journeys continue updating.':
    `${selected.length} selected feed(s) ready. First sync may take several minutes for large bus timetables.`;
}
function renderScheduleBand(){
  const required=relevantScheduleFeeds();
  const feeds=scheduleStatus?.feeds||{};
  const ready=required.filter(id=>feeds[id]?.cachedAt && !feeds[id]?.stale);
  const stale=required.filter(id=>!feeds[id]?.cachedAt||feeds[id]?.stale);
  $('gtfsDot').classList.toggle('ready',required.length>0 && stale.length===0);
  $('gtfsBandStatus').textContent=scheduleStatus?.running?'Static schedules are synchronising in the background on this server.':
    !required.length?'Add routes to choose GTFS timetable feeds.':
    `${ready.length}/${required.length} relevant timetable feeds ready.${stale.length?' Sync '+stale.map(id=>SCHEDULE_FEED_NAMES[id]).join(', ')+' to improve matching and stop names.':' Automatic matching and named stops enabled.'}`;
}
async function loadScheduleStatus(){
  try {
    const response=await fetch('/api/static/status',{cache:'no-store'});
    if(!response.ok)return;
    scheduleStatus=await response.json();
    if(!scheduleSelectionInitialised && routes.length){selectedScheduleFeeds=new Set(relevantScheduleFeeds());scheduleSelectionInitialised=true;}
    renderScheduleSettings();renderScheduleBand();
    if(autoSyncSchedules&&connected()&&!scheduleStatus.running&&Date.now()-lastAutoSyncAttempt>3_600_000){
      const pending=[...selectedScheduleFeeds].filter(id=>scheduleStatus?.feeds?.[id]?.stale);
      if(pending.length){lastAutoSyncAttempt=Date.now();void syncSchedules(pending);}
    }
    if(scheduleStatus.running)setTimeout(()=>void loadScheduleStatus(),5000);
  } catch { $('gtfsBandStatus').textContent='Timetable status unavailable; live tracking can still work without schedule indexes.'; }
}
async function syncSchedules(feedIds=[...selectedScheduleFeeds]) {
  if(!connected()){openSettings('Enter your TfNSW API key before downloading static schedules.');return;}
  if(!feedIds.length)return;
  try {
    const res=await fetchApi('/api/static/sync',{method:'POST',body:JSON.stringify({feeds:feedIds})});
    showBanner(`Static GTFS synchronisation started for ${res.started.length} feed(s). Tracking stays available while indexing.`);
    await loadScheduleStatus();
  } catch(e){showBanner(`Static GTFS: ${e.message}`,true);}
}

async function testConnection() {
  if (checkingConnection) return;
  const entered = $('apiKey').value.trim().replace(/^apikey\s+/i,'');
  const target = $('connectionResults');
  if (!entered && !serverKeyConfigured) { target.textContent='Enter an API key above first.'; return; }
  checkingConnection=true; $('checkConnection').disabled=true;
  target.textContent='Checking TfNSW access… This may take a minute for several selected feeds.';
  try {
    const response = await fetch('/api/connection/check', {
      method:'POST', headers:{'Content-Type':'application/json', ...(entered ? {'X-TfNSW-Key':entered} : {})},
      body:JSON.stringify({feeds:[...selectedScheduleFeeds]}), cache:'no-store'
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Access check failed.');
    target.innerHTML = `<ul class="connection-results">${payload.results.map(result=>`<li class="${result.ok?'access-ok':'access-failed'}"><strong>${result.ok?'✓':'!'} ${safe(result.label)}</strong><span>${safe(result.message)}</span></li>`).join('')}</ul>`;
  } catch (error) { target.textContent=error.message; }
  finally { checkingConnection=false; $('checkConnection').disabled=false; }
}

function openSettings(message='') {
  $('apiKey').type='password'; $('toggleKey').textContent='Show';
  $('apiKey').value=key;
  $('apiKey').required = !serverKeyConfigured;
  $('apiKey').placeholder = serverKeyConfigured ? 'Server key configured • optional override' : 'Enter your TfNSW API key';
  $('connectionInfo').textContent = serverKeyConfigured ? 'Your server key is configured in .env and stays on the server. Leave this field empty to use it, or enter a temporary key for this tab.' : 'Enter your TfNSW API key to search stops and compare journeys. The key stays in this tab’s memory and is not saved by the app.';
  if (message) showBanner(message);
  $('autoSyncSchedules').checked = autoSyncSchedules;
  $('settingsDialog').showModal();
  void loadScheduleStatus();
}
async function addSample() {
  if (!connected()) { openSettings('Connect your API key to load the Blacktown to Central example.'); return; }
  $('loadSample').disabled=true;$('loadSampleEmpty').disabled=true;
  showBanner('Looking up Blacktown, Parramatta and Central station stop IDs...');
  try {
    const lookups=await Promise.all(['Blacktown Station','Parramatta Station','Central Station'].map(async name => {
      const found=(await fetchApi(`/api/stops?q=${encodeURIComponent(name)}`)).stops;
      const canonical=name.toLowerCase();
      const chosen=found.find(s=>s.name.toLowerCase()===canonical) || found.find(s=>s.name.toLowerCase().startsWith(canonical)) || found.find(s=>s.name.toLowerCase().includes(canonical));
      if (!chosen) throw new Error(`Cannot resolve ${name}. Try adding the route manually.`);
      return chosen;
    }));
    const [blacktown,parramatta,central]=lookups;
    const samples=[
      {id:makeId(),label:'Direct train',points:[blacktown,central],modes:['train'],transferMinutes:5},
      {id:makeId(),label:'Bus via Parramatta + train',points:[blacktown,parramatta,central],modes:['bus','train'],transferMinutes:5}
    ];
    const existingKeys=new Set(routes.map(r => `${r.points[0].id}|${r.points.at(-1).id}|${r.modes.join('-')}|${r.points.map(p=>p.id).join('-')}`));
    const newOnes=samples.filter(r=>!existingKeys.has(`${r.points[0].id}|${r.points.at(-1).id}|${r.modes.join('-')}|${r.points.map(p=>p.id).join('-')}`));
    refreshVersion++;
    routes=[...routes,...newOnes].slice(0,12);storeRoutes();
    showBanner(newOnes.length ? 'Example routes added. Live route estimates are updating.' : 'The Blacktown example is already saved.');
    render();refreshRoutes();
  } catch (e) {showBanner(`Could not load example: ${e.message}`,true);}
  finally { $('loadSample').disabled=false;$('loadSampleEmpty').disabled=false; }
}
function bindEvents() {
  for (const id of ['openSettings']) $(id).addEventListener('click',()=>openSettings());
  for (const id of ['addRouteTop','addRouteHero','addRouteEmpty']) $(id).addEventListener('click',()=>openRouteEditor());
  for (const id of ['loadSample','loadSampleEmpty']) $(id).addEventListener('click',addSample);
  document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>$(el.dataset.close).close()));
  $('refreshNow').addEventListener('click',refreshRoutes);
  $('checkConnection').addEventListener('click',()=>void testConnection());
  $('manageTimetables').addEventListener('click',()=>openSettings());
  $('suggestTimetables').addEventListener('click',()=>{selectedScheduleFeeds=new Set(relevantScheduleFeeds());scheduleSelectionInitialised=true;renderScheduleSettings();});
  $('syncTimetables').addEventListener('click',()=>void syncSchedules());
  $('timetableFeedList').addEventListener('change',e=>{
    if(e.target.matches('input[data-feed]')){scheduleSelectionInitialised=true;const id=e.target.dataset.feed;
      if(e.target.checked)selectedScheduleFeeds.add(id);else selectedScheduleFeeds.delete(id);
      renderScheduleSettings();}
  });
  $('autoSyncSchedules').addEventListener('change',e=>{autoSyncSchedules=e.target.checked;try { localStorage.setItem(AUTO_SYNC_KEY,autoSyncSchedules?'yes':'no'); } catch { showBanner('Auto-sync preference could not be saved on this device.',true); }});
  $('lockAll').addEventListener('click',()=>{
    let locked = 0;
    for (const route of routes) if (lockRoute(route.id,true)) locked++;
    if (locked) { render(); showBanner(`${locked} journey alternative(s) frozen to their original services.`); refreshRoutes(); }
  });
  $('routeForm').addEventListener('submit',saveRoute);
  $('addInterchange').addEventListener('click',()=>{if (draft.vias.length>=3) return; draft.vias.push(null); draft.modes.push(draft.modes.at(-1)||'any');renderRouteBuilder();});
  $('toggleKey').addEventListener('click',()=>{const inp=$('apiKey');inp.type=inp.type==='password'?'text':'password';$('toggleKey').textContent=inp.type==='password'?'Show':'Hide';});
  $('settingsForm').addEventListener('submit', event=>{
    event.preventDefault();const entered=$('apiKey').value.trim().replace(/^apikey\s+/i,'');
    if (!entered && !serverKeyConfigured) return;
    refreshVersion++; disconnected=false;
    key=entered;lastSuccessfulAt='';lastRefreshErrors=false;stopLookups=new Map();routeResults=new Map();trackedResults=new Map();routeChanges=new Map();
    $('settingsDialog').close();showBanner(key ? 'API key configured for this tab. Checking saved routes now.' : 'Using the server API key. Checking saved routes now.');render();refreshRoutes();void loadScheduleStatus();
  });
  $('disconnect').addEventListener('click',()=>{refreshVersion++;disconnected=true;key='';$('apiKey').value='';lastSuccessfulAt='';lastRefreshErrors=false;routeResults=new Map();trackedResults=new Map();routeChanges=new Map();$('settingsDialog').close();showBanner('API key disconnected. Saved routes remain on this device.');render();});
  $('comparisonGroups').addEventListener('change', event => {
    const input = event.target.closest('select[data-action="select-candidate"]');
    if (!input || input.value === '') return;
    const candidate = trackedResults.get(input.dataset.id)?.data.fixed?.legs
      .find(l=>l.id === input.dataset.leg)?.candidates?.[Number(input.value)];
    if (!candidate) return;
    bindTripId(input.dataset.id, input.dataset.leg, candidate.tripId, candidate.feedId, candidate.startDate);
  });
  $('comparisonGroups').addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');if (!button) return;
    const id=button.dataset.id;const route=routes.find(r=>r.id===id);if (!route) return;
    if (button.dataset.action==='lock') {lockRoute(id); return;}
    if (button.dataset.action==='unlock') {unlockRoute(id); return;}
    if (button.dataset.action==='manual-bind') {
      const field = button.closest('.track-leg')?.querySelector('.manual-trip-id');
      bindTripId(id,button.dataset.leg,field?.value.trim() || ''); return;
    }
    if (button.dataset.action==='un-bind') {bindTripId(id,button.dataset.leg,''); return;}
    if (button.dataset.action==='edit') openRouteEditor(id);
    if (button.dataset.action==='delete' && window.confirm(`Delete "${route.label}"?`)) {
      refreshVersion++;
      routes=routes.filter(r=>r.id!==id);tracks.delete(id);trackedResults.delete(id);storeTracks();storeRoutes();routeResults.delete(id);routeChanges.delete(id);render();
      if (!routes.length) showBanner('Route deleted. Add another alternative to continue watching.');
      else if (connected()) refreshRoutes();
    }
  });
  document.addEventListener('visibilitychange',()=>{if (document.visibilityState==='visible' && connected() && routes.length && Date.now()-lastRefreshAt>=API_INTERVAL_MS) refreshRoutes();});
}

async function initialise() {
  bindEvents(); render(); updateClock();
  try {
    const response = await fetch('/api/config', {cache:'no-store'});
    if (!response.ok) throw new Error('Cannot read server configuration.');
    serverKeyConfigured = Boolean((await response.json()).serverKeyConfigured);
    render();
    if (connected()) void refreshRoutes();
    else showBanner('Add your TfNSW API key in API settings to start searching and comparing routes.');
  } catch { showBanner('Cannot connect to the local server. Refresh the page to retry.', true); }
  void loadScheduleStatus();
  setInterval(updateClock,1000);
  setInterval(()=>void loadScheduleStatus(),60000);
}
void initialise();
