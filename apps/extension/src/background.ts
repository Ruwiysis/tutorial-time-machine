/**
 * Service worker. Deliberately does no AI work: MV3 service workers can be
 * stopped at any time and have no DOM, so all model calls run in the side
 * panel (an extension page). The toolbar button opens the popup, which has an
 * "Open side panel" button.
 */
chrome.runtime.onInstalled.addListener(() => {
  // An earlier build opened the panel on toolbar click; the popup owns that click now.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});
