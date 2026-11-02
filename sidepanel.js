const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:11434",
  model: "llama3.2",
  systemPrompt:
    "You are a helpful assistant inside the user's browser. Answer using the provided page or conversation context when it is relevant. Be concise and accurate. If the answer is not in the context, say so and answer from your own knowledge.",
  includePage: true,
  customPrompts: [],
};

const PROMPT_PRESETS = [
  { label: "General assistant", prompt: DEFAULT_SETTINGS.systemPrompt },
  {
    label: "Concise answers",
    prompt:
      "Answer as briefly as possible. Use short sentences or bullets, skip filler and repetition, and give only the information the user needs.",
  },
  {
    label: "Explain simply",
    prompt:
      "Explain in plain language for someone new to the topic. Use short paragraphs, define jargon, and include one simple example when helpful.",
  },
  {
    label: "Chat reply writer",
    prompt:
      "You draft chat messages for the user. Match the language, tone, length and energy of the conversation. Write replies the user can send exactly as written. Never add narration, labels, quotes or explanations.",
  },
  {
    label: "Summarizer",
    prompt:
      "Summarize the provided page or conversation. Start with one sentence that captures the main point, then list the key details as concise bullets. Include names, numbers and dates that matter.",
  },
  {
    label: "Code helper",
    prompt:
      "You are a senior software engineer. Give correct, idiomatic code with minimal explanation. Mention important edge cases, security concerns and how to test the change.",
  },
  {
    label: "Translator",
    prompt:
      "Translate the user's text faithfully. If they do not name a target language, translate to English. Preserve formatting, names, numbers and tone. Return only the translation unless asked for notes.",
  },
];

const MAX_PAGE_CHARS = 8000;
const MAX_CHAT_CHARS = 6000;
const MAX_HISTORY_MESSAGES = 12;
const NUM_CTX = 16384;
const CONTENT_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_err) {
    return "1.4.0";
  }
})();
const thinkingSupport = new Map();
const SUGGEST_LABEL = "\u2726 Suggest replies";

const els = {
  settings: document.getElementById("settings"),
  settingsBtn: document.getElementById("settingsBtn"),
  clearBtn: document.getElementById("clearBtn"),
  endpointInput: document.getElementById("endpointInput"),
  refreshModelsBtn: document.getElementById("refreshModelsBtn"),
  modelSelect: document.getElementById("modelSelect"),
  promptSelect: document.getElementById("promptSelect"),
  promptNameInput: document.getElementById("promptNameInput"),
  savePromptBtn: document.getElementById("savePromptBtn"),
  deletePromptBtn: document.getElementById("deletePromptBtn"),
  systemPromptInput: document.getElementById("systemPromptInput"),
  chatBar: document.getElementById("chatBar"),
  platformBadge: document.getElementById("platformBadge"),
  chatBarTitle: document.getElementById("chatBarTitle"),
  chatBarCount: document.getElementById("chatBarCount"),
  suggestRepliesBtn: document.getElementById("suggestRepliesBtn"),
  readChatBtn: document.getElementById("readChatBtn"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  emptyTitle: document.getElementById("emptyTitle"),
  emptyDesc: document.getElementById("emptyDesc"),
  pageChip: document.getElementById("pageChip"),
  pageChipText: document.getElementById("pageChipText"),
  includePageToggle: document.getElementById("includePageToggle"),
  quickActions: document.getElementById("quickActions"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("sendBtn"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  toast: document.getElementById("toast"),
};

let settings = { ...DEFAULT_SETTINGS };
let activePrompt = DEFAULT_SETTINGS.systemPrompt;
let messages = [];
let page = null;
let conversation = null;
let currentPlatform = null;
let activeTab = null;
let contextSeq = 0;
let streaming = false;
let toastTimer = null;
let sessionTabId = null;
const sessions = new Map();

init();

async function init() {
  const stored = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  settings.customPrompts = normalizeCustomPrompts(settings.customPrompts);
  activePrompt = settings.systemPrompt;

  els.endpointInput.value = settings.endpoint;
  els.includePageToggle.checked = settings.includePage;
  buildPromptOptions();
  syncPromptUI();

  bindEvents();
  await refreshPageChip();
  await refreshModels();
  els.input.focus();
}

function bindEvents() {
  els.settingsBtn.addEventListener("click", () => {
    els.settings.hidden = !els.settings.hidden;
    els.settingsBtn.classList.toggle("active", !els.settings.hidden);
    if (!els.settings.hidden) els.endpointInput.focus();
  });

  els.clearBtn.addEventListener("click", clearChat);

  els.sendBtn.addEventListener("click", () => {
    if (streaming) {
      stopStreaming();
      return;
    }
    submit();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!streaming) submit();
    }
  });

  els.input.addEventListener("input", autoGrow);

  els.quickActions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-prompt]");
    if (!button || streaming) return;
    els.input.value = button.dataset.prompt;
    autoGrow();
    submit();
  });

  els.suggestRepliesBtn.addEventListener("click", generateReplies);

  els.readChatBtn.addEventListener("click", async () => {
    await refreshPageChip(false);
    if (conversation) {
      showToast(
        "Conversation refreshed (" +
          conversation.messages.length +
          " message" +
          (conversation.messages.length === 1 ? "" : "s") +
          ")."
      );
    }
  });

  els.endpointInput.addEventListener("change", async () => {
    settings.endpoint = normalizeEndpoint(els.endpointInput.value);
    els.endpointInput.value = settings.endpoint;
    await persistSettings();
    await refreshModels();
  });

  els.refreshModelsBtn.addEventListener("click", refreshModels);

  els.modelSelect.addEventListener("change", async () => {
    settings.model = els.modelSelect.value;
    await persistSettings();
  });

  els.promptSelect.addEventListener("change", async () => {
    const value = els.promptSelect.value;
    if (value === "custom") {
      syncPromptExtras();
      els.systemPromptInput.focus();
      return;
    }

    let text = "";
    if (value.startsWith("preset:")) {
      const preset = PROMPT_PRESETS[Number(value.slice("preset:".length))];
      if (preset) text = preset.prompt;
    } else if (value.startsWith("custom:")) {
      const entry = settings.customPrompts.find(
        (item) => item.id === value.slice("custom:".length)
      );
      if (entry) text = entry.prompt;
    }

    if (text) await applyPrompt(text, true);
  });

  els.systemPromptInput.addEventListener("input", handlePromptEdit);

  els.systemPromptInput.addEventListener("change", async () => {
    handlePromptEdit();
    els.systemPromptInput.value = activePrompt;
    await persistSettings();
  });

  els.savePromptBtn.addEventListener("click", async () => {
    const text = els.systemPromptInput.value.trim();
    if (!text) {
      showToast("Write a prompt first.");
      return;
    }

    const name = els.promptNameInput.value.trim();
    const selected = currentCustomPrompt();

    if (selected) {
      selected.prompt = text;
      if (name) selected.name = name;
      settings.systemPrompt = text;
      activePrompt = text;
      if (sessionTabId != null) {
        const session = sessions.get(sessionTabId);
        if (session) session.systemPrompt = text;
      }
      await persistSettings();
      buildPromptOptions();
      await applyPrompt(text, true);
      els.promptNameInput.value = selected.name;
      showToast("Updated prompt: " + selected.name);
      return;
    }

    const existing = settings.customPrompts.find((item) => item.prompt === text);
    if (existing) {
      await applyPrompt(text, true);
      showToast("This prompt is already saved.");
      return;
    }

    const entry = {
      id: newPromptId(),
      name: name || "Custom " + (settings.customPrompts.length + 1),
      prompt: text,
    };
    settings.customPrompts.push(entry);
    await persistSettings();
    buildPromptOptions();
    await applyPrompt(text, true);
    els.promptNameInput.value = entry.name;
    showToast("Saved prompt: " + entry.name);
  });

  els.deletePromptBtn.addEventListener("click", async () => {
    const entry = currentCustomPrompt();
    if (!entry) return;
    settings.customPrompts = settings.customPrompts.filter((item) => item.id !== entry.id);
    await persistSettings();
    buildPromptOptions();
    syncPromptUI();
    showToast("Deleted prompt.");
  });

  els.includePageToggle.addEventListener("change", async () => {
    settings.includePage = els.includePageToggle.checked;
    await persistSettings();
  });

  chrome.tabs.onActivated.addListener(() => refreshPageChip());
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" && tab.active) refreshPageChip();
  });
  if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      const session = sessions.get(tabId);
      if (!session) return;
      if (session.stream) {
        session.stream.discard = true;
        session.stream.controller.abort();
      }
      session.replySeq = (session.replySeq || 0) + 1;
      if (session.root && session.root.parentElement) session.root.remove();
      sessions.delete(tabId);

      if (tabId === sessionTabId) {
        sessionTabId = null;
        activeTab = null;
        messages = [];
        page = null;
        conversation = null;
        currentPlatform = null;
        streaming = false;
        els.emptyState.hidden = false;
        setStreaming(false);
      }
    });
  }
}

function newPromptId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeCustomPrompts(list) {
  if (!Array.isArray(list)) return [];
  const prompts = [];
  for (const item of list) {
    if (!item || typeof item.prompt !== "string" || !item.prompt.trim()) continue;
    prompts.push({
      id: typeof item.id === "string" && item.id ? item.id : newPromptId(),
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : "Custom " + (prompts.length + 1),
      prompt: item.prompt.trim(),
    });
  }
  return prompts;
}

function buildPromptOptions() {
  els.promptSelect.innerHTML = "";

  PROMPT_PRESETS.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = "preset:" + index;
    option.textContent = preset.label;
    els.promptSelect.appendChild(option);
  });

  if (settings.customPrompts.length) {
    const group = document.createElement("optgroup");
    group.label = "My prompts";
    for (const entry of settings.customPrompts) {
      const option = document.createElement("option");
      option.value = "custom:" + entry.id;
      option.textContent = entry.name;
      group.appendChild(option);
    }
    els.promptSelect.appendChild(group);
  }

  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom (unsaved)";
  els.promptSelect.appendChild(custom);
}

function currentCustomPrompt() {
  const value = els.promptSelect.value;
  if (!value.startsWith("custom:")) return null;
  const id = value.slice("custom:".length);
  return settings.customPrompts.find((entry) => entry.id === id) || null;
}

function syncPromptSelect() {
  const presetIndex = PROMPT_PRESETS.findIndex((preset) => preset.prompt === activePrompt);
  if (presetIndex >= 0) {
    els.promptSelect.value = "preset:" + presetIndex;
    return;
  }
  const entry = settings.customPrompts.find((item) => item.prompt === activePrompt);
  els.promptSelect.value = entry ? "custom:" + entry.id : "custom";
}

function syncPromptExtras() {
  const entry = currentCustomPrompt();
  els.promptNameInput.value = entry ? entry.name : "";
  els.deletePromptBtn.disabled = !entry;
  els.savePromptBtn.textContent = entry ? "Update" : "Save";
}

function handlePromptEdit() {
  const selected = currentCustomPrompt();
  activePrompt = els.systemPromptInput.value.trim() || DEFAULT_SETTINGS.systemPrompt;
  setPromptState(activePrompt);

  if (selected) {
    els.promptSelect.value = "custom:" + selected.id;
    syncPromptExtras();
  } else {
    syncPromptSelect();
    syncPromptExtras();
  }
}

function syncPromptUI() {
  els.systemPromptInput.value = activePrompt;
  syncPromptSelect();
  syncPromptExtras();
}

function setPromptState(text) {
  activePrompt = text;
  settings.systemPrompt = text;
  if (sessionTabId != null) {
    const session = sessions.get(sessionTabId);
    if (session) session.systemPrompt = text;
  }
}

async function applyPrompt(text, persist) {
  setPromptState(text);
  syncPromptUI();
  if (persist) await persistSettings();
}

async function persistSettings() {
  await chrome.storage.local.set({ settings });
}

function endpointBase() {
  return settings.endpoint.replace(/\/+$/, "");
}

function normalizeEndpoint(value) {
  let text = (value || "").trim();
  if (!text) return DEFAULT_SETTINGS.endpoint;
  if (!/^https?:\/\//i.test(text)) text = "http://" + text;
  return text.replace(/\/+$/, "");
}

async function supportsThinking(model) {
  if (!model) return false;

  const key = endpointBase() + "|" + model;
  if (thinkingSupport.has(key)) return thinkingSupport.get(key);

  let supported = false;
  try {
    const res = await fetch(endpointBase() + "/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const json = await res.json();
      supported = Boolean(
        json && Array.isArray(json.capabilities) && json.capabilities.includes("thinking")
      );
    }
  } catch (_err) {
    supported = false;
  }

  thinkingSupport.set(key, supported);
  return supported;
}

function setStatus(kind, text) {
  els.statusDot.className = "dot" + (kind ? " " + kind : "");
  els.statusText.textContent = text;
}

function platformForUrl(url) {
  if (!url) return null;
  if (/^https:\/\/web\.whatsapp\.com(?:\/|$)/i.test(url)) return "whatsapp";
  if (/^https:\/\/(www\.)?instagram\.com\/direct\//i.test(url)) return "instagram";
  return null;
}

function platformName(platform) {
  if (platform === "whatsapp") return "WhatsApp";
  if (platform === "instagram") return "Instagram";
  return "";
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_err) {
    return null;
  }
}

async function refreshPageChip(quiet = true) {
  const seq = ++contextSeq;
  const tab = await getActiveTab();
  if (seq !== contextSeq) return;

  switchSession(tab);
  activeTab = tab;
  const platform = tab ? platformForUrl(tab.url || "") : null;
  currentPlatform = platform;

  if (platform) {
    els.chatBar.hidden = false;
    els.pageChip.hidden = false;
    els.includePageToggle.disabled = false;
    els.pageChipText.textContent = platformName(platform) + " \u00b7 reading chat\u2026";

    const data = await readConversation(tab, quiet);
    if (seq !== contextSeq) return;

    if (data && data.messages && data.messages.length) {
      conversation = { platform, title: data.title || "", messages: data.messages };
      els.pageChipText.textContent =
        platformName(platform) + (conversation.title ? " \u00b7 " + conversation.title : "");
      els.pageChipText.title = conversation.title || "";
    } else {
      conversation = null;
      const unreadable = Boolean(
        data && data.error && !/open a .*conversation/i.test(data.error)
      );
      els.pageChipText.textContent =
        platformName(platform) + (unreadable ? " \u00b7 chat not readable" : " \u00b7 no chat open");
      els.pageChipText.title = unreadable ? data.error : "";
    }
    page = null;
  } else {
    conversation = null;
    els.chatBar.hidden = true;
    els.pageChip.hidden = false;

    const readable = Boolean(tab && tab.url && /^(https?|file):/i.test(tab.url));
    els.includePageToggle.disabled = !readable;

    if (readable) {
      els.pageChipText.textContent = tab.title || new URL(tab.url).hostname;
      els.pageChipText.title = tab.url;
    } else {
      els.pageChipText.textContent = "This page can\u2019t be read";
      els.pageChipText.title = tab ? tab.url || "" : "";
      page = null;
    }
  }

  els.includePageToggle.parentElement.title = platform
    ? "Include this conversation in questions"
    : "Include page content";

  saveSession();
  updateChatBar();
  updateQuickActions();
}

function createSession(tab, url) {
  const root = document.createElement("div");
  root.className = "session";
  root.hidden = true;
  els.messages.appendChild(root);

  return {
    tabId: tab && typeof tab.id === "number" ? tab.id : null,
    url: url || "",
    messages: [],
    page: null,
    conversation: null,
    systemPrompt: settings.systemPrompt,
    root,
    stream: null,
    generatingReplies: false,
    replySeq: 0,
  };
}

function activeSession() {
  return sessionTabId == null ? null : sessions.get(sessionTabId) || null;
}

function isActiveSession(session) {
  return Boolean(session && session === activeSession());
}

function saveSession() {
  const session = activeSession();
  if (!session) return;
  session.messages = messages;
  session.page = page;
  session.conversation = conversation;
  session.systemPrompt = activePrompt;
}

function switchSession(tab) {
  const nextId = tab && typeof tab.id === "number" ? tab.id : null;
  const url = tab ? tab.url || "" : "";

  if (tab) activeTab = tab;

  if (nextId === sessionTabId) {
    const session = activeSession();
    if (session && url && session.url !== url) {
      session.url = url;
      session.page = null;
      page = null;
    }
    return;
  }

  saveSession();

  const previous = activeSession();
  if (previous) previous.root.hidden = true;

  sessionTabId = nextId;

  if (nextId == null) {
    messages = [];
    page = null;
    conversation = null;
    activePrompt = settings.systemPrompt;
    streaming = false;
    els.emptyState.hidden = false;
    syncPromptUI();
    setStreaming(false);
    return;
  }

  let session = sessions.get(nextId);
  if (!session) {
    session = createSession(tab, url);
    sessions.set(nextId, session);
  }
  if (url && session.url !== url) {
    session.url = url;
    session.page = null;
  }

  session.root.hidden = false;
  messages = session.messages;
  page = session.page;
  conversation = session.conversation;
  activePrompt = session.systemPrompt || settings.systemPrompt;
  streaming = Boolean(session.stream);
  els.emptyState.hidden = Boolean(session.root.querySelector(".msg"));
  syncPromptUI();
  setStreaming(streaming);
  scrollToBottom(true);
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res && res.ok && res.version === CONTENT_VERSION) return true;
  } catch (_err) {
    /* not injected yet */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_err) {
    return false;
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(res && res.ok && res.version === CONTENT_VERSION);
  } catch (_err) {
    return false;
  }
}

async function readConversation(tab, quiet) {
  if (!tab || !tab.id) return null;
  const platform = platformForUrl(tab.url || "");
  if (!platform) return null;

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    if (!quiet) showToast("Cannot access this tab. Reload the page and try again.");
    return null;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "READ_CONVERSATION" });
    if (res && res.ok) return res;
    if (res && res.debug) console.warn("Chat reader diagnostics:", res.debug);
    if (!quiet && res && res.error) showToast(res.error);
    return res || null;
  } catch (err) {
    if (!quiet) showToast("Could not read the chat: " + (err.message || err));
  }
  return null;
}

function updateChatBar() {
  if (!currentPlatform) {
    els.chatBar.hidden = true;
    return;
  }

  els.chatBar.hidden = false;
  els.platformBadge.textContent = platformName(currentPlatform);
  els.platformBadge.dataset.platform = currentPlatform;

  const session = activeSession();
  const busyChat = Boolean(session && session.stream);
  const busyReplies = Boolean(session && session.generatingReplies);
  const count = conversation ? conversation.messages.length : 0;
  els.chatBarTitle.textContent = conversation ? conversation.title || "Current chat" : "No chat open";
  els.chatBarCount.textContent = count
    ? count + (count === 1 ? " message" : " messages")
    : "";
  els.suggestRepliesBtn.textContent = busyReplies ? "Thinking\u2026" : SUGGEST_LABEL;
  els.suggestRepliesBtn.disabled = busyChat || busyReplies || count === 0;
}

function updateQuickActions() {
  const chat = Boolean(currentPlatform);
  const items = chat
    ? [
        ["Summarize this conversation.", "Summarize"],
        ["List the key points from this conversation as bullets.", "Key points"],
        ["What is the other person asking, and how should I respond?", "How to reply"],
      ]
    : [
        ["Summarize this page in a few sentences.", "Summarize"],
        ["List the key points from this page as bullets.", "Key points"],
        [
          "Explain the main ideas on this page like I'm new to the topic.",
          "Explain",
        ],
      ];

  els.quickActions.innerHTML = "";
  for (const [prompt, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.prompt = prompt;
    button.textContent = label;
    els.quickActions.appendChild(button);
  }

  if (chat) {
    els.emptyTitle.textContent = "Need a reply?";
    els.emptyDesc.textContent =
      "I can read this conversation and suggest three replies. Insert any of them into the chat with one click.";
    els.input.placeholder = "Ask about this chat\u2026";
  } else {
    els.emptyTitle.textContent = "Ask about this page";
    els.emptyDesc.textContent =
      "I run on your local Ollama model and can read the page you are viewing. Nothing leaves your machine.";
    els.input.placeholder = "Ask anything about this page\u2026";
  }
}

async function refreshModels() {
  setStatus("connecting", "Connecting\u2026");
  els.refreshModelsBtn.disabled = true;
  try {
    const res = await fetch(endpointBase() + "/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const names = (data.models || [])
      .map((model) => model.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    if (names.length && !names.includes(settings.model)) {
      settings.model = names[0];
      await persistSettings();
    }

    populateModelSelect(names);
    setStatus(
      "ok",
      names.length
        ? `Connected \u00b7 ${names.length} model${names.length === 1 ? "" : "s"}`
        : "Connected \u00b7 no models"
    );
  } catch (_err) {
    populateModelSelect([]);
    setStatus("error", "Ollama offline");
  } finally {
    els.refreshModelsBtn.disabled = false;
  }
}

function populateModelSelect(names) {
  const current = settings.model;
  const list = names.slice();
  if (current && !list.includes(current)) list.unshift(current);

  els.modelSelect.innerHTML = "";

  if (!list.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models available";
    els.modelSelect.appendChild(option);
    return;
  }

  for (const name of list) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    els.modelSelect.appendChild(option);
  }
  els.modelSelect.value = list.includes(current) ? current : list[0];
}

function extractPageFn() {
  try {
    const root =
      document.querySelector("main, article, [role='main']") || document.body;
    if (!root) return { title: document.title, url: location.href, text: "" };
    let text = root.innerText || root.textContent || "";
    text = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      title: document.title,
      url: location.href,
      text: text.slice(0, 20000),
    };
  } catch (_err) {
    return { title: document.title, url: location.href, text: "" };
  }
}

async function ensurePageContext(tab, session) {
  if (!tab || !tab.id) throw new Error("No active tab.");
  if (!/^(https?|file):/i.test(tab.url || "")) {
    throw new Error("Browser pages can't be read.");
  }

  const cached = session ? session.page : page;
  if (cached && cached.url === tab.url && cached.text) return cached;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageFn,
  });
  const data = results && results[0] && results[0].result;
  if (!data || !data.text) {
    throw new Error("No readable text found on this page.");
  }

  const result = { url: data.url, title: data.title, text: data.text.slice(0, 24000) };
  if (session) session.page = result;
  else page = result;
  return result;
}

function conversationTranscript(limit, conv = conversation) {
  if (!conv || !conv.messages.length) return "";
  let transcript = conv.messages
    .map((message) => {
      const who = message.from === "me" ? "Me" : message.sender || "Them";
      return who + ": " + message.text;
    })
    .join("\n");
  if (transcript.length > limit) transcript = "\u2026" + transcript.slice(-limit);
  return transcript;
}

function buildSystemPrompt(session) {
  const current = session || activeSession();
  const base = ((current && current.systemPrompt) || activePrompt || DEFAULT_SETTINGS.systemPrompt).trim();
  const conv = current ? current.conversation : conversation;
  const pageContext = current ? current.page : page;

  if (settings.includePage && conv && conv.messages.length) {
    return (
      base +
      "\n\nThe user is chatting on " +
      platformName(conv.platform) +
      (conv.title ? ' with "' + conv.title + '"' : "") +
      ". Recent messages, oldest first:\n\n" +
      conversationTranscript(MAX_CHAT_CHARS, conv) +
      "\n\nUse this chat as context. If asked to propose replies, match the language, tone and length of the conversation. Write them so the user can send them exactly as written, with no narration, quotes or labels."
    );
  }

  if (settings.includePage && pageContext && pageContext.text) {
    return (
      base +
      "\n\nThe user is viewing the page below. Use it to answer, and quote details from it when relevant. If the answer is not on the page, say so and answer from general knowledge.\n\n" +
      "--- PAGE CONTENT START ---\n" +
      "Title: " + pageContext.title + "\n" +
      "URL: " + pageContext.url + "\n\n" +
      pageContext.text.slice(0, MAX_PAGE_CHARS) +
      "\n--- PAGE CONTENT END ---"
    );
  }

  return base;
}

function submit() {
  const text = els.input.value.trim();
  if (!text) return;
  if (!settings.model) {
    showToast("Pick a model first. Pull one with: ollama pull llama3.2");
    return;
  }
  els.input.value = "";
  autoGrow();
  send(text);
}

async function send(text) {
  const session = activeSession();
  if (!session) return;

  const tab = activeTab;
  const stream = { controller: new AbortController(), discard: false };
  session.stream = stream;
  streaming = true;

  hideEmptyState(session);
  appendMessage("user", text, session);
  session.messages.push({ role: "user", content: text });

  const bubble = appendMessage("assistant", "", session);
  bubble.classList.add("streaming");
  setStreaming(true);

  let answer = "";
  let thinking = "";
  let aborted = false;

  try {
    const platform = tab ? platformForUrl(tab.url || "") : null;

    if (settings.includePage && platform) {
      const data = await readConversation(tab, true);
      if (stream.discard) throw new DOMException("Aborted", "AbortError");
      if (data && data.messages) {
        session.conversation = { platform, title: data.title || "", messages: data.messages };
        if (isActiveSession(session)) {
          conversation = session.conversation;
          updateChatBar();
        }
      }
    } else if (settings.includePage) {
      try {
        const context = await ensurePageContext(tab, session);
        if (stream.discard) {
          session.page = null;
          throw new DOMException("Aborted", "AbortError");
        }
        if (isActiveSession(session)) page = context;
      } catch (err) {
        if (err.name !== "AbortError" && isActiveSession(session)) {
          showToast("Page not included: " + err.message);
        }
      }
    }

    if (stream.discard) throw new DOMException("Aborted", "AbortError");

    const history = session.messages.slice(-MAX_HISTORY_MESSAGES);
    const canThink = await supportsThinking(settings.model);
    if (stream.discard) throw new DOMException("Aborted", "AbortError");

    const baseBody = {
      model: settings.model,
      stream: true,
      messages: [{ role: "system", content: buildSystemPrompt(session) }, ...history],
      options: { num_ctx: NUM_CTX },
    };
    if (canThink) baseBody.think = true;

    const run = async (payload) => {
      const res = await fetch(endpointBase() + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: stream.controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try {
          const json = await res.json();
          detail = json.error || "";
        } catch (_err) {
          /* body was not JSON */
        }
        throw new Error(detail || "HTTP " + res.status);
      }

      if (!res.body) {
        const json = await res.json();
        const message = (json && json.message) || {};
        if (message.thinking) {
          thinking += message.thinking;
          updateThinking(bubble, thinking);
        }
        if (message.content) {
          answer += message.content;
          bubble.innerHTML = renderMarkdown(answer);
        }
        scrollIfActive(session);
        return;
      }

      await readNdjson(res.body, (chunk) => {
        if (chunk.thinking) {
          thinking += chunk.thinking;
          updateThinking(bubble, thinking);
          scrollIfActive(session);
        }
        if (chunk.content) {
          answer += chunk.content;
          bubble.innerHTML = renderMarkdown(answer);
          scrollIfActive(session);
        }
      });
    };

    await run(baseBody);

    if (!answer.trim() && thinking.trim() && !stream.discard) {
      bubble.innerHTML =
        '<span class="err-detail">Reasoning used the available context. Retrying without reasoning\u2026</span>';
      await run({ ...baseBody, think: false });
    }

    if (!answer.trim()) {
      bubble.innerHTML =
        '<span class="err">The model produced no answer.</span>' +
        '<span class="err-detail">The conversation may be too long. Try a shorter question or a smaller model.</span>';
    } else if (thinking) {
      finishThinking(bubble);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      aborted = true;
    } else {
      const detail = err.message || String(err);
      const hint = errorHint(detail);
      if (answer) {
        bubble.innerHTML = renderMarkdown(answer);
      } else {
        const title = /403|origin|forbidden/i.test(detail)
          ? "Ollama blocked the extension (403 Forbidden)."
          : "Couldn\u2019t reach the local model.";
        bubble.innerHTML =
          '<span class="err">' + title + "</span>" +
          '<span class="err-detail">' + escapeHtml(detail) + "</span>" +
          (hint ? '<span class="err-detail">' + escapeHtml(hint) + "</span>" : "");
      }
      if (hint && isActiveSession(session)) showToast(hint);
    }
  } finally {
    bubble.classList.remove("streaming");
    if (!stream.discard) {
      if (answer) {
        session.messages.push({ role: "assistant", content: answer });
      } else if (aborted) {
        bubble.innerHTML = '<span class="err-detail">Stopped.</span>';
      }
    }

    if (session.stream === stream) {
      session.stream = null;
      if (isActiveSession(session)) {
        streaming = false;
        setStreaming(false);
        els.input.focus();
      }
    }
  }
}

async function generateReplies() {
  const session = activeSession();
  if (!session || session.generatingReplies) return;
  if (session.stream) {
    showToast("Wait for the current answer to finish.");
    return;
  }

  const tab = activeTab;
  const platform = tab ? platformForUrl(tab.url || "") : null;
  if (!platform) {
    showToast("Open a WhatsApp or Instagram chat to suggest replies.");
    return;
  }
  if (!settings.model) {
    showToast("Pick a model first.");
    return;
  }

  const seq = (session.replySeq || 0) + 1;
  session.replySeq = seq;
  session.generatingReplies = true;
  updateChatBar();
  hideEmptyState(session);

  const block = createRepliesBlock("", session);
  block.setLoading("Reading the conversation\u2026");
  let lastThinking = "";
  let lastContent = "";

  try {
    const data = await readConversation(tab, true);
    if (session.replySeq !== seq) return;
    if (!data || !data.messages || !data.messages.length) {
      throw new Error("No messages found. Open a chat with messages and try again.");
    }

    session.conversation = { platform, title: data.title || "", messages: data.messages };
    if (isActiveSession(session)) {
      conversation = session.conversation;
      updateChatBar();
      els.pageChipText.textContent =
        platformName(platform) + (conversation.title ? " \u00b7 " + conversation.title : "");
    }
    block.setTitle(session.conversation.title);
    block.setLoading("Asking " + settings.model + "\u2026");

    const result = await requestReplies(session.conversation, (thinking, content) => {
      lastThinking = thinking;
      lastContent = content;
      block.setRaw(thinking, content, true);
      if (thinking && !content) block.setLoading("Model is thinking\u2026");
      else if (content) block.setLoading("Writing replies\u2026");
    });

    lastThinking = result.thinking;
    lastContent = result.content;
    block.setRaw(result.thinking, result.content, false);

    if (!result.replies.length) {
      throw new Error(
        !result.content.trim() && result.thinking.trim()
          ? "The model produced reasoning but no replies. Try again or pick another model."
          : "Could not read replies from the model output. Expand \u201cModel output\u201d to see the raw response."
      );
    }
    block.setReplies(result.replies);
  } catch (err) {
    const detail = (err && err.message) || String(err);
    block.fail(detail);
    block.setRaw(lastThinking, lastContent, true);
    const hint = errorHint(detail);
    if (hint && isActiveSession(session)) showToast(hint);
  } finally {
    if (session.replySeq === seq) {
      session.generatingReplies = false;
      updateChatBar();
    }
  }
}

async function requestReplies(conv, onProgress) {
  const transcript = conversationTranscript(MAX_CHAT_CHARS, conv);
  const system =
    "You write chat replies for the user. Read the conversation and follow its language, tone and energy. " +
    "Produce exactly 3 short replies the user can send as-is to the latest message. " +
    "No narration, no quotes, no labels. Each reply must be under 30 words. " +
    'Return ONLY JSON in this shape: {"replies":["","",""]}';

  const canThink = await supportsThinking(settings.model);

  const body = {
    model: settings.model,
    stream: true,
    think: canThink,
    format: "json",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Platform: " +
          platformName(conv.platform) +
          "\nChat with: " +
          (conv.title || "unknown") +
          "\n\nConversation (oldest first):\n" +
          transcript +
          "\n\nSuggest 3 replies to the newest message.",
      },
    ],
    options: {
      temperature: 0.8,
      num_predict: canThink ? 3000 : 1500,
      num_ctx: NUM_CTX,
    },
  };

  const replyController = new AbortController();
  const timer = setTimeout(() => replyController.abort(), 180000);

  const post = async (payload, seedThinking, seedContent) => {
    let thinking = seedThinking;
    let content = seedContent;

    const res = await fetch(endpointBase() + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: replyController.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        const json = await res.json();
        detail = json.error || "";
      } catch (_err) {
        /* body was not JSON */
      }
      throw new Error(detail || "HTTP " + res.status);
    }

    if (!res.body) {
      const json = await res.json();
      const message = (json && json.message) || {};
      if (message.thinking) thinking += message.thinking;
      if (message.content) content += message.content;
      if (onProgress) onProgress(thinking, content);
      return { thinking, content };
    }

    await readNdjson(res.body, (message) => {
      if (message.thinking) thinking += message.thinking;
      if (message.content) content += message.content;
      if (onProgress) onProgress(thinking, content);
    });

    return { thinking, content };
  };

  try {
    let { thinking, content } = await post(body, "", "");
    let replies = parseReplies(content);

    if (!replies.length && thinking.trim()) {
      if (onProgress) onProgress(thinking, "");
      const retry = await post(
        { ...body, think: false, options: { ...body.options, num_predict: 1500 } },
        thinking,
        ""
      );
      thinking = retry.thinking;
      content = retry.content;
      replies = parseReplies(content);
    }

    return { replies, thinking, content };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("The model took too long. Try again or pick a smaller model.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseReplies(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!text) return [];

  const coerce = (item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const value = [item.reply, item.text, item.content, item.message, item.value].find(
        (candidate) => typeof candidate === "string"
      );
      return value ? value.trim() : "";
    }
    return "";
  };

  const fromValue = (value) => {
    if (Array.isArray(value)) return value.map(coerce).filter(Boolean).slice(0, 4);
    if (typeof value === "string") return [value.trim()].filter(Boolean);
    return [];
  };

  const fromObject = (obj) => {
    if (!obj || typeof obj !== "object") return [];
    const keys = ["replies", "suggestions", "options", "reply", "responses", "answers", "messages"];
    for (const key of keys) {
      if (key in obj) {
        const list = fromValue(obj[key]);
        if (list.length) return list;
      }
    }
    for (const value of Object.values(obj)) {
      const list = fromValue(value);
      if (list.length) return list;
    }
    return [];
  };

  let parsedDirectly = false;
  try {
    const direct = JSON.parse(text);
    parsedDirectly = true;
    const list =
      typeof direct === "string"
        ? direct.trim()
          ? [direct.trim()]
          : []
        : Array.isArray(direct)
          ? fromValue(direct)
          : fromObject(direct);
    if (list.length) return list;
  } catch (_err) {
    /* try extracting a JSON object below */
  }

  if (parsedDirectly) return [];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const list = fromObject(JSON.parse(text.slice(start, end + 1)));
      if (list.length) return list;
    } catch (_err) {
      /* truncated JSON, try quoted values below */
    }
  }

  if (/^[\[{]/.test(text) || /"replies"/i.test(text)) {
    const quoted = [];
    const pattern = /"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = pattern.exec(text))) {
      let value = match[1];
      try {
        value = JSON.parse('"' + value + '"');
      } catch (_err) {
        /* keep the raw value */
      }
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (/^(replies?|suggestions?|options?|responses?|answers?|text|content|message)$/i.test(trimmed)) {
        continue;
      }
      quoted.push(trimmed);
    }
    if (quoted.length) return quoted.slice(0, 4);
  }

  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:\d+[.)]|[-*\u2022])\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim()
    )
    .filter(
      (line) =>
        line &&
        !/^[{}\[\],:]+$/.test(line) &&
        !/^[\[{]/.test(line) &&
        !/[\]}]$/.test(line)
    )
    .slice(0, 4);
}

function createRepliesBlock(title, session = activeSession()) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg assistant";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "\u25C6";

  const box = document.createElement("div");
  box.className = "replies";

  const head = document.createElement("div");
  head.className = "replies-head";
  head.textContent = title ? "Suggested replies \u00b7 " + title : "Suggested replies";

  const note = document.createElement("div");
  note.className = "reply-note";
  note.hidden = true;

  const raw = document.createElement("details");
  raw.className = "reply-raw";
  raw.hidden = true;

  const rawSummary = document.createElement("summary");
  rawSummary.textContent = "Model output";

  const rawText = document.createElement("pre");
  rawText.className = "reply-raw-text";

  raw.append(rawSummary, rawText);

  const list = document.createElement("div");
  list.className = "reply-list";

  box.append(head, note, raw, list);
  wrapper.append(avatar, box);
  const host = session ? session.root : els.messages;
  host.appendChild(wrapper);
  if (!session || isActiveSession(session)) {
    scrollToBottom(true);
    els.emptyState.hidden = true;
  }

  return {
    setTitle(text) {
      head.textContent = text ? "Suggested replies \u00b7 " + text : "Suggested replies";
    },
    setLoading(text) {
      note.hidden = false;
      note.className = "reply-note";
      note.textContent = text;
    },
    setRaw(thinking, content, open) {
      const parts = [];
      if (thinking && thinking.trim()) parts.push("THINKING\n" + thinking.trim());
      if (content && content.trim()) parts.push("OUTPUT\n" + content.trim());
      if (!parts.length) {
        raw.hidden = true;
        return;
      }
      raw.hidden = false;
      rawSummary.textContent = thinking && thinking.trim() ? "Model thinking & output" : "Model output";
      rawText.textContent = parts.join("\n\n");
      raw.open = open;
      rawText.scrollTop = rawText.scrollHeight;
      scrollIfActive(session);
    },
    fail(text) {
      note.hidden = false;
      note.className = "reply-note reply-note-error";
      note.textContent = text;
    },
    setReplies(replies) {
      note.hidden = true;
      list.innerHTML = "";
      for (const reply of replies) list.appendChild(buildReplyCard(reply));
      scrollIfActive(session);
    },
  };
}

function buildReplyCard(text) {
  const card = document.createElement("div");
  card.className = "reply-card";

  const paragraph = document.createElement("div");
  paragraph.className = "reply-text";
  paragraph.textContent = text;

  const actions = document.createElement("div");
  actions.className = "reply-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "reply-btn";
  copy.title = "Copy reply";
  copy.setAttribute("aria-label", "Copy reply");
  copy.textContent = "\u29C9";
  copy.addEventListener("click", async () => {
    const copied = await copyText(text);
    showToast(copied ? "Copied to clipboard." : "Could not copy. Select the text and copy manually.");
  });

  const insert = document.createElement("button");
  insert.type = "button";
  insert.className = "reply-btn reply-insert";
  insert.title = "Insert into the chat box";
  insert.setAttribute("aria-label", "Insert into chat");
  insert.textContent = "\u2935";
  insert.addEventListener("click", () => insertReply(text, insert, card));

  actions.append(copy, insert);
  card.append(paragraph, actions);
  return card;
}

async function insertReply(text, button, card) {
  const tab = await getActiveTab();
  const platform = tab ? platformForUrl(tab.url || "") : null;
  if (!platform) {
    showToast("Open the chat to insert this reply.");
    return;
  }

  button.disabled = true;
  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    button.disabled = false;
    showToast("Reload the chat page and try again.");
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "INSERT_REPLY", text });
    if (res && res.ok) {
      card.classList.add("inserted");
      button.textContent = "\u2713";
      button.title = "Inserted into the chat box";
      showToast("Inserted into the chat box. Review it, then press send.");
    } else {
      button.disabled = false;
      showToast((res && res.error) || "Could not find the message box.");
    }
  } catch (err) {
    button.disabled = false;
    showToast("Could not insert: " + (err.message || err));
  }
}

function errorHint(detail) {
  if (/403|origin|forbidden/i.test(detail)) {
    return 'Ollama blocked the extension origin. Restart it with OLLAMA_ORIGINS="chrome-extension://*" ollama serve';
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return "Could not reach Ollama. Make sure it is running: ollama serve";
  }
  if (/not found|model/i.test(detail)) {
    return 'Model "' + settings.model + '" may be missing. Run: ollama pull ' + settings.model;
  }
  return "";
}

async function readNdjson(stream, onMessage) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handle = (json) => {
    if (json.error) throw new Error(json.error);
    const message = json.message;
    if (message && (message.content || message.thinking)) onMessage(message);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json;
      try {
        json = JSON.parse(trimmed);
      } catch (_err) {
        continue;
      }
      handle(json);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      handle(JSON.parse(tail));
    } catch (_err) {
      /* ignore trailing partial line */
    }
  }
}

function stopStreaming() {
  const session = activeSession();
  if (!session || !session.stream) return;
  session.stream.controller.abort();
}

function setStreaming(on) {
  streaming = on;
  els.sendBtn.classList.toggle("stop", on);
  els.sendBtn.textContent = on ? "\u25A0" : "\u27A4";
  els.sendBtn.title = on ? "Stop generating" : "Send";
  els.sendBtn.setAttribute("aria-label", els.sendBtn.title);
  updateChatBar();
}

function appendMessage(role, text, session = activeSession()) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg " + role;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "\u25C6";
    wrapper.appendChild(avatar);
  }

  const body = document.createElement("div");
  body.className = "msg-body";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  body.appendChild(bubble);
  wrapper.appendChild(body);

  const host = session ? session.root : els.messages;
  host.appendChild(wrapper);
  if (!session || isActiveSession(session)) {
    scrollToBottom(true);
    els.emptyState.hidden = true;
  }
  return bubble;
}

function updateThinking(bubble, thinking) {
  const body = bubble.parentElement;
  if (!body) return;

  let details = body.querySelector(".thinking");
  if (!details) {
    details = document.createElement("details");
    details.className = "thinking";
    details.open = true;

    const summary = document.createElement("summary");
    summary.textContent = "Thinking\u2026";

    const text = document.createElement("pre");
    text.className = "thinking-text";

    details.append(summary, text);
    body.insertBefore(details, bubble);
  }

  const text = details.querySelector(".thinking-text");
  text.textContent = thinking;
  text.scrollTop = text.scrollHeight;
  details.querySelector("summary").textContent = "Thinking\u2026";
}

function finishThinking(bubble) {
  const body = bubble.parentElement;
  const details = body && body.querySelector(".thinking");
  if (!details) return;
  details.querySelector("summary").textContent = "Model thinking";
  details.open = false;
}

function clearChat() {
  const session = activeSession();
  if (!session) return;

  if (session.stream) {
    session.stream.discard = true;
    session.stream.controller.abort();
    session.stream = null;
  }
  session.replySeq = (session.replySeq || 0) + 1;
  session.generatingReplies = false;
  session.messages = [];
  session.page = null;
  session.conversation = null;
  session.root.innerHTML = "";

  messages = session.messages;
  page = null;
  conversation = null;
  streaming = false;
  els.emptyState.hidden = false;
  setStreaming(false);
  els.input.focus();
}

function hideEmptyState(session = activeSession()) {
  if (!session || isActiveSession(session)) els.emptyState.hidden = true;
}

function scrollIfActive(session) {
  if (!session || isActiveSession(session)) scrollToBottom();
}

function scrollToBottom(force) {
  const box = els.messages;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function autoGrow() {
  const input = els.input;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 6000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_err) {
    /* fall back to execCommand */
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_err) {
    copied = false;
  }
  area.remove();
  return copied;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderMarkdown(source) {
  let text = escapeHtml(source);
  const blocks = [];

  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code) => {
    const index = blocks.length;
    blocks.push("<pre><code>" + code.replace(/\n$/, "") + "</code></pre>");
    return "%%CODEBLOCK" + index + "%%";
  });

  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/^\s*[-*]\s+/gm, "\u2022 ");
  text = text.replace(/%%CODEBLOCK(\d+)%%/g, (_match, index) => blocks[Number(index)] || "");

  return text;
}
