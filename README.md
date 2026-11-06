# GatePass

**The front desk never goes down.**

When the internet drops at a guardhouse, visitor management usually falls back to a paper logbook. Nobody can check whether a pass is real, the banned list is out of reach, and if the fire alarm goes off nobody knows who is still inside.

GatePass keeps every gate working with no connection, and syncs when the connection comes back.

## Features

**Passes verified with no internet.** When a host invites a visitor, the server signs the pass with a private key (ECDSA P-256). Gate devices keep the matching public key, so they can confirm a QR pass is genuine, issued for this site and inside its time window entirely offline. Edit a single character of the pass and it is rejected.

**Reused passes caught across gates.** If the same single-entry pass is used at two gates that are both offline, neither device can know at the time. When they sync, the server stitches the visits together and raises an alert. A rescan at the same gate is blocked immediately.

**Watchlist checks offline, without personal data on the phone.** The banned/escort list is sent to devices only as salted SHA-256 fingerprints of name + partial ID. A lost phone reveals nothing readable, but the gate can still match a visitor offline. Reasons stay on the server.

**PDPA-friendly ID checks.** Only the last 3 digits and letter of an NRIC/FIN are collected, following the PDPC's NRIC advisory guidelines. If the pass was issued with an ID, the gate checks they match.

**Zones and spot checks.** Every pass lists the zones its holder may enter (restricted areas such as the server room, plant room and roof are marked). Officers inside the building can spot-check anyone by scanning their pass or typing their badge number: authorised here, wrong zone, expired, revoked, or **never signed in at any gate (possible tailgating)**. If a "never signed in" result was only because the device hadn't synced yet, the server clears it automatically once it sees the sign-in from the other gate.

**Temporary access issued at the gate.** When a host can't be reached or a pass is lost, the officer issues a short-term pass (max 4 hours) signed with *that device's own key*. Every device registers its public key with the server, so other gates can verify the temporary pass offline. The control room approves or revokes each one after sync; revoked passes are refused everywhere on the next sync and anyone still on site with one is flagged.

**Contractor compliance and equipment.** Contractors confirm the site safety rules, give a permit-to-work number and sign on screen. Any items issued (access cards, keys, radios, PPE) or declared (laptops, tools) are recorded at sign-in and checked at sign-out. Items not returned are flagged.

**Incident documentation.** Report suspicious activity, breaches, tailgating, damage, theft, medical and hazards, linked to the visitors involved. Add signed witness statements, an evidence register with chain of custody, and follow-up updates. Every evidence photo gets a SHA-256 fingerprint on the device; the server recomputes it on upload and marks it *verified* or *modified*. Control-room follow-ups (investigation notes, status changes) sync back to the officers' devices.

**Site checks.** Restricted area check, emergency resources inventory (counts against expected stock) and perimeter & route check, all offline. Faults and shortages raise alerts and can be turned into incidents.

**Evacuation roll call that works in an outage.** Muster mode lists everyone on site (from this gate plus other gates as of the last sync). Officers tick people off at the assembly point and get a list of who is unaccounted for.

**End-of-shift report and handover.** Generated on the device from the shift's activity: who is still on site, items still out, refusals, temporary passes, spot-check failures, incidents, checks and roll calls, plus handover notes and a signature.

**Temporary posts.** An officer can set up a pop-up post (event entrance, emergency cordon) with an end time. It appears on the dashboard alongside the permanent gates.

**Control room dashboard.** Overview (alerts, who is on site, gate activity with offline delays, gate devices, last roll call, pass issuing), incidents with follow-up, temporary pass review, and checks and shift reports.

**Built for real shifts.** Scan a pass (or type a badge number) to sign someone out, with undo. Dark theme by default with a bright-sun light mode, beeps and vibration on every verdict, success screens that return to the gate on their own, returning-visitor autofill, on-site filters (overdue, contractors, escort, holding items, temporary) with time-left chips, screen kept awake at the gate and during roll calls, keyboard shortcuts on laptops (`S` scan, `W` walk-in, `T` temporary, `/` search), roll-call results you can text by SMS, and installable to the home screen.

**Demo tools.** The dashboard's **Demo** button resets the server and loads a ready-made scenario (two passes, two people already on site). Gate devices clear their copies automatically on their next sync. Each pass dialog also has **Copy tampered pass** for showing forgery detection.

## Running it

Needs Node 18+. Nothing to install.

```bash
npm start
```

| Page | URL |
|---|---|
| Gate app (security officer) | http://localhost:3000 |
| Control room + issue passes | http://localhost:3000/dashboard |
| Visitor pass | `/pass#<token>` (linked from the dashboard) |

Running on your own computer, data is stored in a SQLite database at `server/data/gatepass.sqlite`, using the SQLite engine built into Node (no packages to install). Older `db.json` data is imported automatically. When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set, it uses Supabase instead (see below). Delete `server/data/` to reset everything, including the signing key.

## Using it on several devices

Every gate phone and the dashboard talk to the same server, so they all need to reach it over **https** (phones only allow the camera and offline pass checks on secure pages).

**Option 1: tunnel from your laptop (quickest).** Run `npm start`, then in a second terminal `npx localtunnel --port 3000`. Open the https link it prints on the laptop, go to `/dashboard`, click **Connect device**, and scan the QR code with each officer's phone.

**Option 2: free cloud setup (permanent https address and database).** The app runs on Render's free plan and stores everything in a free Supabase database. Render's free plan wipes its disk on every restart, so GatePass keeps all data, the pass-signing key and evidence photos in Supabase instead.

1. **Create the database.** Sign up at supabase.com → **New project** (any name, save the database password somewhere) → wait for it to finish setting up.
2. **Create the tables.** In the project: **SQL Editor** → **New query** → paste the contents of `supabase/schema.sql` from this repo → **Run**. You should see "Success".
3. **Copy two values.** **Project Settings → API Keys** (or Data API): copy the **Project URL** (`https://xxxx.supabase.co`) and a **secret key** (`sb_secret_...`). Never put the secret key in the browser or in GitHub.
4. **Deploy the app.** Sign up at render.com with GitHub → **New → Blueprint** → pick this repository. Render reads `render.yaml` and asks for `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: paste the two values → **Apply**.
5. **Check the logs.** When the deploy finishes, the log shows `GatePass running · Supabase database`. If something is wrong it says exactly what (tables missing, wrong key or wrong URL).
6. **Use it.** Open `https://<your-service>.onrender.com/dashboard` → **Connect device** → scan the QR code with each phone.

Free-plan behaviour to know about: Render puts the app to sleep after 15 minutes with no traffic and takes about a minute to wake up (gate phones keep working offline meanwhile and sync once it's awake). Supabase pauses a free project after a week with no activity; resume it from the Supabase dashboard. Before a demo, open the dashboard a couple of minutes early to wake everything up.

You can browse the data in Supabase's **Table Editor** (tables starting with `gp_`), including a readable `gp_visit_log` view.

Phones that lose signal keep working and catch up when they reconnect. The dashboard's **Gate devices** panel shows which phones are connected and how many records each is still holding.

## Demo walkthrough

1. Open the **dashboard** and create a pass (try a Contractor with ID `567A`, zones Loading bay + Plant room). Open the pass page on a phone or another window.
2. Open the **gate app** and sign in as Gate A. Wait for "Site data downloaded" at the bottom: the device now has the site key, the passes, the watchlist and the other devices' keys.
3. Go offline: DevTools → Network → **Offline**, or profile icon → *Test mode: force offline*.
4. **Scan pass** (camera or the 6-letter code). Enter the ID, complete the induction with a permit number, issue an access card, and get a badge.
5. **Temporary** → issue a 2-hour pass for a walk-in. A QR appears that other gates can verify offline.
6. **On site → Spot check** → choose *Server room* and type the contractor's badge (`A001`) → **Not allowed in this zone** → *Report incident* → add a witness statement and a photo to the evidence register.
7. **Checks → Emergency resources inventory** with one count short of what's expected.
8. **On site** → sign the contractor out without ticking the access card → flagged.
9. **Evacuate** → roll call. **Profile → End-of-shift report** → sign.
10. Use a **second browser profile or incognito window** as Gate B (also offline). Paste a valid pass code that nobody signed in into Spot check → **possible tailgating**. Scan the same single-entry pass Gate A used → accepted, because Gate B can't know.
11. Go back online on both and open the dashboard: alerts for pass reuse, tailgating, missing access card, stock shortage, temporary pass to review. Revoke the temporary pass, close the incident with a note, and watch the officers' devices pick it up.

Two tabs in the same browser share storage, so Gate A and Gate B need separate browser profiles (or one normal and one incognito window).

## Phones

Camera access, the service worker and offline verification need HTTPS (or localhost). Expose the server with a tunnel:

```bash
npx localtunnel --port 3000
# or
cloudflared tunnel --url http://localhost:3000
```

QR scanning uses the browser's BarcodeDetector where available and falls back to [jsQR](https://github.com/cozmo/jsQR), so it works on iPhone, Android and laptop webcams.

## How sync works

- Every action (sign-in, sign-out, refusal, spot check, incident, statement, evidence, check, roll call, shift report) is an immutable event with a client-generated id, written to IndexedDB first.
- The sync engine checks real server reachability every 15s, on the `online` event and right after each new event. Refusals and watchlist hits upload first.
- The server upserts by id, so retries never duplicate anything. Visits, flags and alerts are derived from the full event history, which is how cross-gate conflicts like pass reuse get detected.
- After uploading, the device downloads a fresh site snapshot (site key, other devices' keys, revoked passes, active passes, watchlist fingerprints, current visits, open incidents with control-room updates) so it's ready for the next outage.

## Configuring a site

Gates, zones, visitor types, induction rules, item presets, temporary access limits, incident categories, check templates and the assembly point are all in `public/data/site.json`. The watchlist is `server/watchlist.json` (server only, never sent to devices in plain text).

## Layout

```
server/server.js        HTTP server and API
server/store.js         storage: SQLite, Supabase or JSON file
supabase/schema.sql     tables for the free Supabase setup
server/passes.js        signing keys, pass tokens, watchlist hashing
server/visits.js        turns events into visits and alerts
public/index.html       gate app
public/dashboard.html   control room
public/pass.html        visitor's pass
public/js/verify.js     offline signature, revocation + watchlist checks
public/js/devicekey.js  per-device signing key for temporary passes
public/js/sync.js       sync queue and site snapshot download
public/js/views/        gate app screens
```

Third-party: [jsQR](https://github.com/cozmo/jsQR) (Apache 2.0) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), in `public/vendor/`.
