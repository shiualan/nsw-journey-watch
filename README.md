# Journey Watch NSW — Vercel webapp

Compare alternative NSW public transport journeys, lock their selected services, and follow live trip updates and vehicle positions. This branch deploys the HTML/CSS/JavaScript frontend and a Node.js API function on Vercel.

## API key: enter it in the app

Open **API settings**, enter your own Transport for NSW Open Data key, then select **Connect API**. There are **no API-key environment variables, no `.env` loading, and no embedded shared key**. Each visitor supplies their own key.

The key stays in the current tab’s memory. Requests send it to this app’s same-origin API, which calls the allowlisted TfNSW endpoints over HTTPS. The app does not write it to browser storage, timetable files, or logs. Reloading or disconnecting clears it; enter it again to resume live requests. Saved route definitions and locked services remain in LocalStorage on that device.

Your key needs access to **Trip Planner**, the relevant **Realtime Vehicle Positions** and **Realtime Trip Updates** products, and **Timetables — For Realtime**. Metro uses the v2 timetable product. Use **Check API access** in settings to check the products for your selected feeds. Some Sydney Trains gateways reject HEAD checks; the app then checks GET headers and immediately cancels the response stream.

## Deploy this branch on Vercel

1. Push `feat/vercel-webapp` to GitHub when ready.
2. In Vercel, deploy this branch using the Git integration, or run `npx vercel` from a checkout of this branch for a preview deployment.
3. Use **Other** as the framework preset, the repository root as the root directory, and the checked-in settings: build command **`npm run build`**, output directory **`public`**, Node.js **22.x**.
4. Leave API-key environment variables empty. Open the deployment and enter a key in **API settings**.

`vercel.json` routes `/api/*` to `api/handler.js`, places the function in Sydney (`syd1`), sets a 300-second maximum duration, and applies security headers to static assets as well as API responses. Only `public/` is published as static files. `.vercelignore` excludes local credentials, test artifacts, downloaded timetables, and dependencies from uploads. No database, storage integration, or shared application secret needs provisioning.

Creating this branch does not itself deploy or publish the app. Configure your Vercel project’s production branch deliberately; previews can use this feature branch while `main` retains the original local-server version.

## Compare and track

1. Connect your key, then add alternatives or select **Load Blacktown example**.
2. Compare the next available journeys and use **Lock shown journeys** or **Lock this journey** to retain those exact services.
3. In settings, use **Select feeds for my routes**, then **Link locked services**. Keep the tab open while the app downloads and processes one selected feed per request. Large bus feeds can take a minute or longer.
4. Inspect **Vehicle tracking, named stops & service IDs** and **Named stop sequence**. A strong unique match saves the trip ID, service date, feed and relevant stop sequence with the locked journey in your browser.
5. The dashboard refreshes once a minute while visible. **Unlock & re-plan** selects new departures. Editing a route clears its locked selection. A manual trip ID binding clears any previously saved path so it can be linked again.

### Timetables on a serverless host

Vercel functions have temporary storage and may handle consecutive requests on different instances. Timetable ZIPs and compressed indexes use the instance’s temporary directory as a best-effort cache. They are never treated as durable application data.

A linking request finishes processing its one feed **before responding**. It returns matched service bindings and small stop sequences, which are saved with the locked routes. Later tracking requests include those saved sequences, so named-stop progress and stop-specific delay calculations work even on an instance with an empty cache. The API validates the saved path against the bound trip, feed and service date, as well as stop count, ordering and timestamps.

Link after locking; importing a feed alone cannot persist its entire network to your browser. Ambiguous matches remain unbound. A timeout or import failure appears as an error and can be retried without replacing locked services. Closing the tab stops the sequence of remaining feeds; a request already running may finish on the server. There are no detached background import jobs or guaranteed cross-instance cache status. Optional daily refresh runs only while the tab is open and connected.

### Matching and forecast rules

Trip Planner service IDs do not necessarily equal GTFS-Realtime trip IDs. Static matching checks the service calendar and exceptions, transport line, boarding and alighting stops, both planned times, and stop order. Only a unique strong candidate is bound automatically. Similar route labels or nearby times alone do not confirm a vehicle.

**LIVE GPS** requires a fresh observation for the exact bound trip. A timetable-linked service may have no GPS. Scheduled progress and GPS progress are labelled separately. Matched stop sequences are retained for the locked service even if the server cache disappears.

Fresh boarding departures and destination arrivals are tracked independently of the original locked times. Connection checks include updated departure times, interchange walking and the selected transfer buffer. Stop-specific delays take precedence over trip-wide delays; `NO_DATA` terminates propagation until another prediction resumes it. Stop sequences disambiguate repeated visits to a stop. Cancellation, skipped boarding/alighting stops and risky transfers exclude the alternative from the earliest-arrival recommendation. The app cannot confirm which service you physically boarded or guarantee a connection.

| Network | Static schedule | Realtime trip updates / positions |
| --- | --- | --- |
| Sydney buses | v1 | v1 |
| Sydney Trains | v1 | v2 |
| NSW TrainLink | v1 | v1 |
| Sydney Metro | v2 | v2 |
| Sydney Ferries | v1 | v1 |
| Inner West Light Rail (L1) | v1 | v2 |
| L2/L3, Parramatta and Newcastle Light Rail | v1 | v1 |

The combined complete GTFS ZIP is not used for realtime matching because its identifiers differ. The importer accepts only allowlisted operator feeds, limits ZIPs to 220 MB, bounds extracted entries, handles quoted CSV, supports overnight Sydney service dates, and uses atomic compressed indexes with a small memory LRU. Very large feeds may exceed the function’s memory, temporary storage or duration limits.

## Local development and verification

Node.js 22+ is required. There is no frontend build pipeline or runtime npm dependency.

```sh
npm install
./start.sh
```

Open **http://127.0.0.1:4173** and enter a key in the app. Existing `.env` files are ignored by this branch. `npm run dev` runs the local server with file watching. Docker Compose is also available (`docker compose up -d --build`); keys are entered in the browser there too.

```sh
npm test
npm run build
```

Tests cover route planning, GTFS import/calendars, realtime decoding, matching, delay/cancellation handling, tab key handling, Vercel rewrites and parsed request bodies, completed import requests, and a cold-process test proving saved stop sequences work with an empty server cache. Mocks do not prove access to every live operator feed.

For live browser QA, install Chromium with `npx playwright install chromium`, start the app, and pass a key via standard input from a private file outside the repository:

```sh
npm run qa:live -- --key-stdin < /path/to/private-key.txt
```

The QA key is used only for form entry; screenshots and a redacted report are saved under ignored `data/qa/`. This command makes real TfNSW requests and imports the example’s feeds. It tests stop search, comparison, locking, timetable linking, reload persistence, route editing/deletion, reconnect behaviour and desktop/mobile layout.

### API routes

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Server health. |
| `GET /api/config` | Tab-key mode and temporary timetable storage; never a key. |
| `GET /api/stops?q=...` | Stop Finder autocomplete. |
| `POST /api/compare` | Compare 1–12 alternatives. |
| `POST /api/track` | Refresh locked services, using saved paths when available. |
| `GET /api/static/status` | Best-effort temporary cache status for the current instance. |
| `POST /api/static/sync` | `{ "feeds": ["buses"], "tracks": [...] }` — finish one feed import and return linked services. |
| `POST /api/connection/check` | Probe selected products with the supplied tab key. |

All key-requiring endpoints expect `X-TfNSW-Key` per request. There is no server environment fallback. Requests and API responses are not cached publicly, cross-origin browser API access is rejected, and upstream URLs cannot be supplied by visitors.

Data: **Transport for NSW Open Data**, Creative Commons Attribution. Independent application, not endorsed by Transport for NSW. See [TfNSW documentation](https://opendata.transport.nsw.gov.au/developers/documentation), [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js), and [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json).
