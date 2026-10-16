/**
 * VoxOverlay Background Service Worker (Manifest V3 for Brave / Chromium)
 * Handles toolbar icon clicks, right-click context menu ("Read aloud with VoxOverlay"),
 * and global keyboard shortcuts (Alt+R, Alt+Space).
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "voxoverlay-read-selection",
    title: "Read aloud with VoxOverlay",
    contexts: ["selection", "page"],
  });
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    // If content script isn't injected yet on an already-open tab, inject it dynamically
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }, 120);
    } catch (injectErr) {
      console.warn(
        "VoxOverlay cannot run on restricted browser pages:",
        injectErr,
      );
    }
  }
}

chrome.action.onClicked.addListener(() => {
  sendToActiveTab({ command: "toggle-hud" });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "voxoverlay-read-selection") {
    sendToActiveTab({
      command: "read-selection-or-page",
      selectionText: info.selectionText || "",
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-reader") {
    sendToActiveTab({ command: "toggle-hud" });
  } else if (command === "play-pause") {
    sendToActiveTab({ command: "play-pause" });
  }
});
