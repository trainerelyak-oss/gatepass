# PatrolSync

Security officers lose signal all the time: basements, carparks, plant rooms, stairwells. PatrolSync lets them keep doing patrols, inspections and incident reports with no connection at all, and uploads everything automatically once they're back in range.

## What it does

- **Patrol rounds**: check in at each checkpoint by scanning its QR tag (or typing the code)
- **Inspections**: pass / fail / N/A checklists with notes and photos. Failed items can be turned straight into an incident
- **Incident reports**: severity, type, location, photos, GPS
- **Offline first**: every record is written to the device (IndexedDB) before anything touches the network. The app shell is cached by a service worker, so it opens and works with no connection
- **Priority sync**: when the connection returns, critical and high incidents upload first, then failed inspections, then routine check-ins
- **Control room dashboard**: live feed of what's coming in, checkpoint coverage, officers, and which records were captured offline and how late they arrived

## Running it

Needs Node 18+. No packages to install.

```bash
npm start
```

- Officer app: http://localhost:3000
- Control room: http://localhost:3000/dashboard

Data is stored in `server/data/` (ignored by git). Delete that folder to reset.

## Testing offline

**On a laptop (quickest)**

1. Open http://localhost:3000 in Chrome, sign in, then open the dashboard in a second window
2. In the app: DevTools → Network → set throttling to **Offline**, or turn on *Test mode: force offline* from the profile screen
3. Do a patrol, an inspection and an incident. The status pill turns amber and the Log tab counts what's waiting
4. Reload the page while still offline. It still loads and your records are still there
5. Go back online. Records upload within a few seconds and appear on the dashboard tagged *Offline · synced +Xm*

**On a phone**

Service workers and the camera only work over HTTPS (or localhost), so expose the server through a tunnel:

```bash
npx localtunnel --port 3000
# or
cloudflared tunnel --url http://localhost:3000
```

Open the https URL on the phone, sign in, then switch on airplane mode and keep working.

QR scanning uses the browser's built-in BarcodeDetector (Chrome on Android, Chrome on macOS). On iPhone, type the checkpoint code instead. Checkpoint QR tags just need to contain text like `PSYNC:CP-01`.

## Configuring a site

Checkpoints, checklists and incident types live in `public/data/config.json`.

## How sync works

1. Each record gets a client-generated UUID and a `revision`, and is saved locally with `syncStatus: "pending"`
2. The sync engine checks real server reachability (not just `navigator.onLine`) every 15s, on the `online` event, when the app comes to the foreground, and right after a record is saved
3. Pending records are sorted by priority and sent in batches of up to 3 MB
4. The server upserts by id, so retries are safe and duplicates are impossible. Photos are pulled out of the payload and stored as files
5. Only records the server confirms are marked as synced. Anything that fails stays queued for the next attempt

## Project layout

```
server/server.js         HTTP server + sync API (no dependencies)
public/index.html        officer app
public/dashboard.html    control room
public/sw.js             offline caching
public/js/db.js          IndexedDB storage
public/js/sync.js        connectivity + sync queue
public/js/views/         app screens
public/data/config.json  site setup
```
