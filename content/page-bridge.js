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

    // Prefer the column's *rendered display* value, not its raw data: a
    // column like Order is commonly configured with data: <id> plus a
    // render callback that wraps it in a link ("<a ...>BR0034978</a>"),
    // in which case column().data() returns the raw id (or an object),
    // not the order number itself. cell(r, i).render('display') runs
    // that same render callback DataTables uses to draw the table, so it
    // matches what's actually on screen. Falls back to raw data if a
    // given cell has no render function (render() just returns data()
    // unchanged then) or throws for any reason.
    let useRawColumns = null; // lazily built only if render() isn't usable at all
    const rows = [];
    for (let r = 0; r < count; r++) {
      const row = [];
      for (let i = 0; i < colCount; i++) {
        let v;
        try {
          v = dt.cell(r, i).render("display");
        } catch (e) {
          if (!useRawColumns) {
            useRawColumns = [];
            for (let j = 0; j < colCount; j++) {
              try {
                useRawColumns[j] = dt.column(j).data().toArray();
              } catch (e2) {
                useRawColumns[j] = new Array(count).fill("");
              }
            }
          }
          v = useRawColumns[i] ? useRawColumns[i][r] : "";
        }
        row[i] = cellText(v);
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
