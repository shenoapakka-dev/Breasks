/**
 * Runs in the PAGE's own JS context (manifest "world": "MAIN"), so it can
 * see the page's jQuery/DataTables instance directly. Talks to the
 * extension's isolated-world content script purely via CustomEvents on
 * `document`, since the two worlds do not share object references.
 *
 * Strategy: rather than pulling DataTables' internal column/cell *data*
 * (which can silently diverge from what's actually on screen - e.g. an
 * Order column configured with an id as its data and a render callback
 * that draws the visible link text, where data() and even render()
 * don't reliably hand back that visible text), we tell DataTables to
 * show ALL rows on one page, let it redraw, and then read the real
 * rendered <td> text straight out of the DOM - the exact same way a
 * person reading the table would, and the exact same method the slow
 * per-page fallback in content.js uses. This keeps the speed benefit
 * (no clicking through ~100+ pages) while guaranteeing correctness.
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

  function readRenderedRows(table) {
    const body = table.querySelector("tbody");
    if (!body) return [];
    return Array.from(body.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map((td) => (td.textContent || "").trim())
    );
  }

  function showAllRowsAndRead(table, dt, totalCount) {
    return new Promise((resolve) => {
      const jq = window.jQuery || window.$;
      let settled = false;
      const originalLen = dt.page.len();

      function finish() {
        if (settled) return;
        settled = true;
        const rows = readRenderedRows(table);
        try {
          dt.page.len(originalLen).draw(false);
        } catch (e) {
          /* leave it as-is if restoring fails */
        }
        resolve(rows);
      }

      try {
        jq(table).one("draw.dt", () => setTimeout(finish, 30));
        dt.page.len(totalCount > 0 ? totalCount : 1).draw(false);
      } catch (e) {
        finish();
        return;
      }
      // safety net in case draw.dt never fires (e.g. ajax error)
      setTimeout(finish, 8000);
    });
  }

  async function extractViaDataTables(table) {
    const jq = window.jQuery || window.$;
    if (!jq || !jq.fn || !jq.fn.dataTable) return { ok: false, reason: "no-jquery-datatables" };
    if (!jq.fn.dataTable.isDataTable(table)) return { ok: false, reason: "not-a-datatable" };

    const dt = jq(table).DataTable();
    const map = headerMap(table);
    const colCount = Math.max(-1, ...Object.values(map)) + 1;
    if (colCount <= 0) return { ok: false, reason: "no-header-map" };

    const total = dt.rows().count();
    if (total <= 0) return { ok: false, reason: "no-rows" };

    const rows = await showAllRowsAndRead(table, dt, total);
    if (rows.length < total) {
      return { ok: false, reason: `incomplete-render:${rows.length}/${total}`, headerMap: map };
    }

    return { ok: true, headerMap: map, rows, count: rows.length };
  }

  document.addEventListener("breaks:scrape-request", async function () {
    let payload;
    try {
      const table = findOrdersTable();
      if (!table) {
        payload = { ok: false, error: "table-not-found" };
      } else {
        const result = await extractViaDataTables(table);
        if (!result.ok) {
          payload = { ok: false, error: result.reason, headerMap: headerMap(table) };
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
