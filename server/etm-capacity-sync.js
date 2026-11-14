#!/usr/bin/env node
/**
 * Standalone sync script: logs into ETM headlessly, reads the List
 * Orders table for a given delivery date, and computes how much
 * capacity (fixing minutes + CBM) is already committed per area/slot -
 * the live data the Slot Capacity Monitor prototype needs instead of
 * sample numbers. Meant to run on a schedule (cron), not in a browser.
 *
 * Reuses the exact same scraping and planning logic as the Chrome
 * extension (content/page-bridge.js, lib/row-mapper.js, lib/planner.js)
 * instead of a second copy, so a fix made for the extension applies
 * here too.
 *
 * IMPORTANT: the login() and openListOrders() selectors below are
 * best-effort guesses from screenshots of the ETM pages, NOT verified
 * against the real login form or date filters. Run once with --headful
 * and fix them to match what you actually see before relying on this
 * unattended - see server/README.md.
 *
 * Usage:
 *   ETM_USERNAME=... ETM_PASSWORD=... node server/etm-capacity-sync.js --date 2026-11-14
 *   ETM_USERNAME=... ETM_PASSWORD=... node server/etm-capacity-sync.js --headful   (to debug login/nav)
 *
 * Env vars:
 *   ETM_BASE_URL       default "https://etm.panemirates.ae"
 *   ETM_USERNAME       required
 *   ETM_PASSWORD       required
 *   ETM_STORAGE_STATE  path to a saved Playwright storage state (session
 *                      cookies) to reuse instead of logging in every run -
 *                      see "Reusing a session" in server/README.md
 *   ETM_OUTPUT_DIR     default server/output
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const RowMapper = require(path.join(__dirname, "..", "lib", "row-mapper.js"));

// lib/planner.js and data/area_codes.js are written as dual browser-
// global/CommonJS modules (see their own headers) - they expect a
// `window` to assign onto, same trick the extension's test suite uses.
global.window = global;
require(path.join(__dirname, "..", "data", "area_codes.js"));
require(path.join(__dirname, "..", "lib", "planner.js"));
const AREA_DATA = global.BREAKS_AREA_DATA;
const Planner = global.BreaksPlanner;

function argValue(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 || !process.argv[i + 1] ? def : process.argv[i + 1];
}

const BASE_URL = (process.env.ETM_BASE_URL || "https://etm.panemirates.ae").replace(/\/$/, "");
const USERNAME = process.env.ETM_USERNAME;
const PASSWORD = process.env.ETM_PASSWORD;
const STORAGE_STATE = process.env.ETM_STORAGE_STATE || "";
const OUTPUT_DIR = process.env.ETM_OUTPUT_DIR || path.join(__dirname, "output");
const HEADFUL = process.argv.includes("--headful");
const DATE = argValue("date", new Date().toISOString().slice(0, 10));

function log(...args) {
  console.log("[etm-sync]", ...args);
}

/**
 * NEEDS VERIFICATION against the real ETM login page (field names,
 * whether it's a single page or redirects through SSO, etc). Run with
 * --headful once and adjust the selectors below to match.
 */
async function login(page) {
  log("navigating to", BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const userField = page
    .locator('input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i]')
    .first();
  const passField = page.locator('input[type="password"]').first();

  if ((await userField.count()) === 0 || (await passField.count()) === 0) {
    throw new Error(
      "Could not find a username/password field on " +
        page.url() +
        " - this means login() needs updating to match the real ETM login form. " +
        "Run with --headful to see the page and fix the selectors in server/etm-capacity-sync.js."
    );
  }

  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);

  const submit = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")')
    .first();
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    submit.click(),
  ]);
  log("login submitted, now at", page.url());
}

/**
 * NEEDS VERIFICATION against the real List Orders filter form (the date
 * inputs and the CHECK button). See the comment in login() above - same
 * caveat applies here.
 */
async function openListOrders(page, date) {
  const url = BASE_URL + "/ordering/trips-plan/list-orders";
  log("opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const dateInputs = page.locator('input[type="date"], input[placeholder*="date" i], input[name*="date" i]');
  const count = await dateInputs.count();
  for (let i = 0; i < Math.min(count, 2); i++) {
    await dateInputs.nth(i).fill(date).catch(() => log("could not fill date input #" + i + " - check selector"));
  }

  const checkBtn = page.getByRole("button", { name: /check/i }).first();
  if (await checkBtn.count()) {
    await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), checkBtn.click()]);
  } else {
    log('WARNING: no "CHECK" button found - the date filter may not have been applied.');
  }
}

/**
 * Reuses content/page-bridge.js unmodified: injects it into the real
 * page (full access, not an extension's isolated world) and speaks the
 * same breaks:scrape-request/response protocol the Chrome extension's
 * content.js uses. Any future fix to the scraping logic only has to
 * happen in that one file.
 */
async function scrapeOrders(page) {
  await page.addScriptTag({ path: path.join(__dirname, "..", "content", "page-bridge.js") });
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        function handler(e) {
          document.removeEventListener("breaks:scrape-response", handler);
          resolve(e.detail);
        }
        document.addEventListener("breaks:scrape-response", handler);
        document.dispatchEvent(new CustomEvent("breaks:scrape-request"));
      })
  );
  if (!result.ok) {
    throw new Error("page-bridge scrape failed: " + result.error);
  }
  log("scraped", result.count, "rows");
  return RowMapper.rowsToOrders(result.headerMap, result.rows);
}

/**
 * Runs the exact same planning engine the Chrome extension's "Scan +
 * Build Plan" uses, then reads off how much fixing-minutes/CBM capacity
 * each area ended up using in each slot - this is the number the Slot
 * Capacity Monitor needs per (area, slot).
 */
function computeAreaSlotUsage(orders, settings) {
  const runResult = Planner.run(orders, AREA_DATA, settings, {});
  const usage = {};
  for (const slot of runResult.plan.slots) {
    for (const trip of slot.trips) {
      for (const stop of trip.stops) {
        const key = stop.areaCode;
        if (!usage[key]) {
          usage[key] = {
            areaCode: stop.areaCode,
            areaLabel: stop.areaLabel,
            slotId: slot.id,
            slotLabel: slot.label,
            fxMinutes: 0,
            cbm: 0,
            orderCount: 0,
          };
        }
        for (const o of stop.orders) {
          usage[key].fxMinutes += o.fxTime || 0;
          usage[key].cbm += o.volume || 0;
          usage[key].orderCount += 1;
        }
      }
    }
  }
  return {
    areas: Object.values(usage),
    slotBudgets: settings.slots.map((s) => ({ id: s.id, label: s.label, window: s.start + " - " + s.end })),
    vehicleCbmCapacity: settings.vehicleCbmCapacity,
    excludedCount: runResult.excluded.length,
    unresolvedCount: runResult.unresolved.length,
    totalCount: runResult.totalCount,
  };
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error("ETM_USERNAME and ETM_PASSWORD env vars are required.");
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const launchOpts = { headless: !HEADFUL };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  }
  const browser = await chromium.launch(launchOpts);
  const contextOptions = {};
  if (STORAGE_STATE && fs.existsSync(STORAGE_STATE)) {
    log("reusing saved session from", STORAGE_STATE);
    contextOptions.storageState = STORAGE_STATE;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    if (!contextOptions.storageState) {
      await login(page);
      if (STORAGE_STATE) {
        await context.storageState({ path: STORAGE_STATE });
        log("saved session to", STORAGE_STATE);
      }
    }

    await openListOrders(page, DATE);
    const { orders, missingFields } = await scrapeOrders(page);
    if (missingFields.length) {
      log("WARNING: could not map column(s):", missingFields.join(", "));
    }

    const settings = Planner.loadSettings(null);
    const usage = computeAreaSlotUsage(orders, settings);

    const output = {
      date: DATE,
      generatedAt: new Date().toISOString(),
      ...usage,
    };

    const outFile = path.join(OUTPUT_DIR, `capacity-${DATE}.json`);
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    log("wrote", outFile, "-", usage.areas.length, "area/slot entries from", orders.length, "orders");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[etm-sync] FAILED:", err.message);
  process.exit(1);
});
