/**
 * Pure (DOM-free) mapping from raw scraped table rows -> order objects.
 * Shared between the Chrome extension's content script (browser, DOM
 * access) and the standalone Node sync script (Playwright, no DOM at
 * module scope) so both use the exact same header-matching logic
 * instead of two copies that can quietly drift apart.
 *
 * Works as a plain <script> (sets window.BreaksRowMapper) or via
 * require() in Node (module.exports), same pattern as lib/planner.js.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  } else {
    root.BreaksRowMapper = mod;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

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

  function normKey(s) {
    return (s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /**
   * @param {Array} headerCells - array of raw header cell text, in column order
   * @returns {Object} normalized-key -> column index
   */
  function buildHeaderMap(headerCells) {
    const map = {};
    headerCells.forEach((text, i) => {
      const key = normKey(text);
      if (key) map[key] = i;
    });
    return map;
  }

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

  /**
   * @param {Object} headerMap - normalized-key -> column index (from buildHeaderMap)
   * @param {Array<Array<string>>} rows - raw cell text per row
   * @returns {{orders: Array, missingFields: Array<string>}}
   */
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

  return {
    FIELD_ALIASES,
    normKey,
    buildHeaderMap,
    buildFieldIndex,
    parseNumber,
    rowsToOrders,
  };
});
