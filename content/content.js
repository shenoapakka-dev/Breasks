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
    for (const field of Object.keys(FIELD_ALIASES)) {
      for (const alias of FIELD_ALIASES[field]) {
        if (headerMap[alias] !== undefined) {
          idx[field] = headerMap[alias];
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
    const fast = await requestBridgeScrape(2500);
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
        "Slot",
        "Trip#",
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
      ],
    ];
    let tripNo = 0;
    for (const slot of runResult.plan.slots) {
      for (const trip of slot.trips) {
        tripNo++;
        let stopSeq = 0;
        for (const stop of trip.stops) {
          stopSeq++;
          for (const o of stop.orders) {
            rows.push([
              slot.label,
              tripNo,
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
            ]);
          }
        }
      }
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    downloadText("trip-plan.csv", csv, "text/csv;charset=utf-8");
  }

  function buildPrintReportHtml(runResult, dateLabel) {
    let tripNo = 0;
    const sections = [];
    for (const slot of runResult.plan.slots) {
      for (const trip of slot.trips) {
        tripNo++;
        let seq = 0;
        const orderList = [];
        for (const stop of trip.stops) {
          for (const o of stop.orders) {
            seq++;
            orderList.push(`${o.order}(${seq})${o.isReturn ? " [RETURN]" : ""}`);
          }
        }
        const destLabel = trip.stops
          .map((s) => s.areaCode)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .join(" | ");
        sections.push(`
          <div class="trip-block">
            <p><b>Trip:</b> ${tripNo} &nbsp;&nbsp; <b>Slot:</b> ${slot.label} (${slot.window})</p>
            <p><b>Destination (areas):</b> ${destLabel}</p>
            <p><b>Stops (farthest → nearest):</b> ${trip.stops
              .map((s) => `${s.areaCode} (${s.distanceKm}km)`)
              .join(" → ")}</p>
            <p><b>Orders:</b><br>${orderList.join(" , ")}</p>
            <p><b>Total CBM:</b> ${trip.totalCbm.toFixed(2)} &nbsp; <b>Total Fixing Minutes:</b> ${Math.round(
          trip.totalFxMinutes
        )} &nbsp; <b>Est. Total Trip Time:</b> ${trip.totalMinutes} min (budget ${
          trip.budgetMinutes
        } min)${trip.overBudget ? ' <span class="warn">OVER BUDGET</span>' : ""}</p>
            <p><b>Total Value:</b> ${trip.totalValue.toFixed(2)} &nbsp; <b>Orders:</b> ${trip.orderCount}</p>
          </div>
          <hr/>
        `);
      }
    }
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Trip Plan ${dateLabel || ""}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 24px; }
  h1 { font-size: 20px; text-align:center; }
  .trip-block { margin-bottom: 10px; }
  .warn { color: #c62828; font-weight: bold; }
  hr { border: none; border-top: 1px solid #ccc; margin: 14px 0; }
</style>
</head><body>
<h1>Trip Plan${dateLabel ? " - " + dateLabel : ""}</h1>
${sections.join("\n")}
</body></html>`;
  }

  function openPrintReport(runResult) {
    const html = buildPrintReportHtml(runResult, new Date().toISOString().slice(0, 10));
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

  function buildTripCard(trip, tripNo) {
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
    return el("div", { class: "breaks-trip-card" + (trip.overBudget ? " breaks-over" : "") }, [
      el("div", { class: "breaks-trip-head" }, [
        el("b", {}, [`Trip ${tripNo}`]),
        ` — ${trip.orderCount} orders${trip.returnCount ? ` (${trip.returnCount} return pickups)` : ""}, ${trip.totalCbm.toFixed(
          2
        )} CBM, ${trip.totalMinutes}/${trip.budgetMinutes} min`,
        trip.longHaul
          ? el("span", { class: "breaks-warn" }, [" TOO FAR FOR ONE SLOT — needs a dedicated/longer trip"])
          : trip.overBudget
          ? el("span", { class: "breaks-warn" }, [" OVER CAPACITY/TIME"])
          : null,
      ]),
      el("div", { class: "breaks-trip-stops" }, [stopsText]),
      copyBtn,
    ]);
  }

  function buildSlotSection(slot) {
    const cards = slot.trips.map((t, i) => buildTripCard(t, i + 1));
    return el("div", { class: "breaks-section" }, [
      el("div", { class: "breaks-section-title" }, [`${slot.label} (${slot.window}) — ${slot.trips.length} trip(s)`]),
      ...cards,
    ]);
  }

  function renderResults(container, runResult) {
    container.innerHTML = "";
    const summary = el("div", { class: "breaks-summary" }, [
      `${runResult.totalCount} total → ${runResult.keptCount} planned, ${runResult.excluded.length} excluded, ${runResult.unresolved.length} unmapped`,
    ]);
    container.appendChild(summary);

    const unresolvedSection = buildUnresolvedSection(runResult.unresolved, () => {
      const fresh = runPlan();
      renderResults(container, fresh);
    });
    if (unresolvedSection) container.appendChild(unresolvedSection);

    const excludedSection = buildExcludedSection(runResult.excluded);
    if (excludedSection) container.appendChild(excludedSection);

    for (const slot of runResult.plan.slots) {
      container.appendChild(buildSlotSection(slot));
    }

    const exportRow = el("div", { class: "breaks-export-row" }, [
      el("button", { class: "breaks-btn", onclick: () => exportCsv(runResult) }, ["Export CSV"]),
      el("button", { class: "breaks-btn", onclick: () => openPrintReport(runResult) }, ["Print / Save PDF"]),
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
