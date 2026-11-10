/**
 * Runs in the PAGE's own JS context (manifest "world": "MAIN"), so it can
 * see the page's jQuery/DataTables instance directly. Talks to the
 * extension's isolated-world content script purely via CustomEvents on
 * `document`, since the two worlds do not share object references.
 *
 * This lets us pull the FULL order list (all ~1,675 rows) in one shot
 * through the DataTables column API instead of clicking "Next" through
 * ~112 pages, when the table turns out to be client-side DataTables.
 */
(function () {
  "use strict";

  function headerMap(table) {
    const ths = table.querySelectorAll("thead th");
    const map = {};
    ths.forEach((th, i) => {
      const key = (th.textContent || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key) map[key] = i;
    });
    return map;
  }

  function findOrdersTable() {
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

  function cellText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" && /</.test(v)) {
      const tmp = document.createElement("div");
      tmp.innerHTML = v;
      return tmp.textContent.trim();
    }
    return String(v).trim();
  }

  function extractViaDataTables(table) {
    const jq = window.jQuery || window.$;
    if (!jq || !jq.fn || !jq.fn.dataTable) return { ok: false, reason: "no-jquery-datatables" };
    if (!jq.fn.dataTable.isDataTable(table)) return { ok: false, reason: "not-a-datatable" };

    const dt = jq(table).DataTable();
    let isServerSide = false;
    try {
      const settings = dt.settings()[0];
      isServerSide = !!(settings && settings.oFeatures && settings.oFeatures.bServerSide);
    } catch (e) {
      /* ignore */
    }

    const map = headerMap(table);
    const colCount = Math.max(-1, ...Object.values(map)) + 1;
    if (colCount <= 0) return { ok: false, reason: "no-header-map" };

    const count = dt.rows().count();
    const columns = [];
    for (let i = 0; i < colCount; i++) {
      try {
        columns[i] = dt.column(i).data().toArray();
      } catch (e) {
        columns[i] = new Array(count).fill("");
      }
    }

    const rows = [];
    for (let r = 0; r < count; r++) {
      const row = [];
      for (let i = 0; i < colCount; i++) {
        row[i] = cellText(columns[i] ? columns[i][r] : "");
      }
      rows.push(row);
    }

    return { ok: true, headerMap: map, rows, count, isServerSide };
  }

  document.addEventListener("breaks:scrape-request", function () {
    let payload;
    try {
      const table = findOrdersTable();
      if (!table) {
        payload = { ok: false, error: "table-not-found" };
      } else {
        const result = extractViaDataTables(table);
        if (!result.ok) {
          payload = { ok: false, error: result.reason, headerMap: headerMap(table) };
        } else if (result.isServerSide) {
          payload = { ok: false, error: "server-side-table", headerMap: result.headerMap };
        } else {
          payload = {
            ok: true,
            headerMap: result.headerMap,
            rows: result.rows,
            count: result.count,
          };
        }
      }
    } catch (e) {
      payload = { ok: false, error: "exception:" + String(e && e.message ? e.message : e) };
    }
    document.dispatchEvent(new CustomEvent("breaks:scrape-response", { detail: payload }));
  });
})();
