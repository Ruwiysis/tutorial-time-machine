/**
 * Service worker. Deliberately does no AI work: MV3 service workers can be
 * stopped at any time and have no DOM, so all model calls run in the side
 * panel (an extension page).
 */
chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
