(() => {
  const SCRIPT_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_err) {
      return "1.4.0";
    }
  })();
  if (window.__localLlmAssistantVersion === SCRIPT_VERSION) return;
  window.__localLlmAssistantVersion = SCRIPT_VERSION;

  const PLATFORM =
    location.hostname === "web.whatsapp.com"
      ? "whatsapp"
      : /(^|\.)instagram\.com$/.test(location.hostname)
        ? "instagram"
        : null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "PING") {
      sendResponse({ ok: true, platform: PLATFORM, version: SCRIPT_VERSION });
      return;
    }

    if (!PLATFORM) {
      sendResponse({ ok: false, error: "Unsupported page." });
      return;
    }

    if (message.type === "READ_CONVERSATION") {
      try {
        sendResponse(PLATFORM === "whatsapp" ? readWhatsApp() : readInstagram());
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

    if (message.type === "INSERT_REPLY") {
      insertReply(String(message.text || ""))
        .then(sendResponse)
        .catch((err) =>
          sendResponse({ ok: false, error: String((err && err.message) || err) })
        );
      return true;
    }
  });

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function whatsappTitle(root) {
    const header = root.querySelector("header") || document.querySelector("#main header");
    if (header) {
      const el =
        header.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
        header.querySelector('[data-testid="conversation-info-header"] span[title]') ||
        header.querySelector('span[dir="auto"][title]') ||
        header.querySelector("span[title]") ||
        header.querySelector('span[dir="auto"]');
      if (el) {
        const text = cleanText(el.getAttribute("title") || el.textContent);
        if (text) return text;
      }
    }
    return cleanText(
      document.title
        .replace(/^\(\d+\)\s*/, "")
        .replace(/\s*[-|\u2013]\s*WhatsApp.*$/i, "")
    );
  }

  function whatsappList(root) {
    return (
      root.querySelector('[data-testid="conversation-panel-messages"]') ||
      root.querySelector('[role="application"]') ||
      root
    );
  }

  function whatsappRow(node) {
    return (
      node.closest('[role="row"][data-id]') ||
      node.closest('[data-testid^="conv-msg-"]') ||
      node.closest('[data-testid="msg-container"]') ||
      node.closest("div.message-in, div.message-out") ||
      node.closest('[role="row"]') ||
      node.closest("[data-id]") ||
      node
    );
  }

  function whatsappText(row) {
    const clone = row.cloneNode(true);

    for (const emoji of clone.querySelectorAll("img.emoji")) {
      emoji.replaceWith(document.createTextNode(emoji.getAttribute("alt") || ""));
    }

    const junk = [
      '[data-testid="quoted-message"]',
      '[data-testid*="quote"]',
      '[data-testid="msg-meta"]',
      '[data-testid="msg-time"]',
      '[data-testid="msg-status"]',
      '[data-testid="msg-edited"]',
      '[data-testid="edited"]',
      ".quoted-mention",
      '[role="button"]',
      "button",
      "svg",
      "audio",
      "video",
      '[aria-label*="react" i]',
    ].join(",");

    for (const el of clone.querySelectorAll(junk)) el.remove();

    const textSelector = [
      '[data-testid="selectable-text"]',
      "span.selectable-text",
      "div.selectable-text",
    ].join(",");
    const isLeafText = (el) => !el.querySelector(textSelector);

    let parts = [];

    for (const meta of clone.querySelectorAll("[data-pre-plain-text]")) {
      const spans = Array.from(meta.querySelectorAll(textSelector)).filter(isLeafText);
      if (spans.length) parts.push(...spans.map((span) => span.textContent));
      else parts.push(meta.textContent);
    }

    if (!parts.length) {
      parts = Array.from(clone.querySelectorAll(textSelector))
        .filter(isLeafText)
        .map((el) => el.textContent);
    }

    if (!parts.length) {
      parts = Array.from(clone.querySelectorAll(".copyable-text"))
        .filter((el) => !el.querySelector(".copyable-text"))
        .map((el) => el.textContent);
    }

    if (!parts.length) parts = [clone.innerText || clone.textContent || ""];

    return cleanText(
      parts
        .map((part) => cleanText(part))
        .filter(Boolean)
        .join(" ")
    );
  }

  function whatsappFrom(row, listRect) {
    if (row.matches(".message-out") || row.querySelector(".message-out")) return "me";
    if (row.matches(".message-in") || row.querySelector(".message-in")) return "them";

    const carrier = row.matches("[data-id]") ? row : row.querySelector("[data-id]");
    const id = carrier ? String(carrier.getAttribute("data-id") || "") : "";
    if (id.startsWith("true_")) return "me";
    if (id.startsWith("false_")) return "them";

    if (row.querySelector('[data-testid="msg-outgoing"], [data-testid="outgoing"]')) return "me";
    if (row.querySelector('[data-testid="msg-incoming"], [data-testid="incoming"]')) return "them";
    if (row.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"]')) return "me";

    const bubble = row.querySelector('[data-testid="msg-container"]') || row;
    const rect = bubble.getBoundingClientRect();
    if (rect.width && listRect.width) {
      const center = rect.left + rect.width / 2;
      const listCenter = listRect.left + listRect.width / 2;
      if (Math.abs(center - listCenter) > 2) return center > listCenter ? "me" : "them";
    }

    return "them";
  }

  function whatsappMessageRows(list) {
    const selector = [
      '[data-testid="msg-container"]',
      '[data-testid^="conv-msg-"]',
      "div.message-in",
      "div.message-out",
      '[role="row"][data-id]',
      '[role="row"]',
      "[data-id]",
    ].join(",");

    const rows = new Set();

    for (const node of list.querySelectorAll(selector)) {
      if (!isVisible(node)) continue;
      if (node.closest('footer, [contenteditable="true"], [data-testid="composer"]')) continue;

      const row = whatsappRow(node);
      if (!row || row === list) continue;

      const hasText = row.querySelector(
        '[data-pre-plain-text], [data-testid="selectable-text"], .selectable-text, .copyable-text'
      );
      if (!hasText) continue;

      rows.add(row);
    }

    if (!rows.size) {
      for (const anchor of list.querySelectorAll("[data-pre-plain-text]")) {
        if (!isVisible(anchor)) continue;
        rows.add(whatsappRow(anchor));
      }
    }

    return Array.from(rows);
  }

  function whatsappDebug(list) {
    return {
      msgContainers: list.querySelectorAll('[data-testid="msg-container"]').length,
      convMessages: list.querySelectorAll('[data-testid^="conv-msg-"]').length,
      messageClasses: list.querySelectorAll("div.message-in, div.message-out").length,
      dataIdRows: list.querySelectorAll('[role="row"][data-id]').length,
      prePlainText: list.querySelectorAll("[data-pre-plain-text]").length,
      textNodes: list.querySelectorAll(
        '[data-testid="selectable-text"], .selectable-text'
      ).length,
    };
  }

  function readWhatsApp() {
    const root =
      document.querySelector("#main") ||
      document.querySelector('[data-testid="conversation-panel-wrapper"]');
    if (!root) return { ok: false, error: "Open a WhatsApp conversation first." };

    const list = whatsappList(root);
    const title = whatsappTitle(root);
    const listRect = list.getBoundingClientRect();
    const rows = whatsappMessageRows(list);
    const messages = [];
    const seenIds = new Set();

    for (const row of rows) {
      if (!isVisible(row)) continue;

      const text = whatsappText(row);
      if (!text) continue;

      const carrier = row.matches("[data-id]") ? row : row.querySelector("[data-id]");
      const id = carrier ? String(carrier.getAttribute("data-id") || "") : "";
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      let sender = "";
      const meta = row.querySelector("[data-pre-plain-text]");
      if (meta) {
        const raw = meta.getAttribute("data-pre-plain-text") || "";
        const match = raw.match(/\]\s*(.+?):\s*$/);
        if (match) sender = match[1].trim();
      }

      let body = text;
      if (sender && body.startsWith(sender)) {
        body = body.slice(sender.length).replace(/^[\s:]+/, "").trim();
      }
      if (!body) continue;

      messages.push({
        from: whatsappFrom(row, listRect),
        sender,
        text: body,
      });
    }

    if (!messages.length) {
      return {
        ok: false,
        error: "No messages found in this chat. Reload WhatsApp and try again.",
        debug: whatsappDebug(list),
      };
    }

    return { ok: true, platform: "whatsapp", title, messages: messages.slice(-60) };
  }

  function instagramMessagesContainer(main) {
    let best = null;
    let bestGroups = 0;
    let bestChildren = 0;

    for (const el of main.querySelectorAll("div")) {
      const children = el.children;
      if (children.length < 2) continue;

      let groups = 0;
      for (const child of children) {
        if (child.querySelector && child.querySelector('[role="group"]')) groups++;
      }

      if (groups < 2) continue;

      if (groups > bestGroups || (groups === bestGroups && children.length > bestChildren)) {
        bestGroups = groups;
        bestChildren = children.length;
        best = el;
      }
    }

    return best;
  }

  function instagramTitle(main) {
    for (const link of main.querySelectorAll('a[href^="/"]')) {
      const href = link.getAttribute("href") || "";
      if (href === "/") continue;
      if (/^\/(direct|explore|reels|accounts|p|stories|about|legal)\b/i.test(href)) continue;
      const text = cleanText(link.textContent);
      if (text && text.length < 60) return text;
    }

    const heading = main.querySelector("h2");
    if (heading) {
      const text = cleanText(heading.textContent);
      if (text) return text;
    }

    return cleanText(document.title).split(/[•|\u00b7]/)[0].trim();
  }

  function instagramText(row) {
    let parts = Array.from(row.querySelectorAll('span[dir="auto"]'))
      .filter((span) => {
        if (!isVisible(span)) return false;
        if (span.closest('a[aria-label^="Open the profile page"]')) return false;
        if (span.closest('a[role="link"]')) return false;
        if (span.closest('[role="button"]')) return false;
        return cleanText(span.textContent).length > 0;
      })
      .map((span) => cleanText(span.textContent));

    if (!parts.length) {
      parts = Array.from(row.querySelectorAll('div[dir="auto"]'))
        .filter(
          (el) =>
            isVisible(el) &&
            !el.querySelector('span[dir="auto"]') &&
            !el.closest('[role="button"]')
        )
        .map((el) => cleanText(el.textContent))
        .filter(Boolean);
    }

    const unique = [];
    for (const part of parts) {
      if (unique[unique.length - 1] !== part) unique.push(part);
    }
    return cleanText(unique.join(" "));
  }

  function instagramSender(row, paneRect) {
    const content =
      row.querySelector('span[dir="auto"]') || row.querySelector('[role="group"]') || row;
    const rect = content.getBoundingClientRect();

    if (rect.width && paneRect.width) {
      const center = rect.left + rect.width / 2;
      const paneCenter = paneRect.left + paneRect.width / 2;
      if (Math.abs(center - paneCenter) > 2) {
        return center > paneCenter ? "me" : "them";
      }
    }

    if (row.querySelector('a[aria-label^="Open the profile page"]')) return "them";

    const presentation = row.querySelector('[role="presentation"]');
    if (presentation) {
      const classes = String(presentation.className || "");
      if (classes.includes("x88qbow")) return "them";
      if (classes.includes("x5slmwz")) return "me";
    }

    return "me";
  }

  function readInstagram() {
    const main = document.querySelector('div[role="main"], main') || document.body;
    if (!main) return { ok: false, error: "Open an Instagram chat first." };

    const container = instagramMessagesContainer(main);
    if (!container) return { ok: false, error: "Open an Instagram chat first." };

    const title = instagramTitle(main);
    const paneRect = container.getBoundingClientRect();
    const messages = [];

    for (const row of container.children) {
      if (!row.querySelector) continue;
      if (!row.querySelector('[role="group"]')) continue;
      if (!isVisible(row)) continue;

      const text = instagramText(row);
      if (!text) continue;

      messages.push({ from: instagramSender(row, paneRect), sender: "", text });
    }

    return { ok: true, platform: "instagram", title, messages: messages.slice(-60) };
  }

  function whatsappComposer() {
    const selectors = [
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
      '#main [contenteditable="true"][data-lexical-editor="true"]',
      'footer div[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const list = document.querySelectorAll(selector);
      for (let i = list.length - 1; i >= 0; i--) {
        if (isVisible(list[i])) return list[i];
      }
    }
    return null;
  }

  function instagramComposer() {
    const selectors = [
      'div[role="main"] textarea[placeholder]',
      'div[role="main"] div[contenteditable="true"][role="textbox"]',
      'div[role="main"] div[contenteditable="true"]',
      'textarea[aria-label="Message" i]',
      'div[contenteditable="true"][aria-label="Message" i]',
    ];
    for (const selector of selectors) {
      const list = document.querySelectorAll(selector);
      for (let i = list.length - 1; i >= 0; i--) {
        const el = list[i];
        if (isVisible(el) && !el.closest('[role="dialog"]')) return el;
      }
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function moveCaretToEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function pasteText(el, text) {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch (_err) {
      /* clipboard events are best-effort */
    }
  }

  async function insertReply(text) {
    if (!text.trim()) return { ok: false, error: "The reply is empty." };

    const input = PLATFORM === "whatsapp" ? whatsappComposer() : instagramComposer();
    if (!input) {
      return {
        ok: false,
        error: "Message box not found. Click the chat input once, then retry.",
      };
    }

    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      setNativeValue(input, text);
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    input.focus();
    const before = input.textContent || "";
    moveCaretToEnd(input);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_err) {
      inserted = false;
    }

    if (!inserted || input.textContent === before) {
      pasteText(input, text);
    }

    if (input.textContent === before || !input.textContent.trim()) {
      input.textContent = text;
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
    }

    return { ok: Boolean(input.textContent && input.textContent.trim()) };
  }
})();
