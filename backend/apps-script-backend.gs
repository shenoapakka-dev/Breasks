/**
 * Pan Home Cancel Desk — backend API (Google Apps Script, bound to a Google Sheet).
 * Deploy as a Web App ("Execute as: Me", "Who has access: Anyone") so the public
 * page can call it with no Google/Claude login from the employee's side.
 */
var APP_KEY = "daQs4oFH4psq9jc9p8d669jFtm1Q7tBq"; // must match API_KEY in the HTML page

function doPost(e) {
  var lock = LockService.getScriptLock();
  var out;
  try {
    lock.waitLock(10000);
    var body = JSON.parse(e.postData.contents);
    if (body.key !== APP_KEY) throw new Error("bad_key");
    out = { ok: true, data: route(body) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: "Pan Home Cancel Desk API is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(body) {
  switch (body.action) {
    case "register": return register(body.username, body.role);
    case "login": return login(body.username, body.password);
    case "getAll": requireCaller(body.caller); return getAll();
    case "submitRequest": requireCaller(body.caller); return submitRequest(body.caller.username, body.data);
    case "updateStatus": requireRole(body.caller, ["operations", "admin"]); return updateStatus(body.id, body.status, body.caller.username, body.remark);
    case "changePassword": return changePassword(body.caller.username, body.caller.password, body.next);
    case "adminSetRole": requireRole(body.caller, ["admin"]); return adminSetRole(body.target, body.role);
    case "adminResetPassword": requireRole(body.caller, ["admin"]); return adminResetPassword(body.target);
    default: throw new Error("unknown_action");
  }
}

/* ---------- one-time setup: run this once from the Apps Script editor (Run > setup) ---------- */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var u = ss.getSheetByName("Users") || ss.insertSheet("Users");
  if (u.getLastRow() === 0) u.appendRow(["username", "password", "role", "createdAt"]);
  var r = ss.getSheetByName("Requests") || ss.insertSheet("Requests");
  if (r.getLastRow() === 0) {
    r.appendRow(["id","createdAt","agent","orderType","webOrderNumber","lnOrder","mobile","region","amount","reason","note","refundMethod","retain","status","updatedAt","historyJson","source","scope","items"]);
  }
  var def = ss.getSheetByName("Sheet1");
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(def);
}

/* One-time migration: run this ONCE if your "Requests" tab was created before the
   "mobile" field existed (i.e. setup() already ran and the sheet already has data
   you want to keep). Safe to run more than once — it no-ops if "mobile" is already there. */
function migrateAddMobileColumn() {
  var r = requestsSheet();
  var headers = r.getRange(1, 1, 1, r.getLastColumn()).getValues()[0];
  if (headers.indexOf("mobile") === -1) {
    r.insertColumnAfter(6); // after column F (lnOrder) -> new column G
    r.getRange(1, 7).setValue("mobile");
  }
}

/* One-time migration: run this ONCE if your "Requests" tab predates the
   "source" / "scope" / "items" fields. Appends whichever of the three are
   missing as new columns at the end — safe to run more than once. */
function migrateAddSourceScopeItems() {
  var r = requestsSheet();
  var lastCol = r.getLastColumn();
  var headers = r.getRange(1, 1, 1, lastCol).getValues()[0];
  var toAdd = ["source", "scope", "items"].filter(function (h) { return headers.indexOf(h) === -1; });
  toAdd.forEach(function (h, i) { r.getRange(1, lastCol + i + 1).setValue(h); });
}

/* ---------- helpers ---------- */
function normalizeUsername(u) { return String(u || "").trim().toLowerCase(); }
function activeSS() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("no_spreadsheet_bound: open this script via Extensions > Apps Script from inside the actual Google Sheet, not from script.google.com directly");
  return ss;
}
// Self-healing: create the tab (with its header row) the first time it's needed,
// instead of depending on setup() having been run successfully beforehand.
function usersSheet() {
  var ss = activeSS();
  var sh = ss.getSheetByName("Users");
  if (!sh) { sh = ss.insertSheet("Users"); sh.appendRow(["username", "password", "role", "createdAt"]); }
  return sh;
}
function requestsSheet() {
  var ss = activeSS();
  var sh = ss.getSheetByName("Requests");
  if (!sh) {
    sh = ss.insertSheet("Requests");
    sh.appendRow(["id","createdAt","agent","orderType","webOrderNumber","lnOrder","mobile","region","amount","reason","note","refundMethod","retain","status","updatedAt","historyJson","source","scope","items"]);
  }
  return sh;
}

function findUserRow(username) {
  username = normalizeUsername(username);
  var sh = usersSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizeUsername(data[i][0]) === username) {
      return { row: i + 1, username: data[i][0], password: data[i][1], role: data[i][2] };
    }
  }
  return null;
}

function requireCaller(caller) {
  if (!caller) throw new Error("auth_required");
  var u = findUserRow(caller.username);
  if (!u || String(u.password) !== String(caller.password)) throw new Error("auth_failed");
  return u;
}
function requireRole(caller, roles) {
  var u = requireCaller(caller);
  if (roles.indexOf(u.role) === -1) throw new Error("forbidden");
  return u;
}

/* ---------- actions ---------- */
function register(username, role) {
  username = normalizeUsername(username);
  if (!username || username.length < 2) throw new Error("bad_username");
  if (findUserRow(username)) throw new Error("username_taken");
  role = (role === "operations") ? "operations" : "agent";
  var sh = usersSheet();
  var isFirst = sh.getLastRow() <= 1;
  var finalRole = isFirst ? "admin" : role;
  sh.appendRow([username, "12345", finalRole, new Date().toISOString()]);
  return { username: username, role: finalRole, isFirst: isFirst };
}

function login(username, password) {
  var u = findUserRow(username);
  if (!u) throw new Error("no_account");
  if (String(u.password) !== String(password)) throw new Error("wrong_password");
  return { username: u.username, role: u.role };
}

function changePassword(username, current, next) {
  var u = findUserRow(username);
  if (!u) throw new Error("no_account");
  if (String(u.password) !== String(current)) throw new Error("wrong_password");
  if (!next || String(next).length < 4) throw new Error("weak_password");
  usersSheet().getRange(u.row, 2).setValue(String(next));
  return { ok: true };
}

function adminSetRole(target, role) {
  var u = findUserRow(target);
  if (!u) throw new Error("no_account");
  if (["agent", "operations", "admin"].indexOf(role) === -1) throw new Error("bad_role");
  usersSheet().getRange(u.row, 3).setValue(role);
  return { ok: true };
}
function adminResetPassword(target) {
  var u = findUserRow(target);
  if (!u) throw new Error("no_account");
  usersSheet().getRange(u.row, 2).setValue("12345");
  return { ok: true };
}

function submitRequest(agentUsername, d) {
  var sh = requestsSheet();
  var id = "PH-" + Utilities.formatDate(new Date(), "GMT", "yyMMdd") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  var now = new Date().toISOString();
  var history = [{ status: "pending", by: agentUsername, at: now, remark: "Request submitted" }];
  sh.appendRow([
    id, now, agentUsername, d.orderType, d.webOrderNumber || "", d.lnOrder, d.mobile || "", d.region,
    Number(d.amount) || 0, d.reason, d.note, d.refundMethod, d.retain, "pending", now, JSON.stringify(history),
    d.source || "", d.scope || "", d.items || ""
  ]);
  return { id: id };
}

function updateStatus(id, status, byUsername, remark) {
  var sh = requestsSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      var history = [];
      try { history = JSON.parse(data[i][15] || "[]"); } catch (e) {}
      history.push({ status: status, by: byUsername, at: new Date().toISOString(), remark: remark || "" });
      sh.getRange(i + 1, 14).setValue(status);
      sh.getRange(i + 1, 15).setValue(new Date().toISOString());
      sh.getRange(i + 1, 16).setValue(JSON.stringify(history));
      return { ok: true };
    }
  }
  throw new Error("not_found");
}

function getAll() {
  var ud = usersSheet().getDataRange().getValues();
  var users = [];
  for (var i = 1; i < ud.length; i++) {
    if (ud[i][0]) users.push({ username: ud[i][0], role: ud[i][2] });
  }
  var rd = requestsSheet().getDataRange().getValues();
  var requests = [];
  for (var j = 1; j < rd.length; j++) {
    if (!rd[j][0]) continue;
    var history = [];
    try { history = JSON.parse(rd[j][15] || "[]"); } catch (e) {}
    requests.push({
      id: rd[j][0], createdAt: rd[j][1], agent: rd[j][2], orderType: rd[j][3],
      webOrderNumber: rd[j][4], lnOrder: rd[j][5], mobile: rd[j][6], region: rd[j][7],
      amount: rd[j][8], reason: rd[j][9], note: rd[j][10], refundMethod: rd[j][11], retain: rd[j][12],
      status: rd[j][13], updatedAt: rd[j][14], history: history,
      source: rd[j][16] || "", scope: rd[j][17] || "", items: rd[j][18] || ""
    });
  }
  return { users: users, requests: requests };
}
