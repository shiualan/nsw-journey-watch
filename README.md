# Journey Watch NSW — v0.3 with static GTFS timetable matching

**Journey Watch** compares alternative NSW public transport trips and then locks the chosen departures so they stay fixed while TfNSW's real-time feeds update. Version 0.3 adds the *operator-specific GTFS Schedule feeds* to attach real-time trips automatically when there is sufficient evidence, translate stop IDs to names, and show the stop sequence between your boarding and alighting stations.

Node.js 22+, HTML/CSS/vanilla JavaScript. No runtime npm dependencies or build step. Playwright is a development dependency for browser verification. Private-by-default Node server and Docker Compose configuration.

## Run locally

```sh
cd nsw-journey-watch
./start.sh
```

`npm start` also works when `node` is on your PATH. The launcher additionally detects Homebrew Node if its global symlink is missing.

Open **http://127.0.0.1:4173**. The server automatically loads `.env` from the project directory. Set `TFNSW_API_KEY=your-key` (the existing `Transport_API` name is also supported), then restart the server. The dashboard uses this key automatically; it is never sent to the browser. Shell environment variables take precedence over `.env`. See `.env.example` for a template. Alternatively, enter a temporary key under **API settings**; that override stays in the current browser tab's memory. **Disconnect** stops requests for the current page; reload or reconnect to resume with the server key. You may need to subscribe to these distinct TfNSW API products: **Trip Planner**, **Realtime Vehicle Positions**, **Realtime Trip Update**, and **Timetables — For Realtime** (including the v2 product for Metro).

Use **API settings → Check API access** to test stop search and HEAD access to the selected schedule, trip-update and vehicle-position feeds. A green feed check confirms HTTP access, not a vehicle observation or a successful timetable import. The checks report subscription failures separately for each API product and do not download ZIP archives. If a realtime endpoint returns a gateway error to HEAD, the check tries GET response headers and immediately cancels its stream. Stop search and journey comparison require the **Trip Planner** product in addition to the six GTFS specifications supplied.

The supplied specifications use **v2 realtime** for Sydney Trains, Metro and Inner West Light Rail; buses, NSW TrainLink, ferries and the other light rail networks use **v1 realtime**. For **static timetables**, Metro uses v2 and the other supported networks use v1, including Inner West Light Rail. The complete combined timetable is not used for realtime service matching because its identifiers differ.

## Recommended workflow

1. Confirm your API access in settings, then add two alternatives, or select **Load Blacktown example** for direct train versus bus to Parramatta plus train to Central.
2. In **API settings → Static GTFS schedule data**, select **Select feeds for my routes**. For the Blacktown example, you will normally want **Sydney buses**, **Sydney Trains**, and potentially **NSW TrainLink** for intercity journeys.
3. Select **Sync selected timetables**. TfNSW sends ZIP archives. The Node server downloads, parses and caches their schedules locally. The sync endpoint responds immediately; progress appears in the settings feed list. For larger bus datasets, allow adequate disk space and memory. A feed may require an additional API subscription.
4. When a route has a departure worth tracking, use **Lock shown journeys** or an individual **Lock this journey** button. The 60-second live refresh continues. You can also lock before importing static data; the next refresh after sync may link the locked services.
5. Expand **Vehicle tracking, named stops & service IDs** and **Named stop sequence** on a locked route. See the scheduled stops, current indicated/forecast stop, GPS status, and estimated arrival. Expanded panels stay open during refresh.
6. Enable **Auto-sync selected stale feeds once per day** in API settings if you want automatic schedule refresh while the page remains open. It is opt-in to avoid unexpected large downloads and API usage. The UI identifies missing/stale feeds, and fresh schedules are used only if less than 36 hours old for new auto-matches. Previously locked trips can continue to use older schedules.

### How service matching works

A TfNSW Trip Planner (EFA) service ID cannot always be interpreted as a GTFS-Realtime `trip_id`.

Version 0.3 matches the saved leg against the **operator-specific GTFS static timetable**, using the correct service date (including `calendar_dates` exceptions), line, boarding stop, alighting stop, **both** planned departure and arrival times, and their order along the scheduled trip. Station/platform/stand names are normalised conservatively. Candidate services must satisfy narrow timing tolerances. A unique, strong match can be automatically bound to its GTFS `trip_id`, `start_date` and source feed, then persisted with the locked route in your browser. If multiple similar trips remain, auto-binding is refused; use manual service binding instead.

A **timetable-linked** service means the planned service has been identified. It **does not** mean the GPS has been observed. Only a fresh, exact GTFS-Realtime vehicle observation is marked **LIVE GPS** (existing 150-second freshness window). Matching failures, delays, cancellations and missing GPS are not silently replaced by a newer trip.

For a matched trip, the dashboard now shows a named stop list and one of these separate states:

- **GPS-reported progress**, if the matched vehicle supplies a fresh stop ID or stop sequence (e.g. *At Seven Hills Station* or *Approaching Parramatta Station*).
- **Timetable-based progress**, if only the schedule is available (e.g. *Timetable estimate: Blacktown Station → Seven Hills Station*). This is an inference based on published times, **not confirmed arrival**.

Stop-specific GTFS-Realtime arrival timestamps are used when provided; otherwise the app can apply a stop-specific delay to the correctly mapped GTFS static stop time. Trip-wide delays are a weaker fallback. Fresh boarding departure estimates are tracked separately from the original locked departures. Connection checks use the updated departure, planned interchange walks, and your transfer buffer. Stop-specific delays propagate along known stop sequences; `NO_DATA` stops terminate that propagation until another prediction resumes it. Repeated visits to a stop are distinguished by stop sequence. A boarding or destination stop marked `SKIPPED`, cancellation, or a risky transfer excludes that fixed alternative from the fastest-arrival recommendation. The app cannot know which transport a person physically boarded or guarantee they made a connection.

### Timetable feeds

| Mode / network | Static GTFS Schedule endpoint (append to `https://api.transport.nsw.gov.au/`) |
| --- | --- |
| Sydney buses | `v1/gtfs/schedule/buses` |
| Sydney Trains | `v1/gtfs/schedule/sydneytrains` |
| NSW TrainLink / intercity | `v1/gtfs/schedule/nswtrains` |
| Sydney Metro | `v2/gtfs/schedule/metro` |
| Sydney Ferries | `v1/gtfs/schedule/ferries/sydneyferries` |
| Inner West Light Rail (L1) | `v1/gtfs/schedule/lightrail/innerwest` |
| CBD & South East Light Rail | `v1/gtfs/schedule/lightrail/cbdandsoutheast` |
| Parramatta Light Rail | `v1/gtfs/schedule/lightrail/parramatta` |
| Newcastle Light Rail | `v1/gtfs/schedule/lightrail/newcastle` |

**Important:** TfNSW uses **v1 static Sydney Trains schedules** alongside **v2 real-time Sydney Trains positions/updates**. For exact `route_id` reconciliation, TfNSW explicitly recommends the individual real-time-compatible operator bundle over the combined `Timetables Complete GTFS` ZIP. API paths can change: check TfNSW's developer portal if any feed becomes unavailable.

Static importer details: built-in ZIP central-directory and DEFLATE handling, streaming GTFS CSV parsing, `routes.txt`, `trips.txt`, `stops.txt`, `stop_times.txt`, `calendar.txt` and `calendar_dates.txt`, Sydney service dates including times after 24:00, atomic gzip-compressed on-disk indexes, and a small LRU in-memory cache. Only TfNSW's server-side allowlist of schedule URLs can be downloaded. Missing or invalid ZIP files are rejected. Deliberate safety limits apply: compressed ZIP up to 220 MB and each selected uncompressed entry up to about 1.1 GB. Very large operator feeds may exceed this prototype's limits or available hardware resources.

### Other API routes

| Endpoint | Function |
| --- | --- |
| `GET /api/config` | Reports whether the server key is configured; never returns the key. |
| `POST /api/connection/check` | `{ "feeds": ["sydneytrains"] }` — check stop search and selected API product access. |
| `GET /api/stops?q=...` | TfNSW Stop Finder autocomplete (needs API key). |
| `POST /api/compare` | Find the best next trip for each unlocked saved alternative (needs API key). |
| `POST /api/track` | Refresh locked services from GTFS-Realtime; apply static GTFS crosswalk when available (needs API key). |
| `GET /api/static/status` | Read the local feed cache state; does not require a key. |
| `POST /api/static/sync` | `{ "feeds": ["buses", "sydneytrains"] }` — start sync for explicitly selected feeds (needs API key). |

The browser refreshes live data once per minute while open and visible. There is **no continuous server-side background tracking**, push notification, account or multi-user history. LocalStorage stores route definitions and locked snapshots; the server stores the **public timetable index** only, not your journey selections. A configured `.env` key stays in that file; the app never copies it to the timetable cache or browser. Timetable sync jobs continue until finished if the browser closes, and the key is used transiently in server memory during sync.

## Docker / Mac mini

```sh
docker compose up -d --build
```

Compose reads the server key from `.env` at startup. The Compose file binds `127.0.0.1:4173` on the Docker host and persists operator timetable indexes in a named volume `gtfs-cache`. A `docker compose down` does not delete this volume; `docker compose down -v` does. For non-Docker installs, schedules are cached in `./data/gtfs/` by default. You can set `GTFS_DATA_DIR` to relocate them.

The app has **no login/authentication**. Do not expose port 4173 to the public internet. Put any phone/LAN access behind an authenticated TLS reverse proxy (or VPN). It is not a hosted service and has no API key collection service.

## Development and tests

```sh
npm test
npm run dev
```

With the local server running, `npm run qa:live` runs the live browser checks and saves screenshots plus `browser-report.json` under `data/qa/`. Install development dependencies with `npm install` first; Playwright may also need `npx playwright install chromium`. These checks make real TfNSW requests using the server key.

The suite includes client state/keyboard interaction tests, server handler integration tests, and API access diagnostics tests. These do not replace real browser layout checks. It uses fixtures and mocked TfNSW responses (no real API key required). It tests GTFS ZIP import/persistence, escaped CSV strings, service calendars and overnight dates, unique versus ambiguous matching, named GPS stops, ETA updates, route comparison, access controls and feed failures. Live verification has exercised Trip Planner stop search and the Blacktown train versus bus/train comparison, realtime feed decoding, and actual Sydney Trains, NSW TrainLink and Sydney buses timetable imports. Other networks still require live verification. Automated server tests use mocked upstream responses and do not prove subscription access.

### Reference documentation

- [Transport for NSW — GTFS / GTFS-Realtime documentation](https://opendata.transport.nsw.gov.au/developers/documentation)
- [Timetables — For Realtime](https://opendata.transport.nsw.gov.au/dataset/public-transport-timetables-realtime)
- [Timetables — For Realtime v2](https://opendata.transport.nsw.gov.au/dataset/public-transport-timetables-realtime-v2)
- [TfNSW staff explanation of Sydney Trains static vs realtime IDs](https://opendataforum.transport.nsw.gov.au/t/realtime-trip-update-tripdescriptor-not-matching-trips-txt/4386)

Data attribution: **Transport for NSW Open Data**, Creative Commons Attribution. Independent application, not endorsed by Transport for NSW.
