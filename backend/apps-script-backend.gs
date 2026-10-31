/**
 * Pan Home Cancel Desk — backend API (Google Apps Script, bound to a Google Sheet).
 * Deploy as a Web App ("Execute as: Me", "Who has access: Anyone") so the public
 * page can call it with no Google/Claude login from the employee's side.
 */
var APP_KEY = "daQs4oFH4psq9jc9p8d669jFtm1Q7tBq"; // must match API_KEY in the HTML page
// Stage changes (New -> Sent to Store -> Cancelled...), sending the store/
// online-team email, and editing a request after the fact are restricted to
// this named list, not the whole Operations/Admin role. Lowercase, compared
// case-insensitively regardless of each account's actual stored case.
var STAGE_UPDATERS = ["shenoudah", "mahmouda", "mariam", "shadys"];
// Only this account can create new logins (the public self-registration page
// is gone; new accounts are created from the Team page instead).
var ACCOUNT_CREATORS = ["shenoudah"];

// Only actions that actually write to the sheet need the script lock. Locking
// every call (including "login" and "getAll", which the page polls every 12s
// from every open tab) queued pure reads behind each other and behind writes
// for no reason, which is what produced "Lock timeout: another process was
// holding the lock for too long" on login — getAll calls piling up, not an
// actual write conflict.
var READ_ONLY_ACTIONS = ["login", "getAll", "fu_list", "fu_kpis", "fu_get", "fu_dueReminders", "chat_list", "chat_unreadCount", "fu_adminOverview"];
function doPost(e) {
  var out;
  var body;
  try {
    body = JSON.parse(e.postData.contents);
    if (body.key !== APP_KEY) throw new Error("bad_key");
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }
  var needsLock = READ_ONLY_ACTIONS.indexOf(body.action) === -1;
  var lock = needsLock ? LockService.getScriptLock() : null;
  try {
    if (lock) lock.waitLock(10000);
    out = { ok: true, data: route(body) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: "Pan Home Cancel Desk API is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(body) {
  switch (body.action) {
    case "register": return register(body.caller, body.username, body.role);
    case "login": return login(body.username, body.password);
    case "getAll": requireCaller(body.caller); return getAll();
    case "submitRequest": requireCaller(body.caller); return submitRequest(body.caller.username, body.data);
    case "updateStatus": requireStageUpdater(body.caller); return updateStatus(body.id, body.status, body.caller.username, body.remark);
    case "addNote": requireCaller(body.caller); return updateStatus(body.id, body.status, body.caller.username, body.remark);
    case "editRequest": requireStageUpdater(body.caller); return editRequest(body.id, body.patch, body.caller.username);
    case "changePassword": return changePassword(body.caller.username, body.caller.password, body.next);
    case "adminSetRole": requireRole(body.caller, ["admin"]); return adminSetRole(body.target, body.role);
    case "adminResetPassword": requireRole(body.caller, ["admin"]); return adminResetPassword(body.target);

    // Follow-up & Reminders. Each handler re-verifies the caller and (for
    // anything touching a specific case) re-checks ownership itself — see
    // fuAssertCaseAccess() — rather than relying on a gate here, so the rule
    // lives next to the data it protects and can't be skipped by a future
    // route added without the matching pre-check.
    case "fu_createCase": return fuCreateCase(body.caller, body.data);
    case "fu_list": return fuList(body.caller, body.query || {});
    case "fu_kpis": return fuKpis(body.caller, body.query || {});
    case "fu_get": return fuGetCase(body.caller, body.id);
    case "fu_addNote": return fuAddNote(body.caller, body.id, body.text, body.type);
    case "fu_contactAttempt": return fuContactAttempt(body.caller, body.id, body.outcome, body.notes);
    case "fu_setResolution": return fuSetResolution(body.caller, body.id, body.status, body.reason, body.nextStep, body.resolutionNote);
    case "fu_completeTask": return fuCompleteTask(body.caller, body.id, body.outcome, body.notes);
    case "fu_reschedule": return fuReschedule(body.caller, body.id, body.dueAt, body.reason, body.alertFrom, body.alertTo, body.repeatIntervalMin);
    case "fu_snooze": return fuSnooze(body.caller, body.id, body.minutes);
    case "fu_reassign": return fuReassign(body.caller, body.id, body.toAgent);
    case "fu_dueReminders": return fuDueReminders(body.caller);
    case "fu_ackReminder": return fuAckReminder(body.caller, body.logId, body.ackAction);
    case "fu_adminOverview": return fuAdminOverview(body.caller, body.query || {});
    case "chat_send": return chatSend(body.caller, body.toUser, body.caseId, body.text);
    case "chat_list": return chatList(body.caller, body.withUser);
    case "chat_markRead": return chatMarkRead(body.caller, body.ids);
    case "chat_unreadCount": return chatUnreadCount(body.caller);
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
    r.appendRow(["id","createdAt","agent","orderType","webOrderNumber","lnOrder","mobile","region","amount","reason","note","refundMethod","retain","status","updatedAt","historyJson","source","scope","items","customerCode","customerName","orderSegment"]);
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

/* One-time migration: run this ONCE if your "Requests" tab predates the
   "customerCode" / "customerName" fields (the CU... customer account number
   and name, parsed from a pasted ETM order). Safe to run more than once. */
function migrateAddCustomerFields() {
  var r = requestsSheet();
  var lastCol = r.getLastColumn();
  var headers = r.getRange(1, 1, 1, lastCol).getValues()[0];
  var toAdd = ["customerCode", "customerName"].filter(function (h) { return headers.indexOf(h) === -1; });
  toAdd.forEach(function (h, i) { r.getRange(1, lastCol + i + 1).setValue(h); });
}

/* One-time migration: run this ONCE if your "Requests" tab predates the
   "orderSegment" field (ETM's own delivery/fulfillment code, e.g. DFX, CDF —
   informational, parsed from a pasted ETM order). Safe to run more than once. */
function migrateAddOrderSegment() {
  var r = requestsSheet();
  var lastCol = r.getLastColumn();
  var headers = r.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf("orderSegment") === -1) r.getRange(1, lastCol + 1).setValue("orderSegment");
}

/* ---------- helpers ---------- */
// Case-sensitive on purpose: "ShenoudaH" and "shenoudah" are different accounts.
function normalizeUsername(u) { return String(u || "").trim(); }
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
    sh.appendRow(["id","createdAt","agent","orderType","webOrderNumber","lnOrder","mobile","region","amount","reason","note","refundMethod","retain","status","updatedAt","historyJson","source","scope","items","customerCode","customerName","orderSegment"]);
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
function requireStageUpdater(caller) {
  var u = requireCaller(caller);
  var isNamed = STAGE_UPDATERS.indexOf(String(u.username || "").toLowerCase()) !== -1;
  var isPrivilegedRole = u.role === "admin" || u.role === "operations";
  if (!isNamed && !isPrivilegedRole) throw new Error("forbidden_stage_update");
  return u;
}

/* ---------- actions ---------- */
function register(caller, username, role) {
  username = normalizeUsername(username);
  if (!username || username.length < 2) throw new Error("bad_username");
  if (findUserRow(username)) throw new Error("username_taken");
  var sh = usersSheet();
  var isFirst = sh.getLastRow() <= 1;
  // The very first account ever (bootstrapping the Users sheet) needs no
  // caller — nobody can be logged in yet. Every account after that can only
  // be created by someone in ACCOUNT_CREATORS.
  if (!isFirst) {
    var u = requireCaller(caller);
    if (ACCOUNT_CREATORS.indexOf(String(u.username || "").toLowerCase()) === -1) throw new Error("forbidden_account_creation");
  }
  role = (role === "operations") ? "operations" : (role === "admin" ? "admin" : "agent");
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
  var history = [{ status: "new", by: agentUsername, at: now, remark: "Request submitted" }];
  sh.appendRow([
    id, now, agentUsername, d.orderType, d.webOrderNumber || "", d.lnOrder, d.mobile || "", d.region,
    Number(d.amount) || 0, d.reason, d.note, d.refundMethod, d.retain, "new", now, JSON.stringify(history),
    d.source || "", d.scope || "", d.items || "", d.customerCode || "", d.customerName || "", d.orderSegment || ""
  ]);
  return { id: id };
}

// Reverse of the frontend's finalStatusFor() — keeps the stored Refund Via
// in sync whenever a stage-updater manually (re)sets a request to one of the
// three Cancelled outcomes via the stage dropdown, not just when it's picked
// automatically. Without this, re-opening a closed request and changing its
// final stage leaves the old Refund Via on the row, so the confirmation
// email (and the request's own display) end up contradicting the status
// actually shown — e.g. "Cancelled CDF" next to "please refund to the same
// payment method".
var REFUND_METHOD_FOR_STATUS = {
  cancelled_refund: "Same Payment Method",
  cancelled_credit: "Credit Note",
  cancelled_cdf: "Cash on Delivery",
  // Store orders close as soon as they're sent to the store — these two are
  // now terminal outcomes for Store, same as the three cancelled_* keys.
  sent_store_refund: "Same Payment Method",
  sent_store_credit: "Credit Note"
};
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
      if (REFUND_METHOD_FOR_STATUS[status]) sh.getRange(i + 1, 12).setValue(REFUND_METHOD_FOR_STATUS[status]);
      return { ok: true };
    }
  }
  throw new Error("not_found");
}

// Fields an Operations stage-updater can correct after the fact (e.g. a typo'd
// mobile number or amount noticed once a request is already closed). Column
// numbers are 1-indexed, matching the Requests sheet's actual layout.
var EDITABLE_FIELDS = {
  webOrderNumber: 5, lnOrder: 6, mobile: 7, region: 8, amount: 9,
  reason: 10, note: 11, refundMethod: 12, retain: 13
};
function editRequest(id, patch, byUsername) {
  patch = patch || {};
  var sh = requestsSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      var row = i + 1;
      var changed = [];
      Object.keys(patch).forEach(function (k) {
        var col = EDITABLE_FIELDS[k];
        if (!col) return;
        var v = (k === "amount") ? (Number(patch[k]) || 0) : patch[k];
        sh.getRange(row, col).setValue(v);
        changed.push(k);
      });
      if (!changed.length) throw new Error("nothing_to_edit");
      var history = [];
      try { history = JSON.parse(data[i][15] || "[]"); } catch (e) {}
      history.push({ status: data[i][13], by: byUsername, at: new Date().toISOString(), remark: "Edited: " + changed.join(", ") });
      sh.getRange(row, 15).setValue(new Date().toISOString());
      sh.getRange(row, 16).setValue(JSON.stringify(history));
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
      source: rd[j][16] || "", scope: rd[j][17] || "", items: rd[j][18] || "",
      customerCode: rd[j][19] || "", customerName: rd[j][20] || "", orderSegment: rd[j][21] || ""
    });
  }
  return { users: users, requests: requests };
}

/* ========================================================================
   FOLLOW-UP & REMINDERS
   A second, independent feature bolted onto the same sheet/Web-App, with
   its own RBAC: this is NOT the same "admin" role used by the Cancel Desk
   above. Here there is exactly one Super Admin — the verified account
   literally named "shenoudah" — and everyone else (agent, operations, even
   someone else whose role column happens to say "admin") is an ordinary
   Follow-up employee restricted to their own assigned cases. isCaller is
   always resolved server-side from the Users sheet (requireCaller), never
   trusted from whatever the client's request body claims.
   ======================================================================== */
var FOLLOWUP_SUPER_ADMIN = "shenoudah";
function isFollowupSuperAdmin(u) { return String((u && u.username) || "").toLowerCase() === FOLLOWUP_SUPER_ADMIN; }
function requireFollowupSuperAdmin(caller) {
  var u = requireCaller(caller);
  if (!isFollowupSuperAdmin(u)) throw new Error("forbidden_super_admin_only");
  return u;
}
// A case is visible/actionable to its currently assigned agent, or to the
// Super Admin. Historical-assignment policy (explicit, so counts can't
// leak): scoping always uses the case's CURRENT assignedAgent, never who
// held it at some point in the past. Reassigning a case moves its full
// history (notes, KPIs, everything) to the new owner immediately and it
// stops appearing anywhere for the previous owner — a case is never split
// or duplicated across two agents' views.
function fuAssertCaseAccess(u, caseObj) {
  if (!caseObj) throw new Error("case_not_found");
  if (isFollowupSuperAdmin(u)) return;
  if (String(caseObj.assignedAgent || "").toLowerCase() !== String(u.username || "").toLowerCase()) throw new Error("forbidden_case_access");
}

function genId(prefix) {
  return prefix + "-" + Utilities.formatDate(new Date(), "GMT", "yyMMdd-HHmmss") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function maskPhone(phone) {
  var d = String(phone || "");
  return d.length <= 4 ? d : d.slice(0, -4).replace(/[^\s]/g, "•") + d.slice(-4);
}

/* ---- self-healing sheets, same pattern as usersSheet()/requestsSheet() above,
   but read/written through readSheetObjects()/writeRowFields() by HEADER NAME
   rather than hardcoded column numbers — one less way for a row layout typo
   to silently shift every field over by one column. ---- */
function fuGetOrCreateSheet(name, headers) {
  var ss = activeSS();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); }
  return sh;
}
function fuCasesSheet() { return fuGetOrCreateSheet("FU_Cases", ["id","createdAt","createdBy","orderNumber","callerPhone","customerName","complaintRef","brief","notes","department","priority","assignedAgent","source","resolutionStatus","resolutionNote","resolvedBy","resolvedAt","lastNote","lastUpdate","updatedAt","version"]); }
function fuTasksSheet() { return fuGetOrCreateSheet("FU_Tasks", ["id","caseId","dueAt","alertFrom","alertTo","repeatIntervalMin","snoozeDefaultMin","snoozeUntil","status","outcome","lastFiredAt","nextAlertAt","createdAt","createdBy","completedBy","completedAt","supersededBy"]); }
function fuNotesSheet() { return fuGetOrCreateSheet("FU_Notes", ["id","caseId","author","type","text","createdAt"]); }
function fuStatusHistorySheet() { return fuGetOrCreateSheet("FU_StatusHistory", ["id","caseId","fromStatus","toStatus","reason","nextStep","actor","createdAt"]); }
function fuContactSheet() { return fuGetOrCreateSheet("FU_ContactAttempts", ["id","caseId","outcome","notes","actor","attemptedAt"]); }
function fuReminderLogSheet() { return fuGetOrCreateSheet("FU_ReminderLog", ["id","taskId","caseId","firedAt","idempotencyKey","acknowledgedBy","acknowledgedAt","ackAction"]); }
function fuAssignSheet() { return fuGetOrCreateSheet("FU_AssignmentHistory", ["id","caseId","fromAgent","toAgent","actor","createdAt"]); }
function fuChatSheet() { return fuGetOrCreateSheet("FU_Chat", ["id","fromUser","toUser","caseId","text","createdAt","readAt","ackAt"]); }
function fuAuditSheet() { return fuGetOrCreateSheet("FU_Audit", ["id","actor","action","caseId","details","createdAt"]); }
function fuAudit(actor, action, caseId, details) {
  try { fuAuditSheet().appendRow([genId("AUD"), actor, action, caseId || "", details ? JSON.stringify(details) : "", new Date().toISOString()]); } catch (e) {}
}

function readSheetObjects(sh) {
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var o = { _row: i + 1 };
    for (var c = 0; c < headers.length; c++) o[headers[c]] = data[i][c];
    out.push(o);
  }
  return out;
}
function findRowById(sh, id) {
  var objs = readSheetObjects(sh);
  for (var i = 0; i < objs.length; i++) if (objs[i].id === id) return objs[i];
  return null;
}
function writeRowFields(sh, row, patch) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(patch).forEach(function (k) {
    var col = headers.indexOf(k);
    if (col === -1) return;
    sh.getRange(row, col + 1).setValue(patch[k]);
  });
}

/* ---------- cases: create / list / get ---------- */
function fuCreateCase(caller, d) {
  var u = requireCaller(caller);
  d = d || {};
  var brief = String(d.brief || "").trim();
  if (!brief) throw new Error("brief_required");
  var dueAt = d.dueAt ? new Date(d.dueAt) : null;
  if (!dueAt || isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) throw new Error("due_date_must_be_future");

  var assignedAgent = d.assignedAgent ? String(d.assignedAgent).trim() : u.username;
  // Only the Super Admin may open a case directly under someone else's name.
  if (assignedAgent.toLowerCase() !== u.username.toLowerCase() && !isFollowupSuperAdmin(u)) {
    throw new Error("forbidden_assign");
  }

  var now = new Date().toISOString();
  var id = genId("FUC");
  fuCasesSheet().appendRow([
    id, now, u.username, d.orderNumber || "", d.callerPhone || "", d.customerName || "", d.complaintRef || "",
    brief, d.notes || "", d.department || "", d.priority || "High", assignedAgent, d.source || "",
    "pending", "", "", "", "", now, now, 1
  ]);
  // Seed status history with the initial "pending" state so "status as of
  // any cutoff" (used by the KPI math below) always has a real row to read
  // instead of needing a magic default for cases with no history yet.
  fuStatusHistorySheet().appendRow([genId("FSH"), id, "", "pending", "Case opened", "", u.username, now]);
  fuAssignSheet().appendRow([genId("FAS"), id, "", assignedAgent, u.username, now]);

  var taskId = genId("FUT");
  fuTasksSheet().appendRow([
    taskId, id, dueAt.toISOString(), d.alertFrom || "14:00", d.alertTo || "17:00",
    Number(d.repeatIntervalMin) || 15, Number(d.snoozeDefaultMin) || 10, "", "scheduled", "", "", dueAt.toISOString(), now, u.username, "", "", ""
  ]);
  fuAudit(u.username, "case_created", id, { assignedAgent: assignedAgent });
  return { id: id, taskId: taskId };
}

function fuActiveTaskForCase(caseId) {
  var tasks = readSheetObjects(fuTasksSheet()).filter(function (t) { return t.caseId === caseId && t.status === "scheduled"; });
  if (!tasks.length) return null;
  tasks.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return tasks[0];
}
function fuVisibleCases(u, agentFilter) {
  var cases = readSheetObjects(fuCasesSheet());
  if (!isFollowupSuperAdmin(u)) {
    cases = cases.filter(function (c) { return String(c.assignedAgent || "").toLowerCase() === String(u.username || "").toLowerCase(); });
  } else if (agentFilter) {
    cases = cases.filter(function (c) { return String(c.assignedAgent || "").toLowerCase() === String(agentFilter).toLowerCase(); });
  }
  return cases;
}
function fuOverdueTaskCaseIds(cutoffMs) {
  var tasks = readSheetObjects(fuTasksSheet()).filter(function (t) {
    return t.status === "scheduled" && new Date(t.dueAt).getTime() <= cutoffMs;
  });
  var ids = {};
  tasks.forEach(function (t) { ids[t.caseId] = true; });
  return ids;
}
// Full visible-case list with LIVE fields (current resolution status, next
// follow-up, a live "overdue as of now/selected cutoff" flag). Date-range,
// KPI-filter and search are all applied by the frontend against this one
// already-authorized set — exactly how the existing Requests/Dashboard pages
// already work (fetch once, filter client-side) — so no unauthorized row
// is ever shipped to the browser in the first place; nothing here is
// filtered-for-authorization purely in the browser.
function fuList(caller, q) {
  var u = requireCaller(caller);
  q = q || {};
  var cutoffMs = q.toUTC ? Math.min(Number(q.toUTC), Date.now()) : Date.now();
  var cases = fuVisibleCases(u, isFollowupSuperAdmin(u) ? q.agent : null);
  var overdueIds = fuOverdueTaskCaseIds(cutoffMs);
  var bulkView = isFollowupSuperAdmin(u); // admin sees many agents' cases at once -> mask phone in the list
  var out = cases.map(function (c) {
    var task = fuActiveTaskForCase(c.id);
    return {
      id: c.id, createdAt: c.createdAt, orderNumber: c.orderNumber,
      callerPhone: bulkView ? maskPhone(c.callerPhone) : c.callerPhone,
      customerName: c.customerName, complaintRef: c.complaintRef, brief: c.brief,
      department: c.department, priority: c.priority, assignedAgent: c.assignedAgent, source: c.source,
      resolutionStatus: c.resolutionStatus, lastNote: c.lastNote, lastUpdate: c.lastUpdate,
      nextFollowupAt: task ? task.dueAt : null, followupStatus: task ? task.status : "none",
      overdue: !!overdueIds[c.id]
    };
  });
  return { cases: out };
}
function fuGetCase(caller, id) {
  var u = requireCaller(caller);
  var row = findRowById(fuCasesSheet(), id);
  fuAssertCaseAccess(u, row);
  var tasks = readSheetObjects(fuTasksSheet()).filter(function (t) { return t.caseId === id; }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  var notes = readSheetObjects(fuNotesSheet()).filter(function (n) { return n.caseId === id; }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  var history = readSheetObjects(fuStatusHistorySheet()).filter(function (h) { return h.caseId === id; }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  var contacts = readSheetObjects(fuContactSheet()).filter(function (x) { return x.caseId === id; }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  var assignments = readSheetObjects(fuAssignSheet()).filter(function (x) { return x.caseId === id; });
  // Full, unmasked number here — whoever passed fuAssertCaseAccess is exactly
  // the one person who legitimately needs it to call the customer.
  return { "case": row, tasks: tasks, notes: notes, history: history, contacts: contacts, assignments: assignments };
}

/* ---------- KPIs (date-range aware, history-reconstructed) ---------- */
function fuResolutionStatusAsOf(caseId, historyByCase, cutoffMs) {
  var rows = historyByCase[caseId] || [];
  var applicable = rows.filter(function (h) { return new Date(h.createdAt).getTime() <= cutoffMs; });
  if (!applicable.length) return "pending";
  return applicable[applicable.length - 1].toStatus;
}
function fuKpis(caller, q) {
  var u = requireCaller(caller);
  q = q || {};
  var fromUTC = Number(q.fromUTC) || 0, toUTC = Number(q.toUTC) || (Date.now() + 1);
  var cutoffMs = Math.min(toUTC, Date.now());

  var cases = fuVisibleCases(u, isFollowupSuperAdmin(u) ? q.agent : null);
  // Primary population: cases CREATED within the selected range.
  var inRange = cases.filter(function (c) { var t = new Date(c.createdAt).getTime(); return t >= fromUTC && t < toUTC; });

  var allHistory = readSheetObjects(fuStatusHistorySheet());
  var historyByCase = {};
  allHistory.forEach(function (h) { (historyByCase[h.caseId] = historyByCase[h.caseId] || []).push(h); });
  Object.keys(historyByCase).forEach(function (k) { historyByCase[k].sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); }); });

  var remaining = 0, resolved = 0;
  inRange.forEach(function (c) {
    var st = fuResolutionStatusAsOf(c.id, historyByCase, cutoffMs);
    if (st === "resolved") resolved++; else remaining++; // pending | not_resolved | reopened
  });
  var total = remaining + resolved; // by construction, per spec

  // Overdue is deliberately a LIVE/snapshot metric, not scoped to the
  // creation-date range: a case opened last week that is still overdue today
  // is exactly what this KPI needs to surface. It stays scoped to the same
  // agent/ownership visibility as everything else.
  var overdueIds = fuOverdueTaskCaseIds(cutoffMs);
  var overdueCount = 0;
  cases.forEach(function (c) { if (overdueIds[c.id]) overdueCount++; });

  // "Resolved During Period" is a separate resolution-EVENT count (how many
  // times a visible case became Resolved inside the window) — kept apart
  // from Total so it is never silently mixed into the creation-date totals.
  var resolvedDuringPeriod = 0;
  var visibleIds = {}; cases.forEach(function (c) { visibleIds[c.id] = true; });
  allHistory.forEach(function (h) {
    var t = new Date(h.createdAt).getTime();
    if (h.toStatus === "resolved" && t >= fromUTC && t < toUTC && visibleIds[h.caseId]) resolvedDuringPeriod++;
  });

  return {
    remaining: remaining, resolved: resolved, total: total, overdue: overdueCount,
    resolvedDuringPeriod: resolvedDuringPeriod, resolutionRate: total ? Math.round(resolved / total * 100) : 0
  };
}

/* ---------- notes / contact attempts / resolution workflow ---------- */
var FU_RESOLUTION_STATUSES = ["pending", "resolved", "not_resolved", "reopened"];
function fuAddNote(caller, id, text, type) {
  var u = requireCaller(caller);
  var row = findRowById(fuCasesSheet(), id);
  fuAssertCaseAccess(u, row);
  text = String(text || "").trim();
  if (!text) throw new Error("note_required");
  var now = new Date().toISOString();
  fuNotesSheet().appendRow([genId("FNO"), id, u.username, type || "note", text, now]);
  writeRowFields(fuCasesSheet(), row._row, { lastNote: text, lastUpdate: now, updatedAt: now });
  fuAudit(u.username, "note_added", id, {});
  return { ok: true };
}
var FU_CONTACT_OUTCOMES = ["Answered", "No Answer", "Busy", "Wrong Number", "Callback Requested", "Customer Updated"];
function fuContactAttempt(caller, id, outcome, notes) {
  var u = requireCaller(caller);
  var row = findRowById(fuCasesSheet(), id);
  fuAssertCaseAccess(u, row);
  if (FU_CONTACT_OUTCOMES.indexOf(outcome) === -1) throw new Error("bad_outcome");
  var now = new Date().toISOString();
  fuContactSheet().appendRow([genId("FCA"), id, outcome, notes || "", u.username, now]);
  fuNotesSheet().appendRow([genId("FNO"), id, u.username, "call", "Contact attempt: " + outcome + (notes ? " — " + notes : ""), now]);
  writeRowFields(fuCasesSheet(), row._row, { lastNote: "Contact attempt: " + outcome, lastUpdate: now, updatedAt: now });
  fuAudit(u.username, "contact_attempt", id, { outcome: outcome });
  return { ok: true };
}
// Resolving/un-resolving the CUSTOMER ISSUE — independent of whether any one
// follow-up task was "completed" (see fuCompleteTask below). Reopening never
// deletes anything; it only appends a new history row and flips the live
// resolutionStatus, so the full prior trail (notes, contact attempts, past
// resolutions) stays intact.
function fuSetResolution(caller, id, status, reason, nextStep, resolutionNote) {
  var u = requireCaller(caller);
  var row = findRowById(fuCasesSheet(), id);
  fuAssertCaseAccess(u, row);
  if (FU_RESOLUTION_STATUSES.indexOf(status) === -1) throw new Error("bad_resolution_status");
  if (status === "resolved" && !String(resolutionNote || "").trim()) throw new Error("resolution_note_required");
  if (status === "not_resolved" && !String(reason || "").trim()) throw new Error("reason_required");
  if (status === "not_resolved" && !String(nextStep || "").trim()) throw new Error("next_step_required");
  var now = new Date().toISOString();
  var from = row.resolutionStatus;
  writeRowFields(fuCasesSheet(), row._row, {
    resolutionStatus: status,
    resolutionNote: status === "resolved" ? String(resolutionNote || "").trim() : row.resolutionNote,
    resolvedBy: status === "resolved" ? u.username : row.resolvedBy,
    resolvedAt: status === "resolved" ? now : row.resolvedAt,
    lastUpdate: now, updatedAt: now, version: (Number(row.version) || 1) + 1
  });
  fuStatusHistorySheet().appendRow([genId("FSH"), id, from, status, reason || "", nextStep || "", u.username, now]);
  var noteText = "Resolution status: " + from + " → " + status + (reason ? " — " + reason : "") + (nextStep ? " (Next: " + nextStep + ")" : "");
  fuNotesSheet().appendRow([genId("FNO"), id, u.username, "status_change", noteText, now]);
  fuAudit(u.username, "resolution_status_changed", id, { from: from, to: status });
  return { ok: true };
}
// Completing a FOLLOW-UP TASK — stops that task's own reminders. Deliberately
// does NOT touch resolutionStatus or close any ETM complaint: an agent can
// mark "contacted, customer needs 2 more days" without that implying the
// underlying issue is resolved.
function fuCompleteTask(caller, caseId, outcome, notes) {
  var u = requireCaller(caller);
  var caseRow = findRowById(fuCasesSheet(), caseId);
  fuAssertCaseAccess(u, caseRow);
  var task = fuActiveTaskForCase(caseId);
  if (!task) throw new Error("no_active_task");
  if (!outcome) throw new Error("outcome_required");
  var now = new Date().toISOString();
  writeRowFields(fuTasksSheet(), task._row, { status: "completed", outcome: outcome, completedBy: u.username, completedAt: now });
  fuNotesSheet().appendRow([genId("FNO"), caseId, u.username, "note", "Follow-up completed — outcome: " + outcome + (notes ? " — " + notes : ""), now]);
  writeRowFields(fuCasesSheet(), caseRow._row, { lastNote: "Follow-up completed: " + outcome, lastUpdate: now, updatedAt: now });
  fuAudit(u.username, "task_completed", caseId, { outcome: outcome });
  return { ok: true };
}
// Reschedule: new future due date + required reason. The old task row is
// never edited in place — it's marked cancelled/superseded so the previous
// schedule stays visible in history, and a cancelled task is no longer
// "scheduled" so processFollowupReminders() can never fire it again.
function fuReschedule(caller, caseId, dueAtIso, reason, alertFrom, alertTo, repeatIntervalMin) {
  var u = requireCaller(caller);
  var caseRow = findRowById(fuCasesSheet(), caseId);
  fuAssertCaseAccess(u, caseRow);
  var dueAt = new Date(dueAtIso);
  if (isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) throw new Error("due_date_must_be_future");
  if (!String(reason || "").trim()) throw new Error("reason_required");
  var now = new Date().toISOString();
  var oldTask = fuActiveTaskForCase(caseId);
  var newTaskId = genId("FUT");
  if (oldTask) {
    writeRowFields(fuTasksSheet(), oldTask._row, { status: "cancelled", supersededBy: newTaskId, completedBy: u.username, completedAt: now });
  }
  fuTasksSheet().appendRow([
    newTaskId, caseId, dueAt.toISOString(),
    alertFrom || (oldTask && oldTask.alertFrom) || "14:00", alertTo || (oldTask && oldTask.alertTo) || "17:00",
    Number(repeatIntervalMin) || (oldTask && Number(oldTask.repeatIntervalMin)) || 15,
    (oldTask && Number(oldTask.snoozeDefaultMin)) || 10,
    "", "scheduled", "", "", dueAt.toISOString(), now, u.username, "", "", ""
  ]);
  fuNotesSheet().appendRow([genId("FNO"), caseId, u.username, "reschedule", "Rescheduled to " + dueAt.toISOString() + " — " + reason, now]);
  writeRowFields(fuCasesSheet(), caseRow._row, { lastNote: "Rescheduled — " + reason, lastUpdate: now, updatedAt: now });
  fuAudit(u.username, "rescheduled", caseId, { newTaskId: newTaskId, reason: reason });
  return { ok: true, taskId: newTaskId };
}
function fuSnooze(caller, caseId, minutes) {
  var u = requireCaller(caller);
  var caseRow = findRowById(fuCasesSheet(), caseId);
  fuAssertCaseAccess(u, caseRow);
  var task = fuActiveTaskForCase(caseId);
  if (!task) throw new Error("no_active_task");
  var mins = Number(minutes) || Number(task.snoozeDefaultMin) || 10;
  var until = new Date(Date.now() + mins * 60000);
  var now = new Date().toISOString();
  // nextAlertAt is set to exactly the snooze-wake time, not recomputed from
  // the task's original due-time grid — that's what keeps a 14:30 snooze-10
  // waking at 14:40 and then repeating every 15 from THERE (14:55, 15:10…)
  // instead of also firing the original 14:45 slot.
  writeRowFields(fuTasksSheet(), task._row, { snoozeUntil: until.toISOString(), nextAlertAt: until.toISOString() });
  fuNotesSheet().appendRow([genId("FNO"), caseId, u.username, "snooze", "Snoozed " + mins + " min, until " + until.toISOString(), now]);
  fuAudit(u.username, "snoozed", caseId, { minutes: mins });
  return { ok: true, snoozeUntil: until.toISOString() };
}
function fuReassign(caller, caseId, toAgent) {
  var u = requireFollowupSuperAdmin(caller);
  var caseRow = findRowById(fuCasesSheet(), caseId);
  if (!caseRow) throw new Error("case_not_found");
  toAgent = String(toAgent || "").trim();
  if (!toAgent) throw new Error("to_agent_required");
  var now = new Date().toISOString();
  var from = caseRow.assignedAgent;
  writeRowFields(fuCasesSheet(), caseRow._row, { assignedAgent: toAgent, lastUpdate: now, updatedAt: now });
  fuAssignSheet().appendRow([genId("FAS"), caseId, from, toAgent, u.username, now]);
  fuNotesSheet().appendRow([genId("FNO"), caseId, u.username, "handoff", "Reassigned from " + from + " to " + toAgent, now]);
  fuAudit(u.username, "reassigned", caseId, { from: from, to: toAgent });
  return { ok: true };
}

/* ---------- reminder scheduling (idempotent, restart-safe) ---------- */
function fuParseHM(s) {
  var m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
// Pan Home's business timezone (UAE), used explicitly rather than relying on
// the Apps Script PROJECT's own timezone setting (Project Settings, which
// could be left at its default and silently disagree with "14:00-17:00"
// meaning Dubai time) — this way the alert window means the same wall-clock
// time regardless of how that setting happens to be configured.
var BUSINESS_TIMEZONE = "Asia/Dubai";
function fuNowMinutesOfDay(now) {
  var hm = Utilities.formatDate(now, BUSINESS_TIMEZONE, "HH:mm");
  return fuParseHM(hm);
}
// Run from a time-driven trigger (see installFollowupReminderTrigger below),
// every 5 minutes. Evaluates every active task against its alert window,
// repeat interval and any snooze, and "fires" (logs) the ones that are due.
// The whole run is wrapped in the SAME script lock every write action in
// this file already uses, so two overlapping executions (a trigger racing a
// manual re-run, or a restart re-firing the trigger) cannot both fire the
// same task for the same slot — the idempotency key is still recorded per
// firing as a second line of defense/audit trail, not the primary guard.
function processFollowupReminders() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return; }
  try {
    var now = new Date();
    var nowMs = now.getTime();
    var sh = fuTasksSheet();
    var tasks = readSheetObjects(sh).filter(function (t) { return t.status === "scheduled"; });
    tasks.forEach(function (t) {
      if (t.snoozeUntil && new Date(t.snoozeUntil).getTime() > nowMs) return;
      var fromM = fuParseHM(t.alertFrom), toM = fuParseHM(t.alertTo);
      var nowM = fuNowMinutesOfDay(now);
      if (fromM != null && toM != null && !(nowM >= fromM && nowM <= toM)) return; // outside window: no repeats after alertTo
      var nextAt = t.nextAlertAt ? new Date(t.nextAlertAt).getTime() : new Date(t.dueAt).getTime();
      if (nowMs < nextAt) return;
      var idKey = t.id + "@" + nextAt;
      fuReminderLogSheet().appendRow([genId("FRL"), t.id, t.caseId, now.toISOString(), idKey, "", "", ""]);
      writeRowFields(sh, t._row, {
        lastFiredAt: now.toISOString(),
        nextAlertAt: new Date(nowMs + (Number(t.repeatIntervalMin) || 15) * 60000).toISOString()
      });
    });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}
// One-time setup: run this ONCE from the Apps Script editor (select it in the
// function dropdown, then Run). Safe to re-run — it removes any previous
// copy of this exact trigger first, so re-running it can never end up with
// two installed and double-firing every reminder.
function installFollowupReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === "processFollowupReminders") ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger("processFollowupReminders").timeBased().everyMinutes(5).create();
}
function fuDueReminders(caller) {
  var u = requireCaller(caller);
  var cases = fuVisibleCases(u, null);
  var caseIds = {}; cases.forEach(function (c) { caseIds[c.id] = c; });
  var logs = readSheetObjects(fuReminderLogSheet()).filter(function (l) { return caseIds[l.caseId] && !l.acknowledgedAt; });
  return { reminders: logs.map(function (l) {
    var c = caseIds[l.caseId];
    return { logId: l.id, caseId: l.caseId, taskId: l.taskId, firedAt: l.firedAt, brief: c.brief, orderNumber: c.orderNumber, priority: c.priority, assignedAgent: c.assignedAgent };
  }) };
}
function fuAckReminder(caller, logId, action) {
  var u = requireCaller(caller);
  var log = findRowById(fuReminderLogSheet(), logId);
  if (!log) throw new Error("reminder_not_found");
  var caseRow = findRowById(fuCasesSheet(), log.caseId);
  fuAssertCaseAccess(u, caseRow);
  writeRowFields(fuReminderLogSheet(), log._row, { acknowledgedBy: u.username, acknowledgedAt: new Date().toISOString(), ackAction: action || "dismiss" });
  return { ok: true };
}

/* ---------- admin overview (Super Admin only) ---------- */
function fuAdminOverview(caller, q) {
  requireFollowupSuperAdmin(caller);
  q = q || {};
  var cases = readSheetObjects(fuCasesSheet());
  if (q.fromUTC || q.toUTC) {
    var fromUTC = Number(q.fromUTC) || 0, toUTC = Number(q.toUTC) || (Date.now() + 1);
    cases = cases.filter(function (c) { var t = new Date(c.createdAt).getTime(); return t >= fromUTC && t < toUTC; });
  }
  var cutoffMs = q.toUTC ? Math.min(Number(q.toUTC), Date.now()) : Date.now();
  var overdueIds = fuOverdueTaskCaseIds(cutoffMs);
  var byAgent = {};
  cases.forEach(function (c) {
    var a = c.assignedAgent || "Unassigned";
    if (!byAgent[a]) byAgent[a] = { agent: a, total: 0, remaining: 0, resolved: 0, notResolved: 0, overdue: 0, lastActivity: 0 };
    var g = byAgent[a];
    g.total++;
    if (c.resolutionStatus === "resolved") g.resolved++;
    else { g.remaining++; if (c.resolutionStatus === "not_resolved") g.notResolved++; }
    if (overdueIds[c.id]) g.overdue++;
    var t = new Date(c.lastUpdate || c.updatedAt || c.createdAt).getTime();
    if (t > g.lastActivity) g.lastActivity = t;
  });
  return { agents: Object.keys(byAgent).map(function (k) { return byAgent[k]; }).sort(function (a, b) { return b.total - a.total; }) };
}

/* ---------- Shenoudah <-> agent private chat ---------- */
function chatThreadKey(a, b) { return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("|"); }
function chatSend(caller, toUser, caseId, text) {
  var u = requireCaller(caller);
  text = String(text || "").trim();
  if (!text) throw new Error("text_required");
  toUser = String(toUser || "").trim();
  if (!toUser) throw new Error("to_user_required");
  // Admin may message any agent; an employee may only ever write to the
  // Super Admin's own thread — never fan a message out to another employee.
  if (!isFollowupSuperAdmin(u) && toUser.toLowerCase() !== FOLLOWUP_SUPER_ADMIN) throw new Error("forbidden_recipient");
  var now = new Date().toISOString();
  var id = genId("FCH");
  fuChatSheet().appendRow([id, u.username, toUser, caseId || "", text, now, "", ""]);
  return { id: id };
}
function chatList(caller, withUser) {
  var u = requireCaller(caller);
  var other = isFollowupSuperAdmin(u) ? String(withUser || "").trim() : FOLLOWUP_SUPER_ADMIN;
  if (!other) throw new Error("with_user_required");
  var key = chatThreadKey(u.username, other);
  var rows = readSheetObjects(fuChatSheet()).filter(function (m) { return chatThreadKey(m.fromUser, m.toUser) === key; });
  rows.sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  return { messages: rows };
}
function chatUnreadCount(caller) {
  var u = requireCaller(caller);
  var rows = readSheetObjects(fuChatSheet()).filter(function (m) {
    return String(m.toUser).toLowerCase() === String(u.username).toLowerCase() && !m.readAt;
  });
  return { count: rows.length };
}
function chatMarkRead(caller, ids) {
  var u = requireCaller(caller);
  ids = ids || [];
  var sh = fuChatSheet();
  var rows = readSheetObjects(sh);
  var now = new Date().toISOString();
  rows.forEach(function (m) {
    if (ids.indexOf(m.id) === -1) return;
    // Only the recipient can mark their own inbound message read/acknowledged.
    if (String(m.toUser).toLowerCase() !== String(u.username).toLowerCase()) return;
    writeRowFields(sh, m._row, { readAt: m.readAt || now, ackAt: now });
  });
  return { ok: true };
}
