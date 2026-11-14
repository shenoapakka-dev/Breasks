# ETM Capacity Sync

A standalone Node script (`etm-capacity-sync.js`) that logs into ETM
headlessly, reads the List Orders table for a given delivery date, and
computes how much **Fixing Minutes** and **CBM** capacity is already
committed per area/slot. It's meant to run unattended on a schedule
(cron), producing the live numbers the [Slot Capacity
Monitor](https://claude.ai/artifact/4Dq8gDouX8ptjufoVRVNhh) prototype
needs instead of sample data.

It reuses the exact same scraping and planning code as the Chrome
extension - `content/page-bridge.js`, `lib/row-mapper.js`,
`lib/planner.js` - instead of a second copy, so a fix made for one
applies to both.

## ⚠️ Before relying on this unattended

The `login()` and `openListOrders()` functions in
`etm-capacity-sync.js` use **best-effort guessed selectors** (based on
screenshots of the ETM pages), not ones verified against the real
login form or date filters. Run it once with `--headful` first:

```bash
ETM_USERNAME=youruser ETM_PASSWORD=yourpass node server/etm-capacity-sync.js --headful
```

This opens a real (visible) browser window so you can watch it attempt
to log in and open List Orders. If it fails, open
`etm-capacity-sync.js`, find the `login()` or `openListOrders()`
function, and adjust the Playwright selectors to match what you
actually see (field names, the exact button text, etc). The scraping
logic itself (`scrapeOrders()`, reusing `page-bridge.js`) does **not**
need changes - it was built and fixed against the real ETM List
Orders table already.

## Setup

```bash
npm install playwright
npx playwright install chromium   # downloads a Chromium build, if needed
```

Never put credentials in a file that gets committed. Set them as
environment variables when running the script (or source them from a
local `.env` file that's in `.gitignore`, or a secrets manager if this
ends up running on a real server).

| Env var | Required | Default | Notes |
|---|---|---|---|
| `ETM_USERNAME` | yes | - | |
| `ETM_PASSWORD` | yes | - | |
| `ETM_BASE_URL` | no | `https://etm.panemirates.ae` | |
| `ETM_STORAGE_STATE` | no | - | path to a saved session file, see below |
| `ETM_OUTPUT_DIR` | no | `server/output` | where `capacity-<date>.json` is written |
| `PLAYWRIGHT_EXECUTABLE_PATH` | no | Playwright's bundled Chromium | only needed if that bundled browser isn't installed |

## Running it once

```bash
ETM_USERNAME=youruser ETM_PASSWORD=yourpass \
  node server/etm-capacity-sync.js --date 2026-11-14
```

Writes `server/output/capacity-2026-11-14.json`, shaped like:

```json
{
  "date": "2026-11-14",
  "generatedAt": "2026-11-14T12:47:40.668Z",
  "areas": [
    { "areaCode": "317", "areaLabel": "AUH |BANI YAS |...", "slotId": "morning",
      "slotLabel": "Morning", "fxMinutes": 103, "cbm": 4.1, "orderCount": 4 }
  ],
  "slotBudgets": [
    { "id": "morning", "label": "Morning", "window": "10:00 - 14:00" }
  ],
  "vehicleCbmCapacity": 12,
  "excludedCount": 0,
  "unresolvedCount": 0,
  "totalCount": 8
}
```

Each entry in `areas` is how much of that slot a given area has
already used. Compare `fxMinutes`/`cbm` against the matching slot's
time budget (same formula as the extension's Options page: slot
window minus the buffer minutes) and `vehicleCbmCapacity` to get the
same "Full / Near full / Open" read the Slot Capacity Monitor shows.

## Reusing a session (avoid logging in every run)

Logging in on every scheduled run is unnecessary load on ETM and
slower than it needs to be. Save a session once and reuse it:

```bash
# one-time: log in headful, save the session
ETM_USERNAME=youruser ETM_PASSWORD=yourpass ETM_STORAGE_STATE=./server/.etm-session.json \
  node server/etm-capacity-sync.js --headful

# subsequent runs: skip login entirely while the session is valid
ETM_STORAGE_STATE=./server/.etm-session.json \
  node server/etm-capacity-sync.js --date 2026-11-14
```

`.etm-session.json` holds live session cookies - keep it out of git
(already covered by `server/.gitignore`) and treat it like a
credential. When it expires, re-run the first command to refresh it.

## Scheduling

Example cron entry, every 5 minutes during business hours:

```cron
*/5 8-20 * * * cd /path/to/Breasks && ETM_STORAGE_STATE=./server/.etm-session.json node server/etm-capacity-sync.js >> /var/log/etm-sync.log 2>&1
```

## Known gaps / next steps

- **Login and date-filter selectors are unverified** - see the
  warning above. This is the main blocker to running unattended.
- **The capacity numbers come from running the same planner the Chrome
  extension uses** (`Planner.run()`), which groups ALL of a day's
  orders into a plan and reports how each area's orders landed in a
  slot. That's a reasonable stand-in, but it is not the same as a
  truly *confirmed* per-order slot assignment in ETM, since List
  Orders mostly shows orders that aren't dispatched yet. If ETM later
  exposes which slot/trip an order is actually confirmed to, swap
  `computeAreaSlotUsage()` to sum from that field directly instead of
  re-deriving it from `Planner.run()`.
- **No API was found/used for ETM** - this scrapes the web page like a
  person would. If IT confirms ETM has a real API, point this script
  (or a Odoo-side integration) at that instead; it will be faster and
  far less fragile than browser automation.
- **Nothing here talks to Odoo yet.** This script only produces the
  JSON file. Wiring it into Odoo (or into a hosted version of the Slot
  Capacity Monitor) is a separate step once the login/date-filter
  selectors are confirmed working against the real site.
