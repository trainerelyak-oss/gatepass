# GatePass

**The front desk never goes down.**

When the internet drops at a guardhouse, visitor management usually falls back to a paper logbook. Nobody can check whether a pass is real, the banned list is out of reach, and if the fire alarm goes off nobody knows who is still inside.

GatePass keeps every gate working with no connection, and syncs when the connection comes back.

## Features

**Passes verified with no internet.** When a host invites a visitor, the server signs the pass with a private key (ECDSA P-256). Gate devices keep the matching public key, so they can confirm a QR pass is genuine, issued for this site and inside its time window entirely offline. Edit a single character of the pass and it is rejected.

**Reused passes caught across gates.** If the same single-entry pass is used at two gates that are both offline, neither device can know at the time. When they sync, the server stitches the visits together and raises an alert. A rescan at the same gate is blocked immediately.

**Watchlist checks offline, without personal data on the phone.** The banned/escort list is sent to devices only as salted SHA-256 fingerprints of name + partial ID. A lost phone reveals nothing readable, but the gate can still match a visitor offline. Reasons stay on the server.

**PDPA-friendly ID checks.** Only the last 3 digits and letter of an NRIC/FIN are collected, following the PDPC's NRIC advisory guidelines. If the pass was issued with an ID, the gate checks they match.

**Contractor safety induction.** Contractors confirm site safety rules and sign on screen before they are badged in.

**Evacuation roll call that works in an outage.** Muster mode lists everyone on site (from this gate plus other gates as of the last sync). Officers tick people off at the assembly point and get a list of who is unaccounted for. The result reaches the control room when the device reconnects.

**Control room dashboard.** Live alerts, who is on site, gate activity (with how long each record was stuck offline), gate device status, the last roll call, and a form to issue new passes.

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

Data lives in `server/data/` (ignored by git). Delete the folder to reset everything, including the signing key.

## Demo walkthrough

1. Open the **dashboard** and create a pass (try a Contractor with ID `567A`). Open the pass page on a phone or another window.
2. Open the **gate app**, sign in as Gate A. Wait for "Site data downloaded" at the bottom. That's the device getting the key, passes and watchlist.
3. Go offline: DevTools → Network → **Offline**, or the profile icon → *Test mode: force offline*.
4. **Scan pass** (point the camera at the QR, or type the 6-letter code). Enter the ID, complete the induction, get a badge.
5. Try a forged pass: copy the pass link, change a character in the middle of the token, and paste the token into the code box. It is refused.
6. **Walk-in** `Marcus Wong`, ID `123B`. Watchlist refusal. (`Alicia Teo` / `880K` is escort-only.)
7. Use a **second browser profile or incognito window** as Gate B (also offline) and scan the same single-entry pass. It's accepted, because Gate B can't know.
8. **Evacuate** tab → start a roll call, tick some people off, finish.
9. Go back online on both. Watch the dashboard: pass reuse alert, watchlist refusal, forged pass, roll call result, all tagged with how long they were offline.

Two tabs in the same browser share storage, so Gate A and Gate B need separate browser profiles (or one normal + one incognito window).

## Phones

Camera access, the service worker and offline verification need HTTPS (or localhost). Expose the server with a tunnel:

```bash
npx localtunnel --port 3000
# or
cloudflared tunnel --url http://localhost:3000
```

QR scanning uses the browser's BarcodeDetector where available and falls back to [jsQR](https://github.com/cozmo/jsQR), so it works on iPhone, Android and laptop webcams.

## How sync works

- Every action (sign-in, sign-out, refusal, roll call) is an immutable event with a client-generated id, written to IndexedDB first.
- The sync engine checks real server reachability every 15s, on the `online` event and right after each new event. Refusals and watchlist hits upload first.
- The server upserts by id, so retries never duplicate anything. Visits, flags and alerts are derived from the full event history, which is how cross-gate conflicts like pass reuse get detected.
- After uploading, the device downloads a fresh site snapshot (public key, active passes, watchlist fingerprints, current visits) so it's ready for the next outage.

## Configuring a site

Gates, visitor types, induction rules and the assembly point are in `public/data/site.json`. The watchlist is `server/watchlist.json` (server only, never sent to devices in plain text).

## Layout

```
server/server.js        HTTP server and API
server/passes.js        signing keys, pass tokens, watchlist hashing
server/visits.js        turns events into visits and alerts
public/index.html       gate app
public/dashboard.html   control room
public/pass.html        visitor's pass
public/js/verify.js     offline signature + watchlist checks
public/js/sync.js       sync queue and site snapshot download
public/js/views/        gate app screens
```

Third-party: [jsQR](https://github.com/cozmo/jsQR) (Apache 2.0) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), in `public/vendor/`.
