/* =========================================================
   CLOUDCHATBOT — App logic
   - Puter.js AI chat (streaming + non-streaming)
   - Conversation memory + localStorage history
   - Sidebar chat list, settings modal, model selector
   - Markdown-lite rendering, copy/regenerate/stop
   ========================================================= */

(() => {
  "use strict";

  /* ---------------- Constants ---------------- */
  const STORAGE_KEYS = {
    chats: "cloudchatbot.chats.v1",
    activeId: "cloudchatbot.activeId.v1",
    settings: "cloudchatbot.settings.v1",
  };

  const SYSTEM_PROMPT =
    "You are CLOUDCHATBOT, a helpful futuristic AI assistant. " +
    "Be clear, helpful, creative, and friendly. " +
    "Use Markdown for formatting when useful (code blocks, bullet lists, bold).";

  const DEFAULT_SETTINGS = {
    model: "gpt-5-nano",
    temperature: 0.7,
    maxTokens: 1024,
    stream: true,
    sound: false,
    compact: false,
  };

  /* ---------------- DOM ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    body: document.body,
    year: $("#year"),

    // Landing CTAs
    openChatButtons: $$('[data-action="open-chat"]'),

    // Sidebar
    sidebar: $("#sidebar"),
    sidebarToggle: $("#sidebarToggle"),
    sidebarClose: $("#sidebarClose"),
    sidebarOverlay: $("#sidebarOverlay"),
    newChatBtn: $("#newChatBtn"),
    chatList: $("#chatList"),
    emptyList: $("#emptyList"),

    // Topbar
    activeChatName: $("#activeChatName"),
    modelSelect: $("#modelSelect"),
    topClearBtn: $("#topClearBtn"),

    // Messages
    messages: $("#messages"),
    emptyState: $("#emptyState"),
    promptSuggestions: $("#promptSuggestions"),

    // Composer
    promptInput: $("#promptInput"),
    sendBtn: $("#sendBtn"),
    stopBtn: $("#stopBtn"),
    puterStatus: $("#puterStatus"),

    // Settings modal
    openSettings: $("#openSettings"),
    settingsModal: $("#settingsModal"),
    tempRange: $("#tempRange"),
    tempVal: $("#tempVal"),
    maxTokens: $("#maxTokens"),
    maxTokensVal: $("#maxTokensVal"),
    streamToggle: $("#streamToggle"),
    soundToggle: $("#soundToggle"),
    compactToggle: $("#compactToggle"),
    clearAllBtn: $("#clearAllBtn"),

    // Toast
    toastStack: $("#toastStack"),
  };

  /* ---------------- State ---------------- */
  const state = {
    chats: loadChats(),
    activeId: localStorage.getItem(STORAGE_KEYS.activeId) || null,
    settings: loadSettings(),
    isGenerating: false,
    abortFlag: false,
    pendingAssistantEl: null,
    soundCtx: null,
  };

  /* ---------------- Storage ---------------- */
  function loadChats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.chats);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function saveChats() {
    try {
      localStorage.setItem(STORAGE_KEYS.chats, JSON.stringify(state.chats));
    } catch (e) {
      console.warn("Failed to save chats:", e);
    }
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.settings);
      const parsed = raw ? JSON.parse(raw) : {};
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
    } catch (e) {
      console.warn("Failed to save settings:", e);
    }
  }
  function setActiveId(id) {
    state.activeId = id;
    if (id) localStorage.setItem(STORAGE_KEYS.activeId, id);
    else localStorage.removeItem(STORAGE_KEYS.activeId);
  }

  /* ---------------- Utilities ---------------- */
  function uid() {
    return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Lightweight Markdown renderer that supports:
   *   - fenced code blocks (```lang ... ```)
   *   - inline code `x`
   *   - bold **text**
   *   - italics *text* / _text_
   *   - links [text](url)
   *   - bullet lists (- item)
   *   - ordered lists (1. item)
   *   - headings #..######
   *   - paragraphs and line breaks
   * It first extracts code blocks to placeholders to avoid nested escaping issues.
   */
  function renderMarkdown(src) {
    if (!src) return "";
    const codeBlocks = [];
    let text = String(src);

    // Extract fenced code blocks
    text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = codeBlocks.length;
      codeBlocks.push({ lang: (lang || "").trim(), code });
      return `\u0000CODE${i}\u0000`;
    });

    // Escape rest
    text = escapeHTML(text);

    // Headings
    text = text.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
    text = text.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
    text = text.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
    text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

    // Bold + italics + inline code
    text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Lists: convert blocks of bullet/numeric lines into <ul>/<ol>
    text = listify(text);

    // Paragraphs / line breaks
    text = paragraphize(text);

    // Restore code blocks
    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
      const block = codeBlocks[Number(idx)];
      const lang = block.lang ? ` data-lang="${escapeHTML(block.lang)}"` : "";
      return `<pre${lang}><button class="copy-code" type="button">Copy</button><code>${escapeHTML(block.code)}</code></pre>`;
    });

    return text;
  }

  function listify(text) {
    const lines = text.split("\n");
    const out = [];
    let listType = null; // 'ul' or 'ol'
    let buffer = [];

    const flush = () => {
      if (!listType) return;
      out.push(`<${listType}>`);
      for (const item of buffer) out.push(`<li>${item}</li>`);
      out.push(`</${listType}>`);
      buffer = [];
      listType = null;
    };

    for (const line of lines) {
      const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line);
      const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (ulMatch) {
        if (listType !== "ul") flush();
        listType = "ul";
        buffer.push(ulMatch[1]);
      } else if (olMatch) {
        if (listType !== "ol") flush();
        listType = "ol";
        buffer.push(olMatch[1]);
      } else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out.join("\n");
  }

  function paragraphize(text) {
    const blocks = text.split(/\n{2,}/);
    return blocks
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return "";
        // Leave HTML structural blocks alone
        if (/^\s*<(h\d|ul|ol|li|pre|blockquote)/i.test(trimmed)) return trimmed;
        if (/\u0000CODE\d+\u0000/.test(trimmed)) return trimmed;
        return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n");
  }

  function scrollToBottom(force = false) {
    const el = els.messages;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (force || nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  /* ---------------- Toasts ---------------- */
  function toast(message, type = "info", timeout = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const ico = type === "error" ? "⚠️" : type === "success" ? "✨" : "ℹ️";
    el.innerHTML = `<span class="ico">${ico}</span><span>${escapeHTML(message)}</span>`;
    els.toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    }, timeout);
  }

  /* ---------------- Sound ---------------- */
  function playTone(freq = 660, duration = 0.08, type = "sine", gain = 0.04) {
    if (!state.settings.sound) return;
    try {
      if (!state.soundCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        state.soundCtx = new Ctx();
      }
      const ctx = state.soundCtx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g).connect(ctx.destination);
      osc.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.stop(ctx.currentTime + duration + 0.02);
    } catch {/* no-op */}
  }

  /* ---------------- Particles ---------------- */
  function createParticles() {
    const root = $("#particles");
    if (!root) return;
    const count = window.matchMedia("(max-width: 768px)").matches ? 18 : 36;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      p.className = "particle";
      const left = Math.random() * 100;
      const size = (Math.random() * 2 + 1).toFixed(2);
      const dur = (Math.random() * 16 + 12).toFixed(2);
      const delay = (Math.random() * -28).toFixed(2);
      const opacity = (Math.random() * 0.5 + 0.3).toFixed(2);
      p.style.left = left + "%";
      p.style.bottom = "-20px";
      p.style.width = size + "px";
      p.style.height = size + "px";
      p.style.animationDuration = dur + "s";
      p.style.animationDelay = delay + "s";
      p.style.opacity = opacity;
      root.appendChild(p);
    }
  }

  /* ---------------- Chats: CRUD ---------------- */
  function getActiveChat() {
    return state.chats.find((c) => c.id === state.activeId) || null;
  }

  function ensureActiveChat() {
    let chat = getActiveChat();
    if (!chat) {
      chat = createChat();
    }
    return chat;
  }

  function createChat() {
    const chat = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.chats.unshift(chat);
    setActiveId(chat.id);
    saveChats();
    renderChatList();
    renderActiveChat();
    return chat;
  }

  function deleteChat(id) {
    const idx = state.chats.findIndex((c) => c.id === id);
    if (idx === -1) return;
    state.chats.splice(idx, 1);
    if (state.activeId === id) {
      setActiveId(state.chats[0]?.id || null);
    }
    saveChats();
    renderChatList();
    renderActiveChat();
  }

  function clearActiveChat() {
    const chat = getActiveChat();
    if (!chat) return;
    chat.messages = [];
    chat.title = "New chat";
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
    renderActiveChat();
    toast("Chat cleared.", "success");
  }

  function clearAllChats() {
    if (state.chats.length === 0) {
      toast("No chats to clear.", "info");
      return;
    }
    if (!confirm("Delete all saved chats? This can't be undone.")) return;
    state.chats = [];
    setActiveId(null);
    saveChats();
    renderChatList();
    renderActiveChat();
    toast("All chats deleted.", "success");
  }

  function autoTitle(chat, firstUserMsg) {
    if (!firstUserMsg) return;
    const t = firstUserMsg.trim().split("\n")[0].slice(0, 48);
    chat.title = t || "New chat";
  }

  /* ---------------- Render: Sidebar ---------------- */
  function renderChatList() {
    const list = els.chatList;
    list.innerHTML = "";
    if (!state.chats.length) {
      els.emptyList.style.display = "block";
      return;
    }
    els.emptyList.style.display = "none";
    const sorted = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of sorted) {
      const li = document.createElement("li");
      li.className = "chat-item" + (c.id === state.activeId ? " active" : "");
      li.dataset.id = c.id;
      li.title = c.title;
      li.innerHTML = `
        <span class="title">${escapeHTML(c.title || "New chat")}</span>
        <button class="del" aria-label="Delete chat">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>
        </button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".del")) return;
        if (state.isGenerating) {
          toast("Wait for the current response to finish.", "info");
          return;
        }
        setActiveId(c.id);
        saveChats();
        renderChatList();
        renderActiveChat();
        closeSidebarMobile();
      });
      li.querySelector(".del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });
      list.appendChild(li);
    }
  }

  /* ---------------- Render: Messages ---------------- */
  function renderActiveChat() {
    const chat = getActiveChat();
    els.activeChatName.textContent = chat?.title || "New conversation";

    // Reset messages
    els.messages.innerHTML = "";

    if (!chat || chat.messages.length === 0) {
      els.messages.appendChild(els.emptyState);
      els.emptyState.style.display = "";
      return;
    }
    els.emptyState.style.display = "none";

    const inner = document.createElement("div");
    inner.className = "messages-inner";
    for (const m of chat.messages) {
      inner.appendChild(buildMessageEl(m));
    }
    els.messages.appendChild(inner);
    scrollToBottom(true);
  }

  function buildMessageEl(message) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${message.role}`;
    wrap.dataset.id = message.id;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = message.role === "user" ? "U" : "";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${message.role === "user" ? "You" : "CLOUDCHATBOT"} · ${formatTime(message.ts || Date.now())}`;

    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = renderMarkdown(message.content || "");

    bubble.appendChild(meta);
    bubble.appendChild(content);

    if (message.role === "assistant" && message.content) {
      bubble.appendChild(buildAssistantActions(message));
    }

    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    return wrap;
  }

  function buildAssistantActions(message) {
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = `
      <button data-act="copy">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
        Copy
      </button>
      <button data-act="regenerate">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>
        Regenerate
      </button>`;
    actions.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "copy") {
        navigator.clipboard?.writeText(message.content).then(
          () => toast("Copied to clipboard.", "success", 1800),
          () => toast("Copy failed.", "error")
        );
      } else if (act === "regenerate") {
        regenerateLast();
      }
    });
    return actions;
  }

  /**
   * Append an assistant placeholder bubble for streaming.
   * Returns { bubble, content, finalize, setError }.
   */
  function appendAssistantPlaceholder() {
    // Ensure messages-inner exists
    let inner = els.messages.querySelector(".messages-inner");
    if (!inner) {
      els.emptyState.style.display = "none";
      inner = document.createElement("div");
      inner.className = "messages-inner";
      els.messages.appendChild(inner);
    }

    const wrap = document.createElement("div");
    wrap.className = "msg assistant";

    const avatar = document.createElement("div");
    avatar.className = "avatar";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `CLOUDCHATBOT · ${formatTime(Date.now())}`;

    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;

    bubble.appendChild(meta);
    bubble.appendChild(content);

    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    inner.appendChild(wrap);

    scrollToBottom(true);
    state.pendingAssistantEl = { wrap, bubble, content };

    return {
      wrap, bubble, content,
      update(text, { streaming = true } = {}) {
        const html = renderMarkdown(text);
        content.innerHTML = streaming ? html + '<span class="stream-caret"></span>' : html;
        scrollToBottom(false);
      },
      finalize(message) {
        content.innerHTML = renderMarkdown(message.content || "");
        // Append actions
        bubble.appendChild(buildAssistantActions(message));
      },
      setError(text) {
        content.innerHTML = `<p style="color:#ff8aa1">${escapeHTML(text)}</p>`;
      },
      remove() {
        wrap.remove();
      }
    };
  }

  /* ---------------- Composer ---------------- */
  function autosizeTextarea() {
    const ta = els.promptInput;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function setGenerating(on) {
    state.isGenerating = on;
    els.sendBtn.hidden = on;
    els.stopBtn.hidden = !on;
    els.promptInput.disabled = on && false; // keep enabled to allow typing next message; but disable sending
    els.sendBtn.disabled = on;
    els.body.classList.toggle("is-generating", on);
  }

  /* ---------------- Puter integration ---------------- */
  function isPuterReady() {
    return typeof window.puter !== "undefined" && window.puter && window.puter.ai && typeof window.puter.ai.chat === "function";
  }

  function setPuterStatus(state) {
    const el = els.puterStatus;
    el.classList.remove("ok", "err");
    if (state === "ok") {
      el.classList.add("ok");
      el.innerHTML = `<span class="dot"></span> Connected to Puter`;
    } else if (state === "err") {
      el.classList.add("err");
      el.innerHTML = `<span class="dot"></span> Puter unavailable`;
    } else {
      el.innerHTML = `<span class="dot"></span> Connecting to Puter…`;
    }
  }

  async function waitForPuter(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isPuterReady()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return isPuterReady();
  }

  function buildMessagesPayload(chat) {
    const msgs = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const m of chat.messages) {
      if (m.role === "user" || m.role === "assistant") {
        msgs.push({ role: m.role, content: m.content || "" });
      }
    }
    return msgs;
  }

  function extractText(part) {
    if (part == null) return "";
    if (typeof part === "string") return part;
    // Common token shapes from Puter / OpenAI-like SSE
    if (typeof part.text === "string") return part.text;
    if (typeof part.delta === "string") return part.delta;
    if (part.delta && typeof part.delta.content === "string") return part.delta.content;
    if (part.message && typeof part.message.content === "string") return part.message.content;
    if (part.choices && part.choices[0]) {
      const c = part.choices[0];
      if (c.delta && typeof c.delta.content === "string") return c.delta.content;
      if (typeof c.text === "string") return c.text;
      if (c.message && typeof c.message.content === "string") return c.message.content;
    }
    return "";
  }

  function extractFinalText(response) {
    if (response == null) return "";
    if (typeof response === "string") return response;
    if (typeof response.text === "string") return response.text;
    if (response.message && typeof response.message.content === "string") return response.message.content;
    if (response.choices && response.choices[0]) {
      const c = response.choices[0];
      if (c.message && typeof c.message.content === "string") return c.message.content;
      if (typeof c.text === "string") return c.text;
    }
    try { return JSON.stringify(response); } catch { return String(response); }
  }

  /* ---------------- Send Flow ---------------- */
  async function handleSend() {
    if (state.isGenerating) return;
    const text = els.promptInput.value.trim();
    if (!text) return;

    if (!isPuterReady()) {
      const ready = await waitForPuter(2500);
      if (!ready) {
        toast("Puter.js is still loading. Please try again.", "error");
        setPuterStatus("err");
        return;
      }
    }

    const chat = ensureActiveChat();
    const isFirstUserMessage = chat.messages.filter((m) => m.role === "user").length === 0;

    // Add user message
    const userMsg = {
      id: uid(),
      role: "user",
      content: text,
      ts: Date.now(),
    };
    chat.messages.push(userMsg);
    chat.updatedAt = Date.now();
    if (isFirstUserMessage) autoTitle(chat, text);

    // Reset composer
    els.promptInput.value = "";
    autosizeTextarea();

    // Render
    if (els.emptyState.parentElement === els.messages) {
      els.emptyState.style.display = "none";
      els.messages.innerHTML = "";
    }
    let inner = els.messages.querySelector(".messages-inner");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "messages-inner";
      els.messages.appendChild(inner);
    }
    inner.appendChild(buildMessageEl(userMsg));
    scrollToBottom(true);

    saveChats();
    renderChatList();
    els.activeChatName.textContent = chat.title;

    playTone(720, 0.06, "sine", 0.03);

    // Assistant placeholder
    const ph = appendAssistantPlaceholder();

    setGenerating(true);
    state.abortFlag = false;

    const messagesPayload = buildMessagesPayload(chat);
    const opts = {
      model: state.settings.model,
      stream: !!state.settings.stream,
      temperature: Number(state.settings.temperature),
      max_tokens: Number(state.settings.maxTokens),
    };

    let assistantContent = "";
    try {
      const response = await window.puter.ai.chat(messagesPayload, opts);

      if (state.settings.stream && response && typeof response[Symbol.asyncIterator] === "function") {
        for await (const part of response) {
          if (state.abortFlag) break;
          const token = extractText(part);
          if (token) {
            assistantContent += token;
            ph.update(assistantContent, { streaming: true });
          }
        }
      } else {
        // Non-streaming or response is a single value
        assistantContent = extractFinalText(response);
        ph.update(assistantContent, { streaming: false });
      }

      if (!assistantContent.trim()) {
        assistantContent = "(No response received from the model.)";
      }

      const assistantMsg = {
        id: uid(),
        role: "assistant",
        content: assistantContent,
        ts: Date.now(),
        model: state.settings.model,
        aborted: state.abortFlag || false,
      };
      chat.messages.push(assistantMsg);
      chat.updatedAt = Date.now();
      saveChats();
      renderChatList();

      ph.finalize(assistantMsg);
      playTone(540, 0.08, "sine", 0.025);
    } catch (err) {
      console.error("Puter chat error:", err);
      const msg = humanizeError(err);
      ph.setError(msg);
      toast(msg, "error", 4500);
    } finally {
      setGenerating(false);
      state.pendingAssistantEl = null;
      state.abortFlag = false;
      scrollToBottom(true);
    }
  }

  function humanizeError(err) {
    const txt = (err && (err.message || err.error || err.toString && err.toString())) || "Unknown error";
    if (/auth/i.test(txt)) return "Authentication required by Puter. A sign-in popup may appear; please allow it and try again.";
    if (/network|fetch/i.test(txt)) return "Network error reaching Puter AI. Check your connection and try again.";
    if (/model|not found|unavailable|invalid/i.test(txt)) return `Model \"${state.settings.model}\" failed: ${txt}. Try selecting another model.`;
    return `AI error: ${txt}`;
  }

  function regenerateLast() {
    if (state.isGenerating) return;
    const chat = getActiveChat();
    if (!chat || chat.messages.length === 0) return;
    // Pop last assistant if any
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === "assistant") {
      chat.messages.pop();
    }
    // Need a previous user message to regenerate from
    const prevUser = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!prevUser) {
      toast("Nothing to regenerate.", "info");
      return;
    }
    saveChats();
    renderActiveChat();

    // Build assistant placeholder + redo with current chat
    const ph = appendAssistantPlaceholder();
    setGenerating(true);
    state.abortFlag = false;

    const messagesPayload = buildMessagesPayload(chat);
    const opts = {
      model: state.settings.model,
      stream: !!state.settings.stream,
      temperature: Number(state.settings.temperature),
      max_tokens: Number(state.settings.maxTokens),
    };

    (async () => {
      let assistantContent = "";
      try {
        if (!isPuterReady()) {
          const ready = await waitForPuter(2500);
          if (!ready) throw new Error("Puter.js is still loading.");
        }
        const response = await window.puter.ai.chat(messagesPayload, opts);
        if (state.settings.stream && response && typeof response[Symbol.asyncIterator] === "function") {
          for await (const part of response) {
            if (state.abortFlag) break;
            const token = extractText(part);
            if (token) {
              assistantContent += token;
              ph.update(assistantContent, { streaming: true });
            }
          }
        } else {
          assistantContent = extractFinalText(response);
          ph.update(assistantContent, { streaming: false });
        }
        if (!assistantContent.trim()) assistantContent = "(No response received from the model.)";

        const assistantMsg = {
          id: uid(),
          role: "assistant",
          content: assistantContent,
          ts: Date.now(),
          model: state.settings.model,
          aborted: state.abortFlag || false,
        };
        chat.messages.push(assistantMsg);
        chat.updatedAt = Date.now();
        saveChats();
        renderChatList();
        ph.finalize(assistantMsg);
      } catch (err) {
        console.error(err);
        const msg = humanizeError(err);
        ph.setError(msg);
        toast(msg, "error");
      } finally {
        setGenerating(false);
        state.abortFlag = false;
        scrollToBottom(true);
      }
    })();
  }

  /* ---------------- Settings UI ---------------- */
  function applySettingsUI() {
    els.modelSelect.value = state.settings.model;
    els.tempRange.value = String(state.settings.temperature);
    els.tempVal.textContent = Number(state.settings.temperature).toFixed(2);
    els.maxTokens.value = String(state.settings.maxTokens);
    els.maxTokensVal.textContent = String(state.settings.maxTokens);
    els.streamToggle.checked = !!state.settings.stream;
    els.soundToggle.checked = !!state.settings.sound;
    els.compactToggle.checked = !!state.settings.compact;
    els.body.classList.toggle("compact", !!state.settings.compact);
  }

  function openSettings() {
    els.settingsModal.setAttribute("aria-hidden", "false");
  }
  function closeSettings() {
    els.settingsModal.setAttribute("aria-hidden", "true");
  }

  /* ---------------- Sidebar (mobile) ---------------- */
  function openSidebarMobile() { els.body.classList.add("sidebar-open"); }
  function closeSidebarMobile() { els.body.classList.remove("sidebar-open"); }

  /* ---------------- Code block copy ---------------- */
  // Delegated copy for inline pre code buttons
  els.messages.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".copy-code");
    if (!copyBtn) return;
    const pre = copyBtn.closest("pre");
    const code = pre?.querySelector("code")?.innerText || "";
    navigator.clipboard?.writeText(code).then(
      () => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1400);
      },
      () => toast("Copy failed.", "error")
    );
  });

  /* ---------------- Wire events ---------------- */
  function wireEvents() {
    // Year
    els.year.textContent = new Date().getFullYear();

    // CTA → scroll to chat + ensure a chat
    els.openChatButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!getActiveChat() && state.chats.length === 0) ensureActiveChat();
        $("#chat").scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => els.promptInput.focus(), 400);
      });
    });

    // New chat
    els.newChatBtn.addEventListener("click", () => {
      if (state.isGenerating) {
        toast("Wait for the current response to finish.", "info");
        return;
      }
      // If current chat is empty, just keep it
      const cur = getActiveChat();
      if (cur && cur.messages.length === 0) {
        toast("You're already on a new chat.", "info");
        closeSidebarMobile();
        return;
      }
      createChat();
      closeSidebarMobile();
      els.promptInput.focus();
    });

    // Top clear
    els.topClearBtn.addEventListener("click", () => {
      if (!getActiveChat() || getActiveChat().messages.length === 0) {
        toast("Nothing to clear.", "info");
        return;
      }
      if (confirm("Clear the current conversation?")) clearActiveChat();
    });

    // Model selector
    els.modelSelect.addEventListener("change", () => {
      state.settings.model = els.modelSelect.value || DEFAULT_SETTINGS.model;
      saveSettings();
      toast(`Model set to ${state.settings.model}`, "success", 1800);
    });

    // Composer
    els.promptInput.addEventListener("input", autosizeTextarea);
    els.promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    els.sendBtn.addEventListener("click", () => handleSend());
    els.stopBtn.addEventListener("click", () => {
      state.abortFlag = true;
      toast("Stopping…", "info", 1200);
    });

    // Suggestion chips
    els.promptSuggestions.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      els.promptInput.value = chip.dataset.prompt || chip.textContent;
      autosizeTextarea();
      els.promptInput.focus();
    });

    // Sidebar (mobile)
    els.sidebarToggle.addEventListener("click", openSidebarMobile);
    els.sidebarClose.addEventListener("click", closeSidebarMobile);
    els.sidebarOverlay.addEventListener("click", closeSidebarMobile);

    // Settings modal
    els.openSettings.addEventListener("click", openSettings);
    els.settingsModal.addEventListener("click", (e) => {
      if (e.target.matches("[data-close-modal]")) closeSettings();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeSettings();
        closeSidebarMobile();
      }
    });

    // Settings inputs
    els.tempRange.addEventListener("input", () => {
      const v = Number(els.tempRange.value);
      state.settings.temperature = v;
      els.tempVal.textContent = v.toFixed(2);
      saveSettings();
    });
    els.maxTokens.addEventListener("input", () => {
      const v = Number(els.maxTokens.value);
      state.settings.maxTokens = v;
      els.maxTokensVal.textContent = String(v);
      saveSettings();
    });
    els.streamToggle.addEventListener("change", () => {
      state.settings.stream = !!els.streamToggle.checked;
      saveSettings();
    });
    els.soundToggle.addEventListener("change", () => {
      state.settings.sound = !!els.soundToggle.checked;
      saveSettings();
      if (state.settings.sound) playTone(880, 0.07, "triangle", 0.03);
    });
    els.compactToggle.addEventListener("change", () => {
      state.settings.compact = !!els.compactToggle.checked;
      els.body.classList.toggle("compact", state.settings.compact);
      saveSettings();
    });
    els.clearAllBtn.addEventListener("click", clearAllChats);
  }

  /* ---------------- Init ---------------- */
  function init() {
    wireEvents();
    applySettingsUI();
    createParticles();

    // Restore active chat / list
    if (state.activeId && !state.chats.find((c) => c.id === state.activeId)) {
      setActiveId(state.chats[0]?.id || null);
    }
    renderChatList();
    renderActiveChat();
    autosizeTextarea();

    // Puter status
    setPuterStatus("loading");
    waitForPuter(10000).then((ok) => setPuterStatus(ok ? "ok" : "err"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
