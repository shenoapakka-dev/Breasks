# Breasks – ETM Trip Planner (Pan Home)

Chrome extension (Manifest V3) that reads the order list from ETM's
**List Orders** page (`https://etm.panemirates.ae:8443/ordering/trips-plan/list-orders`)
and builds a delivery trip plan: orders are grouped by area, split across
3 daily slots and vehicle (CBM) capacity, and each trip's stops are
sequenced farthest → nearest relative to the warehouse (Al Sajaa,
Sharjah). No data leaves your browser — everything runs locally against
whatever the ETM page already shows you.

إكستنشن كروم بيقرأ جدول الأوردرات من صفحة List Orders في ETM، ويبني خطة توصيل:
يجمع الأوردرات حسب المنطقة، يوزعها على 3 سلوتات يومية وحسب سعة العربية (CBM)، ويرتّب محطات \
كل رحلة من الأبعد للأقرب من الويرهاوس (الصجه – الشارقة). كل الشغل محلي داخل المتصفح، مفيش أي بيانات بتتبعت لسيرفر خارجي.

---

## 1. Install (load unpacked)

1. Open `chrome://extensions` in Chrome/Edge.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`Breasks`, the one
   with `manifest.json` in it).
4. Pin the extension if you like (puzzle-piece icon in the toolbar).
5. On first install, a **Settings** tab opens automatically — review the
   warehouse, vehicle capacity, slots and exclusion rules, then save.

تثبيت الإكستنشن:
`chrome://extensions` ← شغّل Developer mode ← Load unpacked ← اختر فولدر `Breasks`.

## 2. Use it on the ETM page

1. Go to the **List Orders** page and set your filters as usual
   (Delivery Date, Del Only, Finance Blocked, etc.) — the extension plans
   whatever the page is currently showing, it does not change your filters.
2. A floating **Breaks – Trip Planner** panel appears on the page
   (drag it by its header, or click `–`/`+` to collapse).
3. Click **Scan + Build Plan**.
   - It first tries to read *all* matching orders in one shot (works when
     the table is a client-side DataTables grid).
   - If that's not available, it automatically pages through the table
     for you and collects every row — this can take a little longer for
     ~1,600+ orders.
4. Review the results:
   - **Unmapped area values** (yellow box): the ETM `Area` column had a
     value the bundled area-code table doesn't recognize. Pick the right
     area from the dropdown once and click **Save** — it's remembered for
     next time (stored in this browser via `chrome.storage`).
   - **Excluded**: order types dropped entirely (UK/QT/MT by default).
     Sales Return orders (Notes with "R", or an `RW` order number) are
     **not** excluded — they stay on the route and are tagged so the team
     collects the return at that stop; look for a yellow note badge.
   - **No-slot-fits** (yellow box): an order's Notes asked for a delivery
     time no configured slot can satisfy (e.g. "after 9pm") — adjust the
     slot windows in Settings or handle these separately.
   - **Trips**: each trip is one vehicle for the day, shown as up to 3
     legs — Morning, Afternoon, Evening — run back-to-back with a return
     to the warehouse between each. A leg shows its stop sequence
     (farthest → nearest), CBM load, estimated time vs. that slot's
     budget, any delivery-time notes (highlighted), and a warning if it's
     over capacity/time or simply too far to fit any single slot.
   - Delivery-time requests in Notes steer which slot an order lands in:
     a note containing "MORNING"/"AFTERNOON"/"EVENING", or "BEFORE Xpm"/
     "AFTER Xpm", restricts that order to the slot(s) compatible with it
     instead of letting the area-based balancer place it anywhere.
5. Export:
   - **Export CSV** — one row per order with its slot/trip/stop assignment,
     for Excel.
   - **Print / Save PDF** — opens a print-style report per trip (Trip #,
     stop sequence, order list with sequence numbers, totals), similar to
     ETM's own Trip Report layout. Use the browser's print dialog to save
     as PDF or print directly.
   - **Copy order #s** on any trip card — copies that trip's order numbers
     (in stop sequence) to the clipboard, ready to paste wherever ETM asks
     you to assign orders to a trip.

> This version does **not** write back into ETM automatically (no
> internal API was available to integrate with) — it produces the plan
> for you to apply through ETM's own trip-assignment screen, or via the
> CSV/clipboard export above.

## 3. Settings (Options page)

Click the ⚙ icon in the panel header, or `chrome://extensions` → Breaks
→ **Details** → **Extension options**.

| Setting | Default | Notes |
|---|---|---|
| Warehouse area code | `122` – Al Sajaa, Sharjah (Pan Home DC) | All distance/route ordering is relative to this. |
| Vehicle CBM capacity | `12` | Per-trip volume ceiling used when bin-packing. |
| Average speed | `45 km/h` | Converts the distance table's km into travel minutes. |
| Slots | Morning 10:00–14:00, Afternoon 14:00–17:00, Evening 17:00–20:00 | Editable times. |
| Slot buffer | `20` min | Safety margin subtracted from each slot's window. |
| Excluded order prefixes | `UK, QT, MT` | Orders whose number starts with one of these are dropped entirely. |
| Sales Return prefixes | `RW` | Order numbers starting with these are treated as returns and dropped. |
| Sales Return notes pattern | `\bR\b\|RETURN` (regex, case-insensitive) | If the order's Notes match this, it's dropped as a return. Adjust if your "R" marker shows up differently in practice. |
| Area mapping overrides | — | Built up as you resolve unmapped areas from the panel; removable here. |
| Area code reference | — | Full searchable table of every area code bundled in the extension, with its approximate km from the warehouse. |

## 4. How the plan is built (what to know before trusting it)

- **Area → distance table**: built from the Area Codes reference you
  provided (all emirates). The `distanceKm` per area is a **hand-estimated
  approximate road distance** from the warehouse, not pulled from a mapping
  API — good enough to sequence stops sensibly (farthest first, working
  back toward base) and to balance trips across slots, but treat it as an
  approximation. Adjust any value from the Options page's reference table
  if you have better numbers (edit `data/area_codes.json` and re-run
  `scripts/build_area_data.py`, or extend the Options page to allow
  per-area edits if you need that in daily use).
- **Area resolution**: the ETM `Area` column value is matched against the
  area-code table by exact match (with light normalization). If your ETM
  instance uses a *different* internal numbering per Sales Office (we saw
  short codes like `007`/`022` in a sample screenshot that don't match the
  emirate-wide table), those will show up as **unmapped** — map them once
  from the panel and the extension remembers the mapping.
- **Capacity**: each trip respects the CBM capacity AND a time budget
  (sum of each order's `FxTime`/fixing minutes + estimated travel time
  between stops, against the slot's window minus the buffer). A trip that
  can't fit a far single stop within a short slot is flagged **OVER
  CAPACITY/TIME** rather than silently produced — that's a real
  constraint for a human planner to resolve (split across more time, or
  give that stop its own trip).
- **Exclusions**: Sales Returns (Notes matching the return pattern, or
  order numbers starting with `RW`) and excluded order types (`UK`, `QT`,
  `MT` by default) are removed before planning, and shown in the Excluded
  summary so nothing disappears silently.

## 5. Project structure

```
manifest.json            MV3 manifest
background.js            opens Options on install, relays "open options" messages
data/
  source/                the original Area Codes xlsx (kept for re-generation)
  area_codes.json         generated area-code + distance reference (human-readable)
  area_codes.js            same data as a content-script-loadable global
lib/planner.js             core planning engine (filter, resolve, bin-pack, sequence)
content/
  page-bridge.js            runs in the page's own JS context to read DataTables fast
  content.js                scraping orchestration + floating panel UI
  panel.css                 panel styling
options/
  options.html/.js/.css     settings page
scripts/build_area_data.py  regenerates data/area_codes.(json|js) from the source xlsx
icons/                      toolbar icons
```

## 6. Re-generating the area/distance data

If you get a better area-code table or more accurate distances later:

```bash
python3 -m pip install --user openpyxl   # if not already available
python3 scripts/build_area_data.py
```

This reads `data/source/Area_Codes_All_Emirates.xlsx` and rewrites
`data/area_codes.json` and `data/area_codes.js`.
