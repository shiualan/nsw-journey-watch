import { findStops, throttledRequest } from './tfnsw.js';
import { FEEDS, feedUrl } from './tracking.js';
import { scheduleUrl } from './gtfs-static.js';

function accessMessage(status) {
  if (status === 401) return 'Key rejected or this API product is not subscribed. Check your TfNSW subscriptions.';
  if (status === 403) return 'Access denied or quota exhausted. Check your subscriptions and usage in the TfNSW portal.';
  if (status === 404) return 'Endpoint not found. This feed may have moved or be unavailable.';
  if (status === 405 || status === 501) return 'This endpoint does not support an access-only check. Try its normal download or tracking action.';
  if (status === 429) return 'Rate limit reached. Wait before checking again.';
  return `TfNSW returned HTTP ${status}. Try again later.`;
}

// A HEAD probe checks access without downloading large ZIP or protobuf feeds.
export async function checkConnection(feeds = [], key, fetchImpl = fetch) {
  if (!Array.isArray(feeds) || feeds.length > Object.keys(FEEDS).length || feeds.some(id => !Object.hasOwn(FEEDS, id))) {
    throw new Error('Choose valid timetable feeds to check.');
  }
  const results = [];
  try {
    const stops = await findStops('Central Station', key, fetchImpl);
    results.push({ id:'planner', label:'Trip Planner / stop search', ok:stops.length > 0,
      message:stops.length ? 'Stop search returned results.' : 'The API responded but returned no stops. Route search is not yet verified.' });
  } catch (error) {
    results.push({ id:'planner', label:'Trip Planner / stop search', ok:false, message:error.message });
  }
  for (const id of new Set(feeds)) {
    for (const kind of ['schedule', 'trip', 'vehicle']) {
      const label = `${FEEDS[id].label} · ${kind === 'schedule' ? 'timetable' : kind === 'trip' ? 'trip updates' : 'vehicle positions'}`;
      const url = kind === 'schedule' ? scheduleUrl(id) : feedUrl(id, kind);
      try {
        let response = await throttledRequest(() => fetchImpl(url, {
          method:'HEAD', headers:{Authorization:`apikey ${key}`},
          signal:AbortSignal.timeout(5000), redirect:'error'
        }));
        // Some TfNSW realtime gateways return 502 for HEAD even when GET
        // works. Check response headers with GET, then immediately cancel the
        // stream so diagnostics do not decode or retain the full feed.
        let method='HEAD';
        if (kind !== 'schedule' && response.status >= 500 && response.status !== 501) {
          method='GET';
          response=await throttledRequest(()=>fetchImpl(url, {
            headers:{Authorization:`apikey ${key}`}, signal:AbortSignal.timeout(10000), redirect:'error'
          }));
          await response.body?.cancel();
        }
        results.push({ id:`${id}:${kind}`, label, ok:response.ok, status:response.status, method,
          message:response.ok ? 'Access confirmed. Live service data is checked when tracking a journey.' : accessMessage(response.status) });
      } catch (error) {
        results.push({ id:`${id}:${kind}`, label, ok:false,
          message:error.name === 'TimeoutError' ? 'Access check timed out. Try again later.' : 'Cannot reach this TfNSW endpoint. Check the server’s internet connection.' });
      }
    }
  }
  return { checkedAt:new Date().toISOString(), results };
}
