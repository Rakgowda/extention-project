async function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return;
    } catch (err) {
      console.error("Could not enable openPanelOnActionClick", err);
    }
  }
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
  });
}

setupSidePanel();
