/**
 * Breasks ETM Trip Planner - core planning engine.
 *
 * Runs entirely client-side against orders scraped from the ETM
 * "List Orders" page. No network calls.
 *
 * Pipeline:
 *   1. filterOrders   - drop Sales Returns + excluded order-type prefixes
 *   2. resolveAreas   - map each order's Area value to a known area code
 *                       (unresolved ones are reported separately so the
 *                       user can map them once from the panel)
 *   3. buildPlan       - cluster by area, sort areas by distance from the
 *                       warehouse (farthest first), greedily bin-pack into
 *                       trips per slot respecting CBM capacity and a time
 *                       budget (sum of FxTime + estimated travel time),
 *                       and order each trip's stops farthest -> nearest.
 *
 * Exposed as window.BreaksPlanner.
 */
(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    warehouseAreaCode: "122",
    vehicleCbmCapacity: 12, // m3, generic default - override per team in Options
    avgSpeedKmh: 45, // city/suburban average incl. traffic, used to turn km into minutes
    slots: [
      { id: "morning", label: "Morning", start: "10:00", end: "14:00" },
      { id: "afternoon", label: "Afternoon", start: "14:00", end: "17:00" },
      { id: "evening", label: "Evening", start: "17:00", end: "20:00" },
    ],
    slotBufferMinutes: 20, // safety margin subtracted from each slot's window
    excludedOrderPrefixes: ["UK", "QT", "MT"],
    // Any Notes text matching this (case-insensitive) marks the order as a
    // Sales Return to exclude. Also treats order numbers starting with "RW"
    // as returns, since that prefix is used for Sales Return docs in ETM.
    returnNotesPattern: "\\bR\\b|RETURN",
    returnOrderPrefixes: ["RW"],
  };

  function loadSettings(stored) {
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    s.slots = (stored && stored.slots) || DEFAULT_SETTINGS.slots;
    s.excludedOrderPrefixes =
      (stored && stored.excludedOrderPrefixes) || DEFAULT_SETTINGS.excludedOrderPrefixes;
    s.returnOrderPrefixes =
      (stored && stored.returnOrderPrefixes) || DEFAULT_SETTINGS.returnOrderPrefixes;
    return s;
  }

  function orderPrefix(orderNo) {
    const m = /^([A-Za-z]+)/.exec(orderNo || "");
    return m ? m[1].toUpperCase() : "";
  }

  function isSalesReturn(order, settings) {
    const prefix = orderPrefix(order.order);
    if (settings.returnOrderPrefixes.includes(prefix)) return true;
    if (!order.notes) return false;
    try {
      const re = new RegExp(settings.returnNotesPattern, "i");
      return re.test(order.notes);
    } catch (e) {
      return /\bR\b/i.test(order.notes);
    }
  }

  function isExcludedType(order, settings) {
    const prefix = orderPrefix(order.order);
    return settings.excludedOrderPrefixes.map((p) => p.toUpperCase()).includes(prefix);
  }

  /**
   * @param {Array} orders - raw scraped rows
   * @param {Object} settings
   * @returns {{kept: Array, excluded: Array}}
   */
  function filterOrders(orders, settings) {
    const kept = [];
    const excluded = [];
    for (const o of orders) {
      if (isSalesReturn(o, settings)) {
        excluded.push(Object.assign({}, o, { excludeReason: "sales_return" }));
      } else if (isExcludedType(o, settings)) {
        excluded.push(Object.assign({}, o, { excludeReason: "excluded_type:" + orderPrefix(o.order) }));
      } else {
        kept.push(o);
      }
    }
    return { kept, excluded };
  }

  function normalizeAreaKey(raw) {
    if (raw === null || raw === undefined) return "";
    const s = String(raw).trim();
    const digits = s.replace(/^0+(?=\d)/, ""); // strip leading zeros: "022" -> "22"
    return digits;
  }

  /**
   * Resolves each order's Area field against the area-code database.
   * Tries, in order: exact code match, zero-padded/stripped match,
   * then a manual override map (areaOverrides: rawAreaValue -> code).
   */
  function resolveAreas(orders, areaData, areaOverrides) {
    const areas = areaData.areas;
    const resolved = [];
    const unresolved = [];
    const overrides = areaOverrides || {};

    for (const o of orders) {
      const raw = o.area;
      let code = null;

      if (overrides[raw] && areas[overrides[raw]]) {
        code = overrides[raw];
      } else if (areas[raw]) {
        code = raw;
      } else {
        const norm = normalizeAreaKey(raw);
        // try common paddings: 3-digit zero-padded, or as-is numeric
        const candidates = [norm, norm.padStart(3, "0")];
        for (const c of candidates) {
          if (areas[c]) {
            code = c;
            break;
          }
        }
      }

      if (code) {
        resolved.push(Object.assign({}, o, { resolvedAreaCode: code, areaInfo: areas[code] }));
      } else {
        unresolved.push(o);
      }
    }
    return { resolved, unresolved };
  }

  function travelMinutes(km, settings) {
    if (km <= 0) return 0;
    return (km / settings.avgSpeedKmh) * 60;
  }

  function slotMinutes(slot, bufferMinutes) {
    const [sh, sm] = slot.start.split(":").map(Number);
    const [eh, em] = slot.end.split(":").map(Number);
    return eh * 60 + em - (sh * 60 + sm) - bufferMinutes;
  }

  /**
   * Greedy bin-packer: for one slot, walks areas from farthest to nearest,
   * opening a new trip whenever the current one would exceed CBM capacity
   * or the time budget. Within a trip, stops stay in farthest->nearest
   * order (the route direction the user asked for: out to the far point,
   * then work back toward the warehouse).
   */
  function packSlot(areaGroups, settings, vehicleCbm, slotLabel, slotId) {
    const budgetMin = slotMinutes(
      settings.slots.find((s) => s.id === slotId) || settings.slots[0],
      settings.slotBufferMinutes
    );

    const trips = [];
    let current = null;

    function newTrip() {
      current = {
        slotId,
        slotLabel,
        stops: [], // { areaCode, areaLabel, distanceKm, orders: [...] }
        totalCbm: 0,
        totalFxMinutes: 0,
        totalTravelMinutes: 0,
        totalValue: 0,
        orderCount: 0,
      };
      trips.push(current);
      return current;
    }

    newTrip();
    let prevDistance = null; // null = warehouse

    for (const group of areaGroups) {
      const groupCbm = group.orders.reduce((sum, o) => sum + (o.volume || 0), 0);
      const groupFx = group.orders.reduce((sum, o) => sum + (o.fxTime || 0), 0);
      const legKm = Math.abs((prevDistance === null ? group.distanceKm : prevDistance) - group.distanceKm);
      const legMin = prevDistance === null ? travelMinutes(group.distanceKm, settings) : travelMinutes(legKm, settings);

      const wouldCbm = current.totalCbm + groupCbm;
      const wouldTime = current.totalFxMinutes + current.totalTravelMinutes + groupFx + legMin;

      const fitsCapacity = wouldCbm <= vehicleCbm;
      const fitsTime = wouldTime <= budgetMin;

      if (current.stops.length > 0 && (!fitsCapacity || !fitsTime)) {
        newTrip();
        prevDistance = null;
      }

      // recompute leg from (possibly reset) previous stop
      const legKm2 =
        prevDistance === null ? group.distanceKm : Math.abs(prevDistance - group.distanceKm);
      const legMin2 = travelMinutes(legKm2, settings);

      current.stops.push({
        areaCode: group.areaCode,
        areaLabel: group.areaLabel,
        distanceKm: group.distanceKm,
        orders: group.orders,
        legMinutes: Math.round(legMin2),
      });
      current.totalCbm += groupCbm;
      current.totalFxMinutes += groupFx;
      current.totalTravelMinutes += legMin2;
      current.totalValue += group.orders.reduce((sum, o) => sum + (o.value || 0), 0);
      current.orderCount += group.orders.length;
      prevDistance = group.distanceKm;
    }

    // return leg back to warehouse, for reporting only (not a hard constraint)
    for (const t of trips) {
      const lastStop = t.stops[t.stops.length - 1];
      t.returnMinutes = lastStop ? Math.round(travelMinutes(lastStop.distanceKm, settings)) : 0;
      t.totalMinutes = Math.round(t.totalFxMinutes + t.totalTravelMinutes + t.returnMinutes);
      t.budgetMinutes = Math.round(budgetMin);
      t.overBudget = t.totalMinutes > budgetMin || t.totalCbm > vehicleCbm;
    }

    return trips.filter((t) => t.stops.length > 0);
  }

  /**
   * @param {Array} resolvedOrders - orders with resolvedAreaCode/areaInfo
   * @param {Object} areaData
   * @param {Object} settings
   * @param {Object} teamCapacities - optional { teamName: cbm } overrides; unused for now (orders aren't pre-assigned to a team), kept for future per-team planning
   * @returns {{slots: Array}}
   */
  function buildPlan(resolvedOrders, areaData, settings) {
    // group by area code
    const byArea = new Map();
    for (const o of resolvedOrders) {
      const code = o.resolvedAreaCode;
      if (!byArea.has(code)) {
        byArea.set(code, {
          areaCode: code,
          areaLabel: o.areaInfo.label,
          distanceKm: o.areaInfo.distanceKm,
          orders: [],
        });
      }
      byArea.get(code).orders.push(o);
    }

    // sort areas farthest -> nearest from warehouse
    const areaGroups = Array.from(byArea.values()).sort((a, b) => b.distanceKm - a.distanceKm);

    // Split evenly-ish across the 3 slots by cumulative volume, so each
    // slot gets a contiguous farthest->nearest chunk (keeps each driver's
    // route geographically coherent instead of interleaving).
    const totalCbm = areaGroups.reduce(
      (sum, g) => sum + g.orders.reduce((s, o) => s + (o.volume || 0), 0),
      0
    );
    const targetPerSlot = totalCbm / settings.slots.length;

    const slotBuckets = settings.slots.map((s) => ({ slot: s, groups: [] }));
    let bucketIdx = 0;
    let runningCbm = 0;
    for (const group of areaGroups) {
      const groupCbm = group.orders.reduce((s, o) => s + (o.volume || 0), 0);
      if (
        bucketIdx < slotBuckets.length - 1 &&
        runningCbm >= targetPerSlot &&
        slotBuckets[bucketIdx].groups.length > 0
      ) {
        bucketIdx++;
        runningCbm = 0;
      }
      slotBuckets[bucketIdx].groups.push(group);
      runningCbm += groupCbm;
    }

    const slotsOut = slotBuckets.map((bucket) => ({
      id: bucket.slot.id,
      label: bucket.slot.label,
      window: bucket.slot.start + " - " + bucket.slot.end,
      trips: packSlot(
        bucket.groups,
        settings,
        settings.vehicleCbmCapacity,
        bucket.slot.label,
        bucket.slot.id
      ),
    }));

    return { slots: slotsOut };
  }

  function run(orders, areaData, settings, areaOverrides) {
    const { kept, excluded } = filterOrders(orders, settings);
    const { resolved, unresolved } = resolveAreas(kept, areaData, areaOverrides);
    const plan = buildPlan(resolved, areaData, settings);
    return { plan, excluded, unresolved, keptCount: kept.length, totalCount: orders.length };
  }

  window.BreaksPlanner = {
    DEFAULT_SETTINGS,
    loadSettings,
    filterOrders,
    resolveAreas,
    buildPlan,
    run,
    orderPrefix,
    normalizeAreaKey,
  };
})();
