// Minimal service worker. The extension does its work entirely in the
// content script injected on the ETM trips-plan pages; this just opens
// the Options page on first install so defaults (warehouse, CBM, slots)
// can be reviewed before first use.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});
