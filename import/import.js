import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.min.mjs");

// Known ETM order-number prefixes (2-4 uppercase letters followed by 7
// digits, e.g. BR0034978, WU1112563, YR0005133). Extend this list if a
// new prefix shows up in a Trip Report that isn't being recognized.
const ORDER_PREFIXES = ["BR", "IS", "WU", "YR", "RW", "TR", "YS", "NS", "TS", "BS", "VS", "TM"];
const ORDER_RE = new RegExp(`\\b(${ORDER_PREFIXES.join("|")})\\d{6,8}\\b`, "g");

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const actionsEl = document.getElementById("actions");
const saveBtn = document.getElementById("saveBtn");
const saveStatusEl = document.getElementById("saveStatus");

let parsedMap = null; // orderNumber -> { tripNumber, team, teamName, destination }
let parsedDate = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

async function extractText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += "\n" + content.items.map((it) => it.str).join(" ");
    setStatus(`Reading page ${i} of ${pdf.numPages}...`);
  }
  return text;
}

/**
 * Parses the Trip Report's text into order -> trip info. Tolerant of
 * exact whitespace/line-break differences in how pdf.js extracts text,
 * since it works off regex markers ("Trip:", "Destination:", "Team:")
 * rather than fixed positions.
 */
function parseTripReport(fullText) {
  const dateMatch = fullText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const date = dateMatch ? dateMatch[1] : null;

  const tripMarkers = [...fullText.matchAll(/Trip:\s*(\d+)/g)];
  const map = {};
  const trips = [];

  for (let i = 0; i < tripMarkers.length; i++) {
    const tripNo = parseInt(tripMarkers[i][1], 10);
    const start = tripMarkers[i].index;
    const end = i + 1 < tripMarkers.length ? tripMarkers[i + 1].index : fullText.length;
    const segment = fullText.slice(start, end);

    // Bounded + single-line: the report's Destination field is normally a
    // short "AUH | 317|319" style value on one line. A handful of rows in
    // real exports have overlapping text boxes that glue extra characters
    // into this field (e.g. "T6e1a8m Name:") - capping the length keeps
    // that from swallowing the rest of the trip block. The order numbers
    // below are unaffected either way, since they're matched independently.
    const destMatch = segment.match(/Destination:\s*([^\n]{0,60}?)\s*(?:Team Name:|$)/);
    const destination = destMatch ? destMatch[1].trim() : null;

    const teamMatch = segment.match(/\bTeam:\s*(\S+)/);
    const team = teamMatch ? teamMatch[1] : null;

    const teamNameMatch = segment.match(/Team Name:\s*([^\n]{0,60}?)\s*(?:Orders:|$)/);
    const teamName = teamNameMatch ? teamNameMatch[1].trim() : null;

    const orderMatches = [...segment.matchAll(ORDER_RE)].map((m) => m[0]);
    const uniqueOrders = Array.from(new Set(orderMatches));

    trips.push({ tripNo, destination, team, teamName, orderCount: uniqueOrders.length });
    for (const orderNo of uniqueOrders) {
      map[orderNo] = { tripNumber: tripNo, team, teamName, destination };
    }
  }

  return { date, map, trips };
}

function renderPreview(trips, map) {
  const totalOrders = Object.keys(map).length;
  const rows = trips
    .map(
      (t) => `
    <tr>
      <td>${t.tripNo}</td>
      <td>${t.team || ""}</td>
      <td>${t.teamName || ""}</td>
      <td>${t.destination || ""}</td>
      <td>${t.orderCount}</td>
    </tr>`
    )
    .join("");
  previewEl.innerHTML = `
    <p><b>${trips.length}</b> trips, <b>${totalOrders}</b> orders recognized${parsedDate ? ` for ${parsedDate}` : ""}.</p>
    <table>
      <thead><tr><th>Trip</th><th>Team</th><th>Team Name</th><th>Destination</th><th>Orders</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function handleFile(file) {
  if (!file || file.type !== "application/pdf") {
    setStatus("Please choose a PDF file.", "error");
    return;
  }
  actionsEl.style.display = "none";
  previewEl.innerHTML = "";
  setStatus("Reading PDF...");
  try {
    const text = await extractText(file);
    const { date, map, trips } = parseTripReport(text);
    if (!trips.length) {
      setStatus(
        "Couldn't find any \"Trip:\" blocks in this PDF - is it the ETM Trip Report format?",
        "error"
      );
      return;
    }
    parsedMap = map;
    parsedDate = date;
    renderPreview(trips, map);
    setStatus(`Parsed ${trips.length} trips / ${Object.keys(map).length} orders.`, "ok");
    actionsEl.style.display = "flex";
  } catch (e) {
    setStatus("Failed to read this PDF: " + (e && e.message ? e.message : e), "error");
  }
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

saveBtn.addEventListener("click", () => {
  if (!parsedMap) return;
  chrome.storage.local.set(
    { importedTripMap: parsedMap, importedTripMapDate: parsedDate, importedTripMapAt: Date.now() },
    () => {
      saveStatusEl.textContent = "Saved. Go back to the ETM List Orders page and click \"Use Imported Trip Report\".";
    }
  );
});
