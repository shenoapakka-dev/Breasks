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
    avgSpeedKmh: 60, // blended city+highway average incl. traffic, used to turn km into minutes
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
   * Sales Return orders (RW prefix, or Notes matching the return pattern)
   * are NOT excluded from planning: the driver still needs to visit that
   * stop to collect the return, so they stay in the route and are just
   * tagged (isReturn: true) so the plan/exports can flag them for the
   * team. Only excludedOrderPrefixes (UK/QT/MT by default) are dropped
   * entirely, since those are genuinely out of scope for delivery trips.
   *
   * @param {Array} orders - raw scraped rows
   * @param {Object} settings
   * @returns {{kept: Array, excluded: Array}}
   */
  function filterOrders(orders, settings) {
    const kept = [];
    const excluded = [];
    for (const o of orders) {
      if (isExcludedType(o, settings)) {
        excluded.push(Object.assign({}, o, { excludeReason: "excluded_type:" + orderPrefix(o.order) }));
      } else {
        kept.push(Object.assign({}, o, { isReturn: isSalesReturn(o, settings) }));
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
   * An area with more orders than one vehicle/trip can carry must not stay
   * one atomic stop - split its orders into CBM-sized chunks first, each
   * still tagged with that area's code/label/distance (so the packer below
   * can put each chunk on its own trip/vehicle instead of overloading one).
   * Consecutive chunks of the same area cost ~0 extra travel time between
   * them (same place), so this only affects capacity, not routing.
   */
  function splitOversizedGroups(areaGroups, vehicleCbm) {
    const out = [];
    for (const g of areaGroups) {
      let chunk = [];
      let chunkCbm = 0;
      for (const o of g.orders) {
        const vol = o.volume || 0;
        if (chunk.length && vehicleCbm > 0 && chunkCbm + vol > vehicleCbm) {
          out.push({ areaCode: g.areaCode, areaLabel: g.areaLabel, distanceKm: g.distanceKm, orders: chunk });
          chunk = [];
          chunkCbm = 0;
        }
        chunk.push(o);
        chunkCbm += vol;
      }
      if (chunk.length) {
        out.push({ areaCode: g.areaCode, areaLabel: g.areaLabel, distanceKm: g.distanceKm, orders: chunk });
      }
    }
    return out;
  }

  /**
   * Greedy bin-packer: for one slot, walks areas from farthest to nearest,
   * opening a new trip whenever the current one would exceed CBM capacity
   * or the time budget - INCLUDING the drive back to the warehouse, since
   * that's what actually has to happen before the slot ends. Within a
   * trip, stops stay in farthest->nearest order (out to the far point,
   * then work back toward the warehouse).
   */
  function packSlot(areaGroups, settings, vehicleCbm, slotLabel, slotId) {
    const budgetMin = slotMinutes(
      settings.slots.find((s) => s.id === slotId) || settings.slots[0],
      settings.slotBufferMinutes
    );

    const groups = splitOversizedGroups(areaGroups, vehicleCbm);
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
        returnCount: 0,
      };
      trips.push(current);
      return current;
    }

    newTrip();
    let prevDistance = null; // null = warehouse

    for (const group of groups) {
      const groupCbm = group.orders.reduce((sum, o) => sum + (o.volume || 0), 0);
      const groupFx = group.orders.reduce((sum, o) => sum + (o.fxTime || 0), 0);

      // Only CBM is a hard constraint - a vehicle physically can't carry
      // more volume than it holds, so that's the only thing that opens a
      // new trip/vehicle. FxTime/travel overrunning the slot's time
      // budget is reported as a warning (overBudget below) but does NOT
      // split the trip: the team just takes longer than the nominal slot
      // instead of deploying another vehicle for the same area.
      const wouldCbm = current.totalCbm + groupCbm;
      const fitsCapacity = wouldCbm <= vehicleCbm;

      if (current.stops.length > 0 && !fitsCapacity) {
        newTrip();
        prevDistance = null;
      }

      // recompute leg from (possibly reset) previous stop
      const legKm2 =
        prevDistance === null ? group.distanceKm : Math.abs(prevDistance - group.distanceKm);
      const legMin2 = travelMinutes(legKm2, settings);

      const groupReturns = group.orders.filter((o) => o.isReturn).length;
      current.stops.push({
        areaCode: group.areaCode,
        areaLabel: group.areaLabel,
        distanceKm: group.distanceKm,
        orders: group.orders,
        legMinutes: Math.round(legMin2),
        returnCount: groupReturns,
      });
      current.totalCbm += groupCbm;
      current.totalFxMinutes += groupFx;
      current.totalTravelMinutes += legMin2;
      current.totalValue += group.orders.reduce((sum, o) => sum + (o.value || 0), 0);
      current.orderCount += group.orders.length;
      current.returnCount += groupReturns;
      prevDistance = group.distanceKm;
    }

    // return leg back to warehouse (already budgeted for above; computed
    // again here per-trip for the report/overBudget flag)
    for (const t of trips) {
      const lastStop = t.stops[t.stops.length - 1];
      t.returnMinutes = lastStop ? Math.round(travelMinutes(lastStop.distanceKm, settings)) : 0;
      t.totalMinutes = Math.round(t.totalFxMinutes + t.totalTravelMinutes + t.returnMinutes);
      t.budgetMinutes = Math.round(budgetMin);
      t.overBudget = t.totalMinutes > budgetMin || t.totalCbm > vehicleCbm;
      // a SINGLE stop alone already busts the slot on travel time alone -
      // splitting trips can't fix that, it's genuinely too far for this
      // slot length and needs its own dedicated/longer trip.
      t.longHaul = t.stops.length === 1 && t.overBudget && !(t.totalCbm > vehicleCbm);
    }

    return trips.filter((t) => t.stops.length > 0);
  }

  // ---------- delivery-time preference parsing (from Notes) ----------

  /**
   * Customer Notes carry real delivery-time requests, e.g.
   * "FIRST MORNING DELIVERY//", "BEFORE 5PM", "AFTER 7PM", "AFTERNOON
   * DELIVERY". These must constrain which slot(s) the order can go into,
   * not just be free text. Returns { slotIds, beforeHour, afterHour, label }
   * where slotIds is a fixed list of slot ids (from an explicit word like
   * "MORNING"), or beforeHour/afterHour is a 24h hour threshold (from
   * "BEFORE/AFTER Xpm"), or both null if the note has no parseable
   * time constraint. label is a short human-readable echo of what matched,
   * for display - independent of whether it was used as a constraint.
   */
  function parseNotePreference(notes) {
    if (!notes) return { slotIds: null, beforeHour: null, afterHour: null, label: null };
    const text = String(notes).toUpperCase();

    const explicit = [
      [/\bMORNING\b/, ["morning"], "Morning requested"],
      [/\bAFTERNOON\b/, ["afternoon"], "Afternoon requested"],
      [/\bEVENING\b/, ["evening"], "Evening requested"],
    ];
    for (const [re, slotIds, label] of explicit) {
      if (re.test(text)) return { slotIds, beforeHour: null, afterHour: null, label };
    }

    function to24h(hourStr, ampm) {
      let h = parseInt(hourStr, 10) % 12;
      const mer = (ampm || "PM").toUpperCase(); // bare hour in a delivery note defaults to PM
      if (mer === "PM") h += 12;
      return h;
    }

    const before = text.match(/BEFORE\s*(\d{1,2})\s*(AM|PM)?/);
    if (before) {
      return {
        slotIds: null,
        beforeHour: to24h(before[1], before[2]),
        afterHour: null,
        label: `Before ${before[1]}${before[2] ? before[2] : ""}`,
      };
    }
    const after = text.match(/AFTER\s*(\d{1,2})\s*(AM|PM)?/);
    if (after) {
      return {
        slotIds: null,
        beforeHour: null,
        afterHour: to24h(after[1], after[2]),
        label: `After ${after[1]}${after[2] ? after[2] : ""}`,
      };
    }

    return { slotIds: null, beforeHour: null, afterHour: null, label: null };
  }

  function slotMinutesOfDay(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return h * 60 + m;
  }

  function slotAllowedForPreference(slot, pref) {
    if (pref.slotIds) return pref.slotIds.includes(slot.id);
    if (pref.beforeHour !== null && pref.beforeHour !== undefined) {
      return slotMinutesOfDay(slot.end) <= pref.beforeHour * 60;
    }
    if (pref.afterHour !== null && pref.afterHour !== undefined) {
      return slotMinutesOfDay(slot.start) >= pref.afterHour * 60;
    }
    return true;
  }

  /**
   * @param {Array} resolvedOrders - orders with resolvedAreaCode/areaInfo
   * @param {Object} areaData
   * @param {Object} settings
   * @returns {{slots: Array, vehicles: Array, noFeasibleSlot: Array}}
   */
  function buildPlan(resolvedOrders, areaData, settings) {
    // Tag every order with its parsed note preference and which slot ids
    // it's actually allowed into, then group by (area, allowed-slot-set)
    // so orders with a hard time request never land outside it, while
    // orders with no request stay flexible across all slots.
    const tagged = resolvedOrders.map((o) => {
      const pref = parseNotePreference(o.notes);
      const allowedSlotIds = settings.slots.filter((s) => slotAllowedForPreference(s, pref)).map((s) => s.id);
      return Object.assign({}, o, { notePreferenceLabel: pref.label, allowedSlotIds });
    });

    const noFeasibleSlot = tagged.filter((o) => o.allowedSlotIds.length === 0);
    const feasible = tagged.filter((o) => o.allowedSlotIds.length > 0);

    const subGroups = new Map();
    for (const o of feasible) {
      const sigKey = o.allowedSlotIds.length === settings.slots.length ? "any" : o.allowedSlotIds.join(",");
      const key = o.resolvedAreaCode + "::" + sigKey;
      if (!subGroups.has(key)) {
        subGroups.set(key, {
          areaCode: o.resolvedAreaCode,
          areaLabel: o.areaInfo.label,
          distanceKm: o.areaInfo.distanceKm,
          allowedSlotIds: o.allowedSlotIds,
          orders: [],
        });
      }
      subGroups.get(key).orders.push(o);
    }

    // farthest -> nearest overall, so the greedy balancer below still
    // naturally produces farthest-first sequencing within each slot
    const groups = Array.from(subGroups.values()).sort((a, b) => b.distanceKm - a.distanceKm);

    // Balance by running CBM per slot, restricted to each group's allowed
    // slot(s) - a group with a hard time request has no choice, a free
    // group picks whichever allowed slot currently has the least load.
    const slotCbm = {};
    const bucket = {};
    settings.slots.forEach((s) => {
      slotCbm[s.id] = 0;
      bucket[s.id] = [];
    });
    for (const g of groups) {
      const gCbm = g.orders.reduce((s, o) => s + (o.volume || 0), 0);
      let bestId = g.allowedSlotIds[0];
      for (const id of g.allowedSlotIds) {
        if (slotCbm[id] < slotCbm[bestId]) bestId = id;
      }
      bucket[bestId].push(g);
      slotCbm[bestId] += gCbm;
    }

    const slotsOut = settings.slots.map((s) => ({
      id: s.id,
      label: s.label,
      window: s.start + " - " + s.end,
      trips: packSlot(bucket[s.id], settings, settings.vehicleCbmCapacity, s.label, s.id),
    }));

    return { slots: slotsOut, vehicles: groupIntoVehicles(slotsOut), noFeasibleSlot };
  }

  /**
   * Transposes the per-slot trip lists into per-vehicle "days": each
   * vehicle/driver runs the Nth trip of every slot in turn (morning leg,
   * afternoon leg, evening leg - back to the warehouse between each),
   * instead of a separate vehicle per slot.
   */
  function groupIntoVehicles(slotsOut) {
    const maxTrips = slotsOut.reduce((m, s) => Math.max(m, s.trips.length), 0);
    const vehicles = [];
    for (let i = 0; i < maxTrips; i++) {
      const legs = slotsOut.map((s) => ({
        slotId: s.id,
        slotLabel: s.label,
        window: s.window,
        trip: s.trips[i] || null,
      }));
      const orderCount = legs.reduce((sum, l) => sum + (l.trip ? l.trip.orderCount : 0), 0);
      const overBudget = legs.some((l) => l.trip && l.trip.overBudget);
      const longHaul = legs.some((l) => l.trip && l.trip.longHaul);
      const returnCount = legs.reduce((sum, l) => sum + (l.trip ? l.trip.returnCount : 0), 0);
      vehicles.push({ vehicleNo: i + 1, legs, orderCount, overBudget, longHaul, returnCount });
    }
    return vehicles;
  }

  function run(orders, areaData, settings, areaOverrides) {
    const { kept, excluded } = filterOrders(orders, settings);
    const { resolved, unresolved } = resolveAreas(kept, areaData, areaOverrides);
    const plan = buildPlan(resolved, areaData, settings);
    return {
      plan,
      excluded,
      unresolved,
      noFeasibleSlot: plan.noFeasibleSlot,
      keptCount: kept.length,
      totalCount: orders.length,
    };
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
    parseNotePreference,
  };
})();
