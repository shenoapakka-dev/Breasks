(function () {
  "use strict";

  const AREA_DATA = window.BREAKS_AREA_DATA;
  const Planner = window.BreaksPlanner;
  let settings = Planner.loadSettings(null);
  let areaOverrides = {};

  function $(id) {
    return document.getElementById(id);
  }

  function populateWarehouseSelect() {
    const sel = $("warehouseAreaCode");
    sel.innerHTML = "";
    const byEmirate = {};
    for (const code of Object.keys(AREA_DATA.areas)) {
      const a = AREA_DATA.areas[code];
      (byEmirate[a.emirate] = byEmirate[a.emirate] || []).push(a);
    }
    Object.keys(byEmirate)
      .sort()
      .forEach((em) => {
        const group = document.createElement("optgroup");
        group.label = em;
        byEmirate[em]
          .sort((a, b) => a.code.localeCompare(b.code))
          .forEach((a) => {
            const opt = document.createElement("option");
            opt.value = a.code;
            opt.textContent = `${a.code} - ${a.label}`;
            group.appendChild(opt);
          });
        sel.appendChild(group);
      });
  }

  function renderSlots() {
    const container = $("slotsContainer");
    container.innerHTML = "";
    settings.slots.forEach((slot, i) => {
      const row = document.createElement("div");
      row.className = "slot-row";
      row.innerHTML = `
        <span class="slot-label">${slot.label}</span>
        <input type="time" data-i="${i}" data-k="start" value="${slot.start}" />
        <span>to</span>
        <input type="time" data-i="${i}" data-k="end" value="${slot.end}" />
      `;
      container.appendChild(row);
    });
  }

  function renderOverrides() {
    const container = $("overridesContainer");
    container.innerHTML = "";
    const keys = Object.keys(areaOverrides);
    if (!keys.length) {
      container.innerHTML = '<p class="hint">No overrides saved yet.</p>';
      return;
    }
    keys.forEach((raw) => {
      const code = areaOverrides[raw];
      const info = AREA_DATA.areas[code];
      const row = document.createElement("div");
      row.className = "override-row";
      row.innerHTML = `
        <span class="raw">"${raw}"</span>
        <span>→ ${code}${info ? " - " + info.label : ""}</span>
      `;
      const del = document.createElement("button");
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        delete areaOverrides[raw];
        chrome.storage.local.set({ areaOverrides }, renderOverrides);
      });
      row.appendChild(del);
      container.appendChild(row);
    });
  }

  function renderAreaTable(filter) {
    const container = $("areaTable");
    const f = (filter || "").trim().toLowerCase();
    const rows = Object.values(AREA_DATA.areas)
      .filter((a) => !f || a.code.includes(f) || a.label.toLowerCase().includes(f) || a.emirate.toLowerCase().includes(f))
      .sort((a, b) => a.emirate.localeCompare(b.emirate) || a.distanceKm - b.distanceKm);
    const table = document.createElement("table");
    table.innerHTML = `
      <thead><tr><th>Code</th><th>Emirate</th><th>Sub-areas</th><th>~km from warehouse</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (a) =>
              `<tr><td>${a.code}</td><td>${a.emirate}</td><td>${a.label}</td><td>${a.distanceKm}</td></tr>`
          )
          .join("")}
      </tbody>
    `;
    container.innerHTML = "";
    container.appendChild(table);
  }

  function fillForm() {
    populateWarehouseSelect();
    $("warehouseAreaCode").value = settings.warehouseAreaCode;
    $("vehicleCbmCapacity").value = settings.vehicleCbmCapacity;
    $("avgSpeedKmh").value = settings.avgSpeedKmh;
    $("slotBufferMinutes").value = settings.slotBufferMinutes;
    $("excludedOrderPrefixes").value = settings.excludedOrderPrefixes.join(", ");
    $("returnOrderPrefixes").value = settings.returnOrderPrefixes.join(", ");
    $("returnNotesPattern").value = settings.returnNotesPattern;
    renderSlots();
    renderOverrides();
    renderAreaTable("");
  }

  function readFormIntoSettings() {
    settings.warehouseAreaCode = $("warehouseAreaCode").value;
    settings.vehicleCbmCapacity = parseFloat($("vehicleCbmCapacity").value) || 0;
    settings.avgSpeedKmh = parseFloat($("avgSpeedKmh").value) || 1;
    settings.slotBufferMinutes = parseFloat($("slotBufferMinutes").value) || 0;
    settings.excludedOrderPrefixes = $("excludedOrderPrefixes")
      .value.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    settings.returnOrderPrefixes = $("returnOrderPrefixes")
      .value.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    settings.returnNotesPattern = $("returnNotesPattern").value || "\\bR\\b|RETURN";

    const timeInputs = document.querySelectorAll("#slotsContainer input[type=time]");
    timeInputs.forEach((inp) => {
      const i = parseInt(inp.dataset.i, 10);
      const k = inp.dataset.k;
      if (settings.slots[i]) settings.slots[i][k] = inp.value;
    });
  }

  function load() {
    chrome.storage.local.get(["breaksSettings", "areaOverrides"], (data) => {
      settings = Planner.loadSettings(data.breaksSettings);
      areaOverrides = data.areaOverrides || {};
      fillForm();
    });
  }

  $("saveBtn").addEventListener("click", () => {
    readFormIntoSettings();
    chrome.storage.local.set({ breaksSettings: settings }, () => {
      const status = $("saveStatus");
      status.textContent = "Saved.";
      setTimeout(() => (status.textContent = ""), 2000);
    });
  });

  $("resetBtn").addEventListener("click", () => {
    settings = Planner.loadSettings(null);
    chrome.storage.local.set({ breaksSettings: settings }, fillForm);
  });

  $("areaSearch").addEventListener("input", (e) => renderAreaTable(e.target.value));

  load();
})();
