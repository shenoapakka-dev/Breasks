/**
 * Breasks ETM Trip Planner - content script (isolated world).
 * Injected on https://etm.panemirates.ae:8443/ordering/trips-plan/*
 *
 * Responsibilities:
 *  - get order rows off the page (fast path via page-bridge.js + DataTables,
 *    fallback: click through pagination and scrape the rendered table)
 *  - map raw rows to order objects
 *  - run them through BreaksPlanner
 *  - render a floating panel with results + exports
 */
(function () {
  "use strict";

  const AREA_DATA = window.BREAKS_AREA_DATA;
  const Planner = window.BreaksPlanner;

  const FIELD_ALIASES = {
    order: ["order"],
    ordDate: ["orddate"],
    acc: ["acc"],
    div: ["div"],
    salesOffice: ["salesoffice"],
    area: ["area"],
    customer: ["customer"],
    dtime: ["dtime"],
    trip: ["trip"],
    fxTime: ["fxtime"],
    volume: ["volume"],
    value: ["value"],
    notes: ["notes"],
    status: ["status"],
  };

  let lastOrders = []; // raw parsed orders from the page
  let lastRunResult = null; // output of Planner.run
  let settings = null;
  let areaOverrides = {};

  // ---------- storage ----------

  function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["breaksSettings", "areaOverrides"], (data) => {
        settings = Planner.loadSettings(data.breaksSettings);
        areaOverrides = data.areaOverrides || {};
        resolve();
      });
    });
  }

  function saveAreaOverride(rawValue, code) {
    areaOverrides[rawValue] = code;
    chrome.storage.local.set({ areaOverrides });
  }

  // ---------- scraping: fast path via page-bridge ----------

  function requestBridgeScrape(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      function onResponse(e) {
        if (done) return;
        done = true;
        document.removeEventListener("breaks:scrape-response", onResponse);
        resolve(e.detail);
      }
      document.addEventListener("breaks:scrape-response", onResponse);
      document.dispatchEvent(new CustomEvent("breaks:scrape-request"));
      setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener("breaks:scrape-response", onResponse);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
    });
  }

  // ---------- scraping: DOM fallback (click through pagination) ----------

  function normKey(s) {
    return (s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findOrdersTableInDom() {
    const tables = Array.from(document.querySelectorAll("table"));
    for (const t of tables) {
      const head = t.querySelector("thead");
      if (!head) continue;
      const text = head.textContent.toLowerCase();
      if (text.includes("order") && text.includes("area") && text.includes("customer")) {
        return t;
      }
    }
    return null;
  }

  function readHeaderMap(table) {
    const ths = Array.from(table.querySelectorAll("thead th"));
    const map = {};
    ths.forEach((th, i) => {
      const key = normKey(th.textContent);
      if (key) map[key] = i;
    });
    return map;
  }

  function readVisibleRows(table) {
    const body = table.querySelector("tbody");
    if (!body) return [];
    return Array.from(body.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent.trim())
    );
  }

  // No DevTools needed: dumps the header row + first couple of body rows
  // (both their visible text AND raw inner HTML per cell) into the panel
  // itself, so a screenshot of the panel is enough to diagnose a column
  // mismatch without anyone having to open the browser console.
  function debugDumpTable() {
    const table = findOrdersTableInDom();
    if (!table) return { ok: false, text: "Orders table not found on this page." };
    const ths = Array.from(table.querySelectorAll("thead th"));
    const lines = [];
    lines.push("HEADERS (index: text):");
    ths.forEach((th, i) => lines.push(`  [${i}] "${(th.textContent || "").trim()}"`));
    lines.push("");
    lines.push("headerMap (normalized -> index): " + JSON.stringify(readHeaderMap(table)));
    lines.push("");
    const body = table.querySelector("tbody");
    const firstRows = body ? Array.from(body.querySelectorAll("tr")).slice(0, 2) : [];
    if (!firstRows.length) lines.push("(no rows currently rendered in the table body)");
    firstRows.forEach((tr, rIdx) => {
      lines.push(`ROW ${rIdx}:`);
      Array.from(tr.children).forEach((td, i) => {
        const text = (td.textContent || "").trim();
        const html = (td.innerHTML || "").slice(0, 150);
        lines.push(`  [${i}] text="${text}"  html="${html}"`);
      });
      lines.push("");
    });
    return { ok: true, text: lines.join("\n") };
  }

  function findNextPageControl(table) {
    // Typical DataTables pagination: a container near the table with an
    // <a>/<li> whose text is "Next" and whose parent isn't ".disabled".
    const container = table.closest(".dataTables_wrapper") || table.parentElement || document;
    const candidates = Array.from(container.querySelectorAll("a, li, button")).filter((el) =>
      /^next$/i.test((el.textContent || "").trim())
    );
    for (const cand of candidates) {
      const li = cand.closest("li") || cand;
      if (li.classList.contains("disabled") || cand.getAttribute("aria-disabled") === "true") {
        return null;
      }
      return cand.tagName === "LI" ? cand.querySelector("a") || cand : cand;
    }
    return null;
  }

  function waitForTbodyChange(table, timeoutMs) {
    return new Promise((resolve) => {
      const body = table.querySelector("tbody");
      if (!body) return resolve(false);
      const before = body.innerHTML;
      const obs = new MutationObserver(() => {
        if (body.innerHTML !== before) {
          obs.disconnect();
          resolve(true);
        }
      });
      obs.observe(body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(body.innerHTML !== before);
      }, timeoutMs);
    });
  }

  async function scrapeViaDomPagination(onProgress) {
    const table = findOrdersTableInDom();
    if (!table) return { ok: false, error: "table-not-found" };
    const headerMap = readHeaderMap(table);
    const rows = [];
    const seen = new Set();
    let guard = 0;
    while (guard++ < 400) {
      const pageRows = readVisibleRows(table);
      for (const r of pageRows) {
        const key = r.join("|");
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(r);
        }
      }
      if (onProgress) onProgress(rows.length);
      const next = findNextPageControl(table);
      if (!next) break;
      next.click();
      const changed = await waitForTbodyChange(table, 4000);
      if (!changed) break;
    }
    return { ok: true, headerMap, rows, count: rows.length };
  }

  // ---------- normalize raw rows -> order objects ----------

  function buildFieldIndex(headerMap) {
    const idx = {};
    const keys = Object.keys(headerMap);
    for (const field of Object.keys(FIELD_ALIASES)) {
      for (const alias of FIELD_ALIASES[field]) {
        if (headerMap[alias] !== undefined) {
          idx[field] = headerMap[alias];
          break;
        }
        // ETM bakes a filter row (text input or a <select> with many
        // <option>s) into each <th>, so th.textContent often comes back
        // as the real label with extra characters or a whole dropdown's
        // option list appended straight after it - e.g. "Order" reads as
        // "Orderx", "SalesOffice" reads as "SalesOfficeAllOffices...".
        // The real label is always the prefix, so match on that instead
        // of requiring an exact (and therefore fragile) equality.
        const prefixMatch = keys.find((k) => k.indexOf(alias) === 0);
        if (prefixMatch !== undefined) {
          idx[field] = headerMap[prefixMatch];
          break;
        }
      }
    }
    return idx;
  }

  function parseNumber(s) {
    if (s === null || s === undefined || s === "") return 0;
    const cleaned = String(s).replace(/,/g, "").trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }

  function rowsToOrders(headerMap, rows) {
    const idx = buildFieldIndex(headerMap);
    const missing = Object.keys(FIELD_ALIASES).filter((f) => idx[f] === undefined);
    const orders = rows.map((r) => ({
      order: r[idx.order] || "",
      ordDate: r[idx.ordDate] || "",
      acc: r[idx.acc] || "",
      div: r[idx.div] || "",
      salesOffice: r[idx.salesOffice] || "",
      area: (r[idx.area] || "").trim(),
      customer: r[idx.customer] || "",
      dtime: r[idx.dtime] || "",
      trip: r[idx.trip] || "",
      fxTime: parseNumber(r[idx.fxTime]),
      volume: parseNumber(r[idx.volume]),
      value: parseNumber(r[idx.value]),
      notes: r[idx.notes] || "",
      status: r[idx.status] || "",
    }));
    return { orders, missingFields: missing };
  }

  // ---------- main scrape entry point ----------

  async function scrapeOrders(ui) {
    ui.setStatus("Reading orders from the page...");
    // The fast path now makes DataTables render every row to the DOM
    // before reading it (for correctness - see page-bridge.js), which
    // can take a few seconds for ~1,600+ rows, so give it real room.
    const fast = await requestBridgeScrape(15000);
    if (fast.ok) {
      ui.setStatus(`Loaded ${fast.count} orders (fast path).`);
      return rowsToOrders(fast.headerMap, fast.rows);
    }

    ui.setStatus(
      `Fast read unavailable (${fast.error || "unknown"}). Paging through the table - this can take a moment...`
    );
    const slow = await scrapeViaDomPagination((n) => ui.setStatus(`Collected ${n} orders so far...`));
    if (!slow.ok) {
      ui.setStatus("Could not find the orders table on this page.");
      return { orders: [], missingFields: [] };
    }
    ui.setStatus(`Loaded ${slow.count} orders (page-by-page).`);
    return rowsToOrders(slow.headerMap, slow.rows);
  }

  // ---------- plan execution ----------

  function runPlan() {
    lastRunResult = Planner.run(lastOrders, AREA_DATA, settings, areaOverrides);
    return lastRunResult;
  }

  // ---------- export helpers ----------

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function csvEscape(v) {
    const s = String(v === undefined || v === null ? "" : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv(runResult) {
    const rows = [
      [
        "Trip#",
        "Slot",
        "StopSeq",
        "AreaCode",
        "AreaLabel",
        "DistanceKm",
        "Order",
        "Customer",
        "Volume",
        "FxTime",
        "Value",
        "ReturnPickup",
        "Notes",
      ],
    ];
    for (const vehicle of runResult.plan.vehicles) {
      for (const leg of vehicle.legs) {
        if (!leg.trip) continue;
        let stopSeq = 0;
        for (const stop of leg.trip.stops) {
          stopSeq++;
          for (const o of stop.orders) {
            rows.push([
              vehicle.vehicleNo,
              leg.slotLabel,
              stopSeq,
              stop.areaCode,
              stop.areaLabel,
              stop.distanceKm,
              o.order,
              o.customer,
              o.volume,
              o.fxTime,
              o.value,
              o.isReturn ? "Y" : "",
              o.notes || "",
            ]);
          }
        }
      }
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    downloadText("trip-plan.csv", csv, "text/csv;charset=utf-8");
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function buildPrintReportHtml(runResult, dateLabel, onlyVehicleNo) {
    const vehicles = onlyVehicleNo
      ? runResult.plan.vehicles.filter((v) => v.vehicleNo === onlyVehicleNo)
      : runResult.plan.vehicles;

    const vehicleBlocks = vehicles.map((vehicle) => {
      const legBlocks = vehicle.legs
        .map((leg) => {
          if (!leg.trip) {
            return `<p class="leg-empty"><b>${leg.slotLabel} (${leg.window}):</b> no run</p>`;
          }
          const trip = leg.trip;
          const orderLines = [];
          for (const stop of trip.stops) {
            for (const o of stop.orders) {
              const parts = [escapeHtml(o.order), leg.slotLabel];
              if (o.isReturn) parts.push("RETURN PICKUP");
              let line = parts.join(" | ");
              if (o.notes) {
                line += ` <span class="note-badge">${escapeHtml(o.notes)}</span>`;
              }
              orderLines.push(`<div class="order-line">${line}</div>`);
            }
          }
          const destLabel = trip.stops
            .map((s) => s.areaCode)
            .filter((v, i, arr) => arr.indexOf(v) === i)
            .join(" | ");
          return `
            <div class="leg-block">
              <p><b>${leg.slotLabel} (${leg.window})</b> — ${destLabel}
                ${
                  trip.longHaul
                    ? ' <span class="warn">TOO FAR FOR ONE SLOT</span>'
                    : trip.totalCbm > settings.vehicleCbmCapacity
                    ? ' <span class="warn">OVER CBM CAPACITY</span>'
                    : trip.overBudget
                    ? ' <span class="warn">RUNS PAST SLOT TIME</span>'
                    : ""
                }
              </p>
              <p class="stops">Stops (farthest → nearest): ${trip.stops
                .map((s) => `${s.areaCode} (${s.distanceKm}km)`)
                .join(" → ")}</p>
              <div class="orders">${orderLines.join("\n")}</div>
              <p class="totals">CBM: ${trip.totalCbm.toFixed(2)} &nbsp; Fixing min: ${Math.round(
            trip.totalFxMinutes
          )} &nbsp; Est. time: ${trip.totalMinutes}/${trip.budgetMinutes} min &nbsp; Value: ${trip.totalValue.toFixed(
            2
          )} &nbsp; Orders: ${trip.orderCount}${trip.returnCount ? ` (${trip.returnCount} return)` : ""}</p>
            </div>`;
        })
        .join("\n");
      return `
        <div class="trip-block">
          <h2>Trip ${vehicle.vehicleNo}</h2>
          ${legBlocks}
        </div>`;
    });

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Trip Plan ${dateLabel || ""}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 24px; }
  h1 { font-size: 20px; text-align:center; }
  h2 { font-size: 16px; color: #15479b; margin-bottom: 6px; }
  .trip-block { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #ccc; page-break-after: always; }
  .trip-block:last-child { page-break-after: auto; border-bottom: none; }
  .leg-block { margin: 6px 0 10px 10px; padding-left: 10px; border-left: 3px solid #d7dee8; }
  .leg-empty { margin: 6px 0 10px 10px; padding-left: 10px; color: #8a97ad; border-left: 3px solid #eef2f9; }
  .stops { color: #46536b; }
  .orders { margin: 4px 0; }
  .order-line { font-size: 12px; padding: 1px 0; }
  .note-badge { display: inline-block; background: #fff3b0; border: 1px solid #e0c200; border-radius: 4px; padding: 1px 6px; margin-left: 4px; font-size: 11px; }
  .warn { color: #c62828; font-weight: bold; }
</style>
</head><body>
<h1>Trip Plan${dateLabel ? " - " + dateLabel : ""}</h1>
${vehicleBlocks.join("\n")}
</body></html>`;
  }

  function openPrintReport(runResult, onlyVehicleNo) {
    const html = buildPrintReportHtml(runResult, new Date().toISOString().slice(0, 10), onlyVehicleNo);
    const w = window.open("", "_blank");
    if (!w) {
      alert("Please allow pop-ups to open the print view.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function copyTripOrders(trip) {
    let seq = 0;
    const parts = [];
    for (const stop of trip.stops) {
      for (const o of stop.orders) {
        seq++;
        parts.push(`${o.order}(${seq})${o.isReturn ? "[R]" : ""}`);
      }
    }
    const text = parts.join(" , ");
    navigator.clipboard.writeText(text).catch(() => {
      /* clipboard may be unavailable in some contexts; silently ignore */
    });
    return text;
  }

  // ---------- UI ----------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2), attrs[k]);
        } else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function buildUnresolvedSection(unresolved, onResolved) {
    if (!unresolved.length) return null;
    const uniqueRaw = Array.from(new Set(unresolved.map((o) => o.area)));
    const emirateGroups = {};
    for (const code of Object.keys(AREA_DATA.areas)) {
      const a = AREA_DATA.areas[code];
      (emirateGroups[a.emirate] = emirateGroups[a.emirate] || []).push(a);
    }

    const rows = uniqueRaw.map((raw) => {
      const select = el("select", { class: "breaks-select" }, [
        el("option", { value: "" }, ["-- pick area --"]),
        ...Object.keys(emirateGroups).map((em) =>
          el(
            "optgroup",
            { label: em },
            emirateGroups[em]
              .sort((a, b) => a.distanceKm - b.distanceKm)
              .map((a) => el("option", { value: a.code }, [`${a.code} - ${a.label}`]))
          )
        ),
      ]);
      const btn = el("button", { class: "breaks-btn-sm" }, ["Save"]);
      btn.addEventListener("click", () => {
        if (!select.value) return;
        saveAreaOverride(raw, select.value);
        onResolved();
      });
      const count = unresolved.filter((o) => o.area === raw).length;
      return el("div", { class: "breaks-unresolved-row" }, [
        el("span", { class: "breaks-unresolved-raw" }, [`"${raw}" (${count} orders)`]),
        select,
        btn,
      ]);
    });

    return el("div", { class: "breaks-section breaks-unresolved" }, [
      el("div", { class: "breaks-section-title" }, [
        `⚠ ${uniqueRaw.length} unmapped area value(s), ${unresolved.length} order(s) - map once, it is remembered`,
      ]),
      ...rows,
    ]);
  }

  function buildExcludedSection(excluded) {
    if (!excluded.length) return null;
    return el("div", { class: "breaks-section" }, [
      el("div", { class: "breaks-section-title" }, [
        `Excluded (order type not planned): ${excluded.length}`,
      ]),
    ]);
  }

  function buildNoFeasibleSlotSection(orders) {
    if (!orders.length) return null;
    return el("div", { class: "breaks-section breaks-unresolved" }, [
      el("div", { class: "breaks-section-title" }, [
        `⚠ ${orders.length} order(s) request a delivery time that doesn't fit any configured slot`,
      ]),
      ...orders.map((o) =>
        el("div", { class: "breaks-unresolved-row" }, [
          el("span", { class: "breaks-unresolved-raw" }, [
            `${o.order}: "${o.notes}"${o.notePreferenceLabel ? " → " + o.notePreferenceLabel : ""}`,
          ]),
        ])
      ),
      el("div", { class: "breaks-hint" }, [
        "Adjust the slot windows in Settings, or deliver these separately.",
      ]),
    ]);
  }

  function notesForLeg(trip) {
    const notes = [];
    for (const stop of trip.stops) {
      for (const o of stop.orders) {
        if (o.notes) notes.push({ order: o.order, note: o.notes });
      }
    }
    return notes;
  }

  function buildLegBlock(leg) {
    if (!leg.trip) {
      return el("div", { class: "breaks-leg breaks-leg-empty" }, [
        el("div", { class: "breaks-leg-head" }, [`${leg.slotLabel} (${leg.window})`, " — no run"]),
      ]);
    }
    const trip = leg.trip;
    const stopsText = trip.stops
      .map(
        (s) =>
          `${s.areaCode} (${s.distanceKm}km, ${s.orders.length} ord${
            s.returnCount ? `, ${s.returnCount} return` : ""
          })`
      )
      .join(" → ");
    const copyBtn = el("button", { class: "breaks-btn-sm" }, ["Copy order #s"]);
    copyBtn.addEventListener("click", () => {
      copyTripOrders(trip);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy order #s"), 1200);
    });
    const legNotes = notesForLeg(trip);
    const notesBlock = legNotes.length
      ? el(
          "div",
          { class: "breaks-leg-notes" },
          legNotes.map((n) => el("div", { class: "breaks-note-badge" }, [`${n.order}: ${n.note}`]))
        )
      : null;
    return el("div", { class: "breaks-leg" + (trip.overBudget ? " breaks-over" : "") }, [
      el("div", { class: "breaks-leg-head" }, [
        el("b", {}, [`${leg.slotLabel} (${leg.window})`]),
        ` — ${trip.orderCount} orders${trip.returnCount ? ` (${trip.returnCount} return pickups)` : ""}, ${trip.totalCbm.toFixed(
          2
        )} CBM, ${trip.totalMinutes}/${trip.budgetMinutes} min`,
        trip.longHaul
          ? el("span", { class: "breaks-warn" }, [" TOO FAR FOR ONE SLOT — needs a dedicated/longer trip"])
          : trip.totalCbm > settings.vehicleCbmCapacity
          ? el("span", { class: "breaks-warn" }, [" OVER CBM CAPACITY"])
          : trip.overBudget
          ? el("span", { class: "breaks-warn" }, [" RUNS PAST SLOT TIME — one vehicle, just takes longer"])
          : null,
      ]),
      el("div", { class: "breaks-trip-stops" }, [stopsText]),
      notesBlock,
      copyBtn,
    ]);
  }

  function buildVehicleCard(vehicle) {
    const legs = vehicle.legs.map(buildLegBlock);
    return el("div", { class: "breaks-vehicle-card" + (vehicle.overBudget ? " breaks-over" : "") }, [
      el("div", { class: "breaks-vehicle-head" }, [
        el("b", {}, [`Trip ${vehicle.vehicleNo}`]),
        ` — ${vehicle.orderCount} orders for the day${
          vehicle.returnCount ? ` (${vehicle.returnCount} return pickups)` : ""
        }`,
      ]),
      ...legs,
    ]);
  }

  function renderResults(container, runResult) {
    container.innerHTML = "";
    const summary = el("div", { class: "breaks-summary" }, [
      `${runResult.totalCount} total → ${runResult.keptCount} planned, ${runResult.excluded.length} excluded, ${runResult.unresolved.length} unmapped, ${runResult.noFeasibleSlot.length} no-slot-fits`,
    ]);
    container.appendChild(summary);

    const unresolvedSection = buildUnresolvedSection(runResult.unresolved, () => {
      const fresh = runPlan();
      renderResults(container, fresh);
    });
    if (unresolvedSection) container.appendChild(unresolvedSection);

    const excludedSection = buildExcludedSection(runResult.excluded);
    if (excludedSection) container.appendChild(excludedSection);

    const noFeasibleSection = buildNoFeasibleSlotSection(runResult.noFeasibleSlot);
    if (noFeasibleSection) container.appendChild(noFeasibleSection);

    const vehiclesSection = el("div", { class: "breaks-section" }, [
      el("div", { class: "breaks-section-title" }, [
        `Trips (each runs Morning → Afternoon → Evening): ${runResult.plan.vehicles.length}`,
      ]),
      ...runResult.plan.vehicles.map(buildVehicleCard),
    ]);
    container.appendChild(vehiclesSection);

    const tripSelect = el("select", { class: "breaks-select breaks-trip-select" }, [
      el("option", { value: "" }, ["All trips (each on its own page)"]),
      ...runResult.plan.vehicles.map((v) => el("option", { value: String(v.vehicleNo) }, [`Trip ${v.vehicleNo} only`])),
    ]);
    const exportRow = el("div", { class: "breaks-export-row" }, [
      el("button", { class: "breaks-btn", onclick: () => exportCsv(runResult) }, ["Export CSV"]),
      tripSelect,
      el(
        "button",
        {
          class: "breaks-btn",
          onclick: () => openPrintReport(runResult, tripSelect.value ? parseInt(tripSelect.value, 10) : null),
        },
        ["Print / Save PDF"]
      ),
    ]);
    container.appendChild(exportRow);
  }

  // ---------- imported Trip Report (PDF) cross-reference ----------

  function orderLineHtml(o, slotLabel) {
    const parts = [escapeHtml(o.order)];
    if (slotLabel) parts.push(slotLabel);
    if (o.isReturn) parts.push("RETURN PICKUP");
    let line = parts.join(" | ");
    if (o.notes) line += ` <span class="note-badge">${escapeHtml(o.notes)}</span>`;
    return line;
  }

  function buildImportedTripCard(trip) {
    const orderRows = trip.orders.map((o) =>
      el("div", { class: "breaks-order-line", html: orderLineHtml(o) })
    );
    return el(
      "div",
      { class: "breaks-vehicle-card" + (trip.mixedAreas ? " breaks-over" : "") },
      [
        el("div", { class: "breaks-vehicle-head" }, [
          el("b", {}, [`Trip ${trip.tripNumber}`]),
          ` — ${trip.teamName || trip.team || ""} — ${trip.destination || ""} — ${trip.orders.length} orders, ${trip.totalCbm.toFixed(
            2
          )} CBM${trip.returnCount ? `, ${trip.returnCount} return pickups` : ""}`,
          trip.mixedAreas
            ? el("span", { class: "breaks-warn" }, [
                ` ⚠ MIXED AREAS (${trip.areaCodes.join(", ")}, ~${trip.distanceSpreadKm}km apart) — double-check this trip`,
              ])
            : null,
        ]),
        ...orderRows,
      ]
    );
  }

  function exportImportedCsv(crossRefResult) {
    const rows = [
      [
        "Trip#",
        "Team",
        "TeamName",
        "Destination(PDF)",
        "Order",
        "AreaCode",
        "Customer",
        "Volume",
        "FxTime",
        "Value",
        "ReturnPickup",
        "Notes",
      ],
    ];
    for (const trip of crossRefResult.trips) {
      for (const o of trip.orders) {
        rows.push([
          trip.tripNumber,
          trip.team || "",
          trip.teamName || "",
          trip.destination || "",
          o.order,
          o.resolvedAreaCode || "",
          o.customer,
          o.volume,
          o.fxTime,
          o.value,
          o.isReturn ? "Y" : "",
          o.notes || "",
        ]);
      }
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    downloadText("imported-trip-report.csv", csv, "text/csv;charset=utf-8");
  }

  function buildImportedPrintReportHtml(crossRefResult, dateLabel, onlyTripNo) {
    const trips = onlyTripNo
      ? crossRefResult.trips.filter((t) => t.tripNumber === onlyTripNo)
      : crossRefResult.trips;

    const blocks = trips.map((trip) => {
      const orderLines = trip.orders.map((o) => `<div class="order-line">${orderLineHtml(o)}</div>`).join("\n");
      return `
        <div class="trip-block">
          <h2>Trip ${trip.tripNumber} — ${escapeHtml(trip.teamName || trip.team || "")}</h2>
          <p class="stops">Destination (from ETM): ${escapeHtml(trip.destination || "")}
            ${
              trip.mixedAreas
                ? ` <span class="warn">MIXED AREAS (${trip.areaCodes.join(", ")}, ~${trip.distanceSpreadKm}km apart)</span>`
                : ""
            }
          </p>
          <div class="orders">${orderLines}</div>
          <p class="totals">CBM: ${trip.totalCbm.toFixed(2)} &nbsp; Fixing min: ${Math.round(
        trip.totalFxMinutes
      )} &nbsp; Value: ${trip.totalValue.toFixed(2)} &nbsp; Orders: ${trip.orders.length}${
        trip.returnCount ? ` (${trip.returnCount} return)` : ""
      }</p>
        </div>`;
    });

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Imported Trip Report ${dateLabel || ""}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 24px; }
  h1 { font-size: 20px; text-align:center; }
  h2 { font-size: 16px; color: #15479b; margin-bottom: 6px; }
  .trip-block { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #ccc; page-break-after: always; }
  .trip-block:last-child { page-break-after: auto; border-bottom: none; }
  .stops { color: #46536b; }
  .orders { margin: 4px 0; }
  .order-line { font-size: 12px; padding: 1px 0; }
  .note-badge { display: inline-block; background: #fff3b0; border: 1px solid #e0c200; border-radius: 4px; padding: 1px 6px; margin-left: 4px; font-size: 11px; }
  .warn { color: #c62828; font-weight: bold; }
</style>
</head><body>
<h1>Imported Trip Report${dateLabel ? " - " + dateLabel : ""}</h1>
${blocks.join("\n")}
</body></html>`;
  }

  function openImportedPrintReport(crossRefResult, onlyTripNo) {
    const html = buildImportedPrintReportHtml(crossRefResult, new Date().toISOString().slice(0, 10), onlyTripNo);
    const w = window.open("", "_blank");
    if (!w) {
      alert("Please allow pop-ups to open the print view.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function renderImportedResults(container, crossRefResult) {
    container.innerHTML = "";
    const mixedCount = crossRefResult.trips.filter((t) => t.mixedAreas).length;
    const summary = el("div", { class: "breaks-summary" }, [
      `${crossRefResult.matchedCount} orders matched to ${crossRefResult.trips.length} imported trips, ${crossRefResult.notFoundInLive.length} not found live, ${mixedCount} trip(s) with mixed areas`,
    ]);
    container.appendChild(summary);

    if (crossRefResult.notFoundInLive.length) {
      container.appendChild(
        el("div", { class: "breaks-section" }, [
          el("div", { class: "breaks-section-title" }, [
            `${crossRefResult.notFoundInLive.length} order(s) from the PDF were not found on the current List Orders page (may be delivered/removed already)`,
          ]),
        ])
      );
    }

    const tripsSection = el("div", { class: "breaks-section" }, [
      el("div", { class: "breaks-section-title" }, [`Imported trips: ${crossRefResult.trips.length}`]),
      ...crossRefResult.trips.map(buildImportedTripCard),
    ]);
    container.appendChild(tripsSection);

    const tripSelect = el("select", { class: "breaks-select breaks-trip-select" }, [
      el("option", { value: "" }, ["All trips (each on its own page)"]),
      ...crossRefResult.trips.map((t) => el("option", { value: String(t.tripNumber) }, [`Trip ${t.tripNumber} only`])),
    ]);
    const exportRow = el("div", { class: "breaks-export-row" }, [
      el("button", { class: "breaks-btn", onclick: () => exportImportedCsv(crossRefResult) }, ["Export CSV"]),
      tripSelect,
      el(
        "button",
        {
          class: "breaks-btn",
          onclick: () =>
            openImportedPrintReport(crossRefResult, tripSelect.value ? parseInt(tripSelect.value, 10) : null),
        },
        ["Print / Save PDF"]
      ),
    ]);
    container.appendChild(exportRow);
  }

  function buildPanel() {
    const panel = el("div", { id: "breaks-panel" }, []);
    const header = el("div", { class: "breaks-header" }, [
      el("span", { class: "breaks-title" }, ["Breaks – Trip Planner"]),
      el(
        "button",
        {
          class: "breaks-icon-btn",
          title: "Settings",
          onclick: () => chrome.runtime.sendMessage({ type: "open-options" }),
        },
        ["⚙"]
      ),
      el("button", { class: "breaks-icon-btn", id: "breaks-toggle" }, ["–"]),
    ]);
    const body = el("div", { class: "breaks-body" }, []);
    const status = el("div", { class: "breaks-status" }, ["Ready."]);
    const actions = el("div", { class: "breaks-actions" }, [
      el(
        "button",
        {
          class: "breaks-btn breaks-btn-primary",
          onclick: async () => {
            const ui = { setStatus: (t) => (status.textContent = t) };
            const { orders, missingFields } = await scrapeOrders(ui);
            lastOrders = orders;
            if (missingFields.length) {
              ui.setStatus(
                `Loaded ${orders.length} rows, but could not find column(s): ${missingFields.join(
                  ", "
                )}. Check the table headers match what this extension expects.`
              );
            }
            const result = runPlan();
            renderResults(results, result);
            if (!missingFields.length) {
              ui.setStatus(`Plan built from ${orders.length} orders.`);
            }
          },
        },
        ["Scan + Build Plan"]
      ),
      el(
        "button",
        {
          class: "breaks-btn",
          onclick: () => window.open(chrome.runtime.getURL("import/import.html"), "_blank"),
        },
        ["Import Trip Report PDF"]
      ),
      el(
        "button",
        {
          class: "breaks-btn",
          onclick: async () => {
            const ui = { setStatus: (t) => (status.textContent = t) };
            if (!lastOrders.length) {
              const { orders } = await scrapeOrders(ui);
              lastOrders = orders;
            }
            chrome.storage.local.get(["importedTripMap", "importedTripMapDate"], (data) => {
              if (!data.importedTripMap || !Object.keys(data.importedTripMap).length) {
                ui.setStatus('No imported Trip Report yet - click "Import Trip Report PDF" first.');
                return;
              }
              const crossRef = Planner.crossReferenceImport(
                data.importedTripMap,
                lastOrders,
                AREA_DATA,
                settings,
                areaOverrides
              );
              renderImportedResults(results, crossRef);
              ui.setStatus(
                `Cross-checked imported Trip Report (${data.importedTripMapDate || "unknown date"}) against ${lastOrders.length} live orders.`
              );
            });
          },
        },
        ["Use Imported Trip Report"]
      ),
      el(
        "button",
        {
          class: "breaks-btn",
          onclick: () => {
            const dump = debugDumpTable();
            results.innerHTML = "";
            results.appendChild(
              el("div", { class: "breaks-section" }, [
                el("div", { class: "breaks-section-title" }, ["Debug: table structure (screenshot this)"]),
                el("pre", { class: "breaks-debug" }, [dump.text]),
              ])
            );
          },
        },
        ["Debug Table"]
      ),
    ]);
    const results = el("div", { class: "breaks-results" }, []);

    body.appendChild(status);
    body.appendChild(actions);
    body.appendChild(results);
    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    header.querySelector("#breaks-toggle").addEventListener("click", () => {
      const collapsed = body.style.display === "none";
      body.style.display = collapsed ? "" : "none";
      header.querySelector("#breaks-toggle").textContent = collapsed ? "–" : "+";
    });

    // basic drag support
    let dragging = false,
      offX = 0,
      offY = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = e.clientX - offX + "px";
      panel.style.top = e.clientY - offY + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => (dragging = false));
  }

  loadState().then(() => {
    buildPanel();
  });
})();
