/**
 * VoxOverlay Content Script for Brave / Chromium
 * ==============================================
 * Features:
 *  1. Zero-reflow word & paragraph highlighting via the Chromium CSS Custom Highlight API
 *     (`CSS.highlights` with `::highlight(vox-word)` and `::highlight(vox-paragraph)`).
 *     Does NOT wrap words in <span> tags or mutate page DOM structure!
 *  2. Sentence-ahead WebSocket pipelining (`ws://127.0.0.1:8765/ws/tts`) for gapless
 *     playback between sentences and paragraphs.
 *  3. Real-time pitch-preserving speed control (`0.5x` - `3.0x`) using Chromium's native
 *     WSOLA time-stretcher (`audio.playbackRate` + `audio.preservesPitch = true`), taking
 *     effect immediately mid-word without waiting for re-synthesis.
 *  4. Click-to-read mode: Hold Alt + Click any paragraph on a webpage (or click "Pick Paragraph"
 *     in the HUD) to jump straight to that paragraph and read downward.
 *  5. Built-in PDF Reader Overlay: Automatically handles `.pdf` tabs or local PDF files via
 *     the local server's PyMuPDF extraction endpoint (`/api/pdf/parse`).
 */

(() => {
  if (window.__VOX_OVERLAY_LOADED__) return;
  window.__VOX_OVERLAY_LOADED__ = true;

  const SERVER_HTTP = "http://127.0.0.1:8765";
  const SERVER_WS = "ws://127.0.0.1:8765/ws/tts";

  // -------------------------------------------------------------------------
  // 1. Inject Page-Level ::highlight() CSS Rules (Zero DOM Mutation)
  // -------------------------------------------------------------------------
  const styleEl = document.createElement("style");
  styleEl.id = "vox-overlay-highlight-styles";
  styleEl.textContent = `
    ::highlight(vox-paragraph) {
      background-color: rgba(56, 189, 248, 0.14);
      color: inherit;
    }
    ::highlight(vox-word) {
      background-color: #facc15;
      color: #0f172a;
    }
    .vox-pick-hover {
      outline: 2px dashed #38bdf8 !important;
      outline-offset: 4px !important;
      cursor: pointer !important;
      border-radius: 4px;
    }
  `;
  (document.head || document.documentElement).appendChild(styleEl);

  const supportsCustomHighlight =
    typeof CSS !== "undefined" && "highlights" in CSS;
  const paragraphHighlight = supportsCustomHighlight ? new Highlight() : null;
  const wordHighlight = supportsCustomHighlight ? new Highlight() : null;

  if (supportsCustomHighlight) {
    paragraphHighlight.priority = 1;
    wordHighlight.priority = 2;
    CSS.highlights.set("vox-paragraph", paragraphHighlight);
    CSS.highlights.set("vox-word", wordHighlight);
  }

  // Fallback floating bounding-box overlay if a page uses legacy shadow roots
  const fallbackBox = document.createElement("div");
  Object.assign(fallbackBox.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483645",
    background: "rgba(250, 204, 21, 0.38)",
    borderBottom: "2px solid #eab308",
    borderRadius: "3px",
    transition: "all 45ms linear",
    display: "none",
  });
  document.documentElement.appendChild(fallbackBox);

  // -------------------------------------------------------------------------
  // 2. State Management
  // -------------------------------------------------------------------------
  const state = {
    hudVisible: false,
    isPlaying: false,
    isPaused: false,
    pickMode: false,
    playbackRate: 1.0,
    voice: "af_heart",
    serverOnline: false,
    backendName: "checking...",
    ws: null,
    wsPending: new Map(), // sentence_id -> { resolve, reject }
    paragraphs: [], // Array of { element, text, textNodesMap, sentences: [{ id, text, startChar, endChar }] }
    currentParaIdx: 0,
    currentSentIdx: 0,
    audioCache: new Map(), // sentence_id -> { audioUrl, duration_ms, words }
    audioEl: new Audio(),
    rafId: null,
    activeWordRange: null,
    pdfOverlayOpen: false,
  };

  state.audioEl.preload = "auto";
  state.audioEl.preservesPitch = true;

  // Load saved user preferences
  if (chrome?.storage?.local) {
    chrome.storage.local.get(["vox_speed", "vox_voice"], (res) => {
      if (res.vox_speed) {
        state.playbackRate = parseFloat(res.vox_speed);
        updateSpeedUI(state.playbackRate);
      }
      if (res.vox_voice) {
        state.voice = res.vox_voice;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 3. Text Node Indexing & DOM Range Resolver (Maps character offset -> DOM Range)
  // -------------------------------------------------------------------------
  function buildTextNodeIndex(rootEl) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim())
          return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const segments = [];
    let fullText = "";
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      // Add virtual space between adjacent block/inline nodes if needed
      if (fullText.length > 0 && !/\s$/.test(fullText) && !/^\s/.test(raw)) {
        fullText += " ";
      }
      const start = fullText.length;
      fullText += raw;
      const end = fullText.length;
      segments.push({ node, start, end });
    }
    return { fullText, segments };
  }

  function createDomRangeFromCharOffsets(indexData, charStart, charEnd) {
    if (!indexData || !indexData.segments.length) return null;
    const range = document.createRange();
    let startSet = false;
    let endSet = false;

    for (const seg of indexData.segments) {
      if (!startSet && charStart >= seg.start && charStart <= seg.end) {
        const localStart = Math.min(
          seg.node.nodeValue.length,
          Math.max(0, charStart - seg.start),
        );
        range.setStart(seg.node, localStart);
        startSet = true;
      }
      if (startSet && charEnd >= seg.start && charEnd <= seg.end) {
        const localEnd = Math.min(
          seg.node.nodeValue.length,
          Math.max(0, charEnd - seg.start),
        );
        range.setEnd(seg.node, localEnd);
        endSet = true;
        break;
      }
    }
    return startSet && endSet ? range : null;
  }

  function splitIntoSentences(text) {
    const sentences = [];
    // Use Intl.Segmenter in Chromium for accurate sentence splitting (handles abbreviations like Dr., U.S., etc.)
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
      for (const seg of segmenter.segment(text)) {
        const trimmed = seg.segment.trim();
        if (!trimmed) continue;
        const leadSpaces = seg.segment.indexOf(trimmed);
        const startChar = seg.index + (leadSpaces >= 0 ? leadSpaces : 0);
        const endChar = startChar + trimmed.length;
        sentences.push({ text: trimmed, startChar, endChar });
      }
    } else {
      const regex = /[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const trimmed = match[0].trim();
        if (!trimmed) continue;
        const startChar = match.index + match[0].indexOf(trimmed);
        sentences.push({
          text: trimmed,
          startChar,
          endChar: startChar + trimmed.length,
        });
      }
    }
    return sentences;
  }

  // -------------------------------------------------------------------------
  // 4. Readable Paragraph Discovery on Any Webpage or PDF Overlay
  // -------------------------------------------------------------------------
  function collectReadableParagraphs(startElement = null) {
    const scope = state.pdfOverlayOpen
      ? document.getElementById("vox-pdf-reader-content")
      : document.querySelector("article, main, [role='main']") || document.body;

    const selector = "p, h1, h2, h3, h4, li, blockquote, pre";
    const candidates = Array.from(scope.querySelectorAll(selector)).filter(
      (el) => {
        if (el.closest("#vox-overlay-host")) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity) === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 10) return false;
        const text = (el.innerText || "").trim();
        return text.length >= 3;
      },
    );

    const paragraphs = [];
    let startIdx = 0;

    candidates.forEach((el, idx) => {
      const indexData = buildTextNodeIndex(el);
      const sentencesRaw = splitIntoSentences(indexData.fullText);
      if (!sentencesRaw.length) return;

      const pIndex = paragraphs.length;
      if (startElement && (el === startElement || el.contains(startElement))) {
        startIdx = pIndex;
      }

      const sentences = sentencesRaw.map((s, sIdx) => ({
        id: `p${pIndex}-s${sIdx}`,
        text: s.text,
        startChar: s.startChar,
        endChar: s.endChar,
      }));

      paragraphs.push({
        element: el,
        indexData,
        sentences,
      });
    });

    return { paragraphs, startIdx };
  }

  // -------------------------------------------------------------------------
  // 5. WebSocket & HTTP Client to Local Python TTS Server
  // -------------------------------------------------------------------------
  async function checkServerHealth() {
    try {
      const res = await fetch(`${SERVER_HTTP}/api/health`);
      if (!res.ok) throw new Error("Server returned non-200");
      const data = await res.json();
      state.serverOnline = true;
      state.backendName = data.backend || "kokoro-82m-onnx";
      if (Array.isArray(data.voices)) {
        populateVoicesDropdown(data.voices);
      }
      updateServerBadge(true, state.backendName);
      connectWebSocket();
      return true;
    } catch (err) {
      state.serverOnline = false;
      updateServerBadge(false, "Offline (run python server.py)");
      return false;
    }
  }

  function connectWebSocket() {
    if (
      state.ws &&
      (state.ws.readyState === WebSocket.OPEN ||
        state.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    try {
      const ws = new WebSocket(SERVER_WS);
      state.ws = ws;

      ws.onopen = () => {
        state.serverOnline = true;
        updateServerBadge(true, state.backendName);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.event === "audio_chunk" && msg.sentence_id) {
          const binary = atob(msg.audio_wav_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: "audio/wav" });
          const audioUrl = URL.createObjectURL(blob);

          const entry = {
            audioUrl,
            duration_ms: msg.duration_ms,
            inference_ms: msg.inference_ms,
            words: msg.words || [],
          };
          state.audioCache.set(msg.sentence_id, entry);

          const pending = state.wsPending.get(msg.sentence_id);
          if (pending) {
            state.wsPending.delete(msg.sentence_id);
            pending.resolve(entry);
          }
        }
      };

      ws.onclose = () => {
        state.ws = null;
      };
    } catch (e) {
      console.warn("WebSocket connection failed, using HTTP fallback:", e);
    }
  }

  async function requestSentenceAudio(sentenceObj) {
    const cacheKey = `${sentenceObj.id}:${state.voice}`;
    if (state.audioCache.has(cacheKey)) {
      return state.audioCache.get(cacheKey);
    }

    // Use WebSocket if open, otherwise HTTP POST fallback
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        state.wsPending.set(cacheKey, { resolve, reject });
        state.ws.send(
          JSON.stringify({
            action: "synthesize",
            sentence_id: cacheKey,
            text: sentenceObj.text,
            voice: state.voice,
            model_speed: 1.0,
          }),
        );
      });
    }

    const res = await fetch(`${SERVER_HTTP}/api/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence_id: cacheKey,
        text: sentenceObj.text,
        voice: state.voice,
        model_speed: 1.0,
      }),
    });
    if (!res.ok) throw new Error("TTS request failed");
    const msg = await res.json();
    const binary = atob(msg.audio_wav_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/wav" });
    const entry = {
      audioUrl: URL.createObjectURL(blob),
      duration_ms: msg.duration_ms,
      inference_ms: msg.inference_ms,
      words: msg.words || [],
    };
    state.audioCache.set(cacheKey, entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // 6. Real-Time Highlight Loop & Pipelined Playback Engine
  // -------------------------------------------------------------------------
  function clearHighlights() {
    if (supportsCustomHighlight) {
      paragraphHighlight.clear();
      wordHighlight.clear();
    }
    fallbackBox.style.display = "none";
  }

  function highlightParagraph(paraObj) {
    if (!paraObj) return;
    const { element, indexData } = paraObj;
    const fullRange = createDomRangeFromCharOffsets(
      indexData,
      0,
      indexData.fullText.length,
    );
    if (supportsCustomHighlight && fullRange) {
      paragraphHighlight.clear();
      paragraphHighlight.add(fullRange);
    }

    // Smooth auto-scroll if paragraph is near top/bottom viewport edge
    const rect = element.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.top < 80 || rect.bottom > vh - 120) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function highlightWordInSentence(paraObj, sentenceObj, wordMeta) {
    const absStart = sentenceObj.startChar + wordMeta.start_char;
    const absEnd = sentenceObj.startChar + wordMeta.end_char;
    const wordRange = createDomRangeFromCharOffsets(
      paraObj.indexData,
      absStart,
      absEnd,
    );

    if (!wordRange) return;

    if (supportsCustomHighlight) {
      wordHighlight.clear();
      wordHighlight.add(wordRange);
    } else {
      const rect = wordRange.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fallbackBox.style.display = "block";
        fallbackBox.style.left = `${rect.left - 2}px`;
        fallbackBox.style.top = `${rect.top - 1}px`;
        fallbackBox.style.width = `${rect.width + 4}px`;
        fallbackBox.style.height = `${rect.height + 2}px`;
      }
    }
  }

  function startWordSyncLoop(paraObj, sentenceObj, words) {
    cancelAnimationFrame(state.rafId);
    let lastWordIndex = -1;

    const tick = () => {
      if (!state.isPlaying || state.isPaused) return;
      // audioEl.currentTime is in seconds of the original audio buffer!
      // Because playbackRate scales the audio timeline automatically, currentTime * 1000
      // always matches the exact acoustic position in `words` regardless of speed changes!
      const currentMs = state.audioEl.currentTime * 1000.0;

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (currentMs >= w.start_ms && currentMs <= w.end_ms + 25) {
          if (i !== lastWordIndex) {
            lastWordIndex = i;
            highlightWordInSentence(paraObj, sentenceObj, w);
            updateNowReadingTicker(sentenceObj.text, w.word);
          }
          break;
        }
      }
      state.rafId = requestAnimationFrame(tick);
    };

    state.rafId = requestAnimationFrame(tick);
  }

  function prefetchNextSentence(paraIdx, sentIdx) {
    let nextP = paraIdx;
    let nextS = sentIdx + 1;
    if (!state.paragraphs[nextP]) return;
    if (nextS >= state.paragraphs[nextP].sentences.length) {
      nextP += 1;
      nextS = 0;
    }
    if (
      nextP < state.paragraphs.length &&
      state.paragraphs[nextP].sentences[nextS]
    ) {
      requestSentenceAudio(state.paragraphs[nextP].sentences[nextS]).catch(
        () => {},
      );
    }
  }

  async function playCurrentSentence() {
    if (!state.isPlaying || state.isPaused) return;

    const paraObj = state.paragraphs[state.currentParaIdx];
    if (!paraObj) {
      stopReading();
      return;
    }

    const sentenceObj = paraObj.sentences[state.currentSentIdx];
    if (!sentenceObj) {
      state.currentParaIdx += 1;
      state.currentSentIdx = 0;
      playCurrentSentence();
      return;
    }

    highlightParagraph(paraObj);
    updateProgressUI();

    // Prefetch the following sentence in parallel while current sentence synthesizes/plays
    prefetchNextSentence(state.currentParaIdx, state.currentSentIdx);

    try {
      setPlayButtonState("loading");
      const audioData = await requestSentenceAudio(sentenceObj);
      if (!state.isPlaying || state.isPaused) return;

      setPlayButtonState("playing");
      state.audioEl.src = audioData.audioUrl;
      state.audioEl.playbackRate = state.playbackRate;
      state.audioEl.preservesPitch = true;

      state.audioEl.onended = () => {
        cancelAnimationFrame(state.rafId);
        state.currentSentIdx += 1;
        if (state.currentSentIdx >= paraObj.sentences.length) {
          state.currentParaIdx += 1;
          state.currentSentIdx = 0;
        }
        playCurrentSentence();
      };

      await state.audioEl.play();
      startWordSyncLoop(paraObj, sentenceObj, audioData.words);
    } catch (err) {
      console.error("VoxOverlay playback error:", err);
      updateNowReadingTicker(
        "Cannot reach local TTS server on 127.0.0.1:8765. Start server.py first.",
        "",
      );
      stopReading();
    }
  }

  function startReadingFrom(startElement = null) {
    const { paragraphs, startIdx } = collectReadableParagraphs(startElement);
    if (!paragraphs.length) {
      updateNowReadingTicker("No readable paragraphs found on this page.", "");
      return;
    }
    state.paragraphs = paragraphs;
    state.currentParaIdx = startIdx;
    state.currentSentIdx = 0;
    state.isPlaying = true;
    state.isPaused = false;
    playCurrentSentence();
  }

  function togglePlayPause() {
    if (!state.isPlaying) {
      startReadingFrom();
      return;
    }
    if (state.isPaused) {
      state.isPaused = false;
      state.audioEl.playbackRate = state.playbackRate;
      state.audioEl.play();
      setPlayButtonState("playing");
      const paraObj = state.paragraphs[state.currentParaIdx];
      const sentObj = paraObj?.sentences[state.currentSentIdx];
      const cached = sentObj
        ? state.audioCache.get(`${sentObj.id}:${state.voice}`)
        : null;
      if (paraObj && sentObj && cached) {
        startWordSyncLoop(paraObj, sentObj, cached.words);
      }
    } else {
      state.isPaused = true;
      state.audioEl.pause();
      cancelAnimationFrame(state.rafId);
      setPlayButtonState("paused");
    }
  }

  function stopReading() {
    state.isPlaying = false;
    state.isPaused = false;
    state.audioEl.pause();
    cancelAnimationFrame(state.rafId);
    clearHighlights();
    setPlayButtonState("idle");
    updateNowReadingTicker(
      "Ready — Press Play or Alt+Click any paragraph to start",
      "",
    );
  }

  function skipParagraph(delta) {
    if (!state.paragraphs.length) return;
    state.audioEl.pause();
    cancelAnimationFrame(state.rafId);
    state.currentParaIdx = Math.max(
      0,
      Math.min(state.paragraphs.length - 1, state.currentParaIdx + delta),
    );
    state.currentSentIdx = 0;
    if (!state.isPlaying) {
      state.isPlaying = true;
      state.isPaused = false;
    }
    playCurrentSentence();
  }

  function setSpeed(newSpeed) {
    const clamped =
      Math.round(Math.max(0.5, Math.min(3.0, newSpeed)) * 10) / 10;
    state.playbackRate = clamped;
    // Apply immediately to active audio element without interrupting word sync!
    state.audioEl.playbackRate = clamped;
    state.audioEl.preservesPitch = true;
    updateSpeedUI(clamped);
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ vox_speed: clamped });
    }
  }

  // -------------------------------------------------------------------------
  // 7. Built-In PDF Reader Overlay (Handles Web PDFs & Local PDF Uploads)
  // -------------------------------------------------------------------------
  async function openPdfInReader({ file = null, url = null } = {}) {
    try {
      updateNowReadingTicker(
        "Extracting PDF text and layout via local server...",
        "",
      );
      const formData = new FormData();
      if (file) formData.append("file", file);
      if (url) formData.append("url", url);

      const res = await fetch(`${SERVER_HTTP}/api/pdf/parse`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("PDF parse error");
      const data = await res.json();
      renderPdfOverlay(data, file ? file.name : url);
    } catch (err) {
      updateNowReadingTicker(
        "Failed to parse PDF. Ensure server.py is running with pymupdf installed.",
        "",
      );
    }
  }

  function renderPdfOverlay(pdfData, title) {
    let overlay = document.getElementById("vox-pdf-reader-modal");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vox-pdf-reader-modal";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483640",
        background: "#0f172a",
        color: "#f8fafc",
        overflowY: "auto",
        padding: "48px 20px 160px",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      });
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
      <div style="max-width: 780px; margin: 0 auto; background: #1e293b; padding: 40px 48px; border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #334155; padding-bottom:16px; margin-bottom:28px;">
          <div>
            <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:#38bdf8; font-weight:600;">VoxOverlay PDF Reader Mode (${pdfData.page_count} Pages)</div>
            <h1 style="font-size:20px; margin:4px 0 0; color:#f1f5f9;">${title || "PDF Document"}</h1>
          </div>
          <button id="vox-close-pdf-btn" style="background:#334155; color:#f8fafc; border:none; padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:600;">Close PDF View</button>
        </div>
        <div id="vox-pdf-reader-content" style="line-height:1.75; font-size:18px; color:#e2e8f0;"></div>
      </div>
    `;

    const contentBox = overlay.querySelector("#vox-pdf-reader-content");
    pdfData.pages.forEach((p) => {
      const pageHeader = document.createElement("div");
      pageHeader.style.cssText =
        "font-size:12px; color:#94a3b8; margin:28px 0 10px; font-weight:600; text-transform:uppercase;";
      pageHeader.textContent = `Page ${p.page}`;
      contentBox.appendChild(pageHeader);

      p.paragraphs.forEach((paraText) => {
        const pEl = document.createElement("p");
        pEl.style.cssText =
          "margin: 0 0 16px; padding: 6px 8px; border-radius: 6px;";
        pEl.textContent = paraText;
        contentBox.appendChild(pEl);
      });
    });

    overlay
      .querySelector("#vox-close-pdf-btn")
      .addEventListener("click", () => {
        stopReading();
        overlay.remove();
        state.pdfOverlayOpen = false;
      });

    state.pdfOverlayOpen = true;
    startReadingFrom();
  }

  // -------------------------------------------------------------------------
  // 8. Floating Shadow-DOM HUD Controller (Isolated from Page Styles)
  // -------------------------------------------------------------------------
  const host = document.createElement("div");
  host.id = "vox-overlay-host";
  Object.assign(host.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
    display: "none",
  });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .hud {
        width: 410px;
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(16px);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 16px;
        padding: 14px 16px;
        box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.55);
        user-select: none;
      }
      .top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.01em;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #ef4444;
      }
      .dot.online {
        background: #22c55e;
        box-shadow: 0 0 8px #22c55e;
      }
      .badge {
        font-size: 11px;
        color: #94a3b8;
        font-weight: 500;
      }
      .close-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }

      .ticker {
        background: rgba(30, 41, 59, 0.85);
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 10px;
        padding: 8px 11px;
        font-size: 12.5px;
        color: #cbd5e1;
        margin-bottom: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ticker strong {
        color: #facc15;
        font-weight: 700;
      }

      .controls-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 12px;
      }
      .btn-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      button.ctrl {
        background: #1e293b;
        color: #e2e8f0;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 9px;
        padding: 7px 11px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      button.ctrl:hover {
        background: #334155;
        border-color: #38bdf8;
      }
      button.ctrl.primary {
        background: #0284c7;
        border-color: #38bdf8;
        color: #fff;
        min-width: 78px;
      }
      button.ctrl.primary:hover {
        background: #0369a1;
      }
      button.ctrl.active-pick {
        background: #eab308;
        color: #0f172a;
        border-color: #facc15;
      }

      .speed-row {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(30, 41, 59, 0.65);
        padding: 8px 10px;
        border-radius: 10px;
        margin-bottom: 10px;
      }
      .speed-label {
        font-size: 12px;
        font-weight: 600;
        color: #e2e8f0;
        min-width: 76px;
      }
      .speed-val {
        color: #38bdf8;
        font-weight: 700;
      }
      input[type="range"] {
        flex: 1;
        accent-color: #38bdf8;
        cursor: pointer;
      }
      .preset-btn {
        background: rgba(51, 65, 85, 0.7);
        border: none;
        color: #cbd5e1;
        font-size: 11px;
        padding: 3px 6px;
        border-radius: 5px;
        cursor: pointer;
      }
      .preset-btn:hover { background: #475569; color: #fff; }

      .bottom-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      select {
        flex: 1;
        background: #1e293b;
        color: #f1f5f9;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 8px;
        padding: 5px 8px;
        font-size: 12px;
      }
      .pdf-btn {
        font-size: 11.5px;
        padding: 5px 9px;
      }
    </style>

    <div class="hud">
      <div class="top-bar">
        <div class="brand">
          <span class="dot" id="server-dot"></span>
          <span>VoxOverlay</span>
          <span class="badge" id="server-badge">Connecting...</span>
        </div>
        <button class="close-btn" id="hud-close" title="Hide HUD (Alt+R)">✕</button>
      </div>

      <div class="ticker" id="now-reading-ticker">
        Ready — Press Play or <strong>Alt + Click</strong> any paragraph
      </div>

      <div class="controls-row">
        <div class="btn-group">
          <button class="ctrl" id="btn-prev" title="Previous Paragraph">⏮</button>
          <button class="ctrl primary" id="btn-play">▶ Play</button>
          <button class="ctrl" id="btn-next" title="Next Paragraph">⏭</button>
          <button class="ctrl" id="btn-stop" title="Stop & Clear Highlights">⏹</button>
        </div>
        <button class="ctrl" id="btn-pick" title="Click any paragraph on the page to start reading from there">🎯 Pick Text</button>
      </div>

      <div class="speed-row">
        <div class="speed-label">Pace: <span class="speed-val" id="speed-display">1.0x</span></div>
        <input type="range" id="speed-slider" min="0.5" max="3.0" step="0.1" value="1.0" />
        <button class="preset-btn" data-speed="1.0">1x</button>
        <button class="preset-btn" data-speed="1.5">1.5x</button>
        <button class="preset-btn" data-speed="2.0">2x</button>
      </div>

      <div class="bottom-row">
        <select id="voice-select">
          <option value="af_heart">Heart (US Female - Natural)</option>
          <option value="af_bella">Bella (US Female - Expressive)</option>
          <option value="af_nicole">Nicole (US Female - Calm)</option>
          <option value="am_adam">Adam (US Male - Deep)</option>
          <option value="am_michael">Michael (US Male - Clear)</option>
          <option value="bf_emma">Emma (UK Female)</option>
          <option value="bm_george">George (UK Male)</option>
        </select>
        <button class="ctrl pdf-btn" id="btn-open-pdf" title="Open a local PDF or parse current PDF tab">📄 Open PDF</button>
        <input type="file" id="pdf-file-input" accept="application/pdf" style="display:none" />
      </div>
    </div>
  `;

  // Wire up Shadow DOM UI elements
  const serverDot = shadow.getElementById("server-dot");
  const serverBadge = shadow.getElementById("server-badge");
  const tickerEl = shadow.getElementById("now-reading-ticker");
  const btnPlay = shadow.getElementById("btn-play");
  const btnPrev = shadow.getElementById("btn-prev");
  const btnNext = shadow.getElementById("btn-next");
  const btnStop = shadow.getElementById("btn-stop");
  const btnPick = shadow.getElementById("btn-pick");
  const speedSlider = shadow.getElementById("speed-slider");
  const speedDisplay = shadow.getElementById("speed-display");
  const voiceSelect = shadow.getElementById("voice-select");
  const btnOpenPdf = shadow.getElementById("btn-open-pdf");
  const pdfFileInput = shadow.getElementById("pdf-file-input");

  function updateServerBadge(online, text) {
    serverDot.classList.toggle("online", online);
    serverBadge.textContent = text;
  }

  function updateNowReadingTicker(sentenceText, activeWord) {
    if (!activeWord) {
      tickerEl.textContent = sentenceText;
      return;
    }
    tickerEl.innerHTML = `Speaking: <strong>${activeWord}</strong> — ${sentenceText}`;
  }

  function updateProgressUI() {
    if (!state.paragraphs.length) return;
    serverBadge.textContent = `${state.backendName} • Para ${state.currentParaIdx + 1}/${state.paragraphs.length}`;
  }

  function setPlayButtonState(mode) {
    if (mode === "loading") {
      btnPlay.textContent = "⏳ Synth...";
    } else if (mode === "playing") {
      btnPlay.textContent = "⏸ Pause";
    } else if (mode === "paused") {
      btnPlay.textContent = "▶ Resume";
    } else {
      btnPlay.textContent = "▶ Play";
    }
  }

  function updateSpeedUI(speedVal) {
    speedSlider.value = String(speedVal);
    speedDisplay.textContent = `${speedVal.toFixed(1)}x`;
  }

  function populateVoicesDropdown(voices) {
    voiceSelect.innerHTML = "";
    voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      if (v.id === state.voice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  }

  btnPlay.addEventListener("click", () => togglePlayPause());
  btnPrev.addEventListener("click", () => skipParagraph(-1));
  btnNext.addEventListener("click", () => skipParagraph(1));
  btnStop.addEventListener("click", () => stopReading());

  speedSlider.addEventListener("input", (e) => {
    setSpeed(parseFloat(e.target.value));
  });

  shadow.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSpeed(parseFloat(btn.getAttribute("data-speed")));
    });
  });

  voiceSelect.addEventListener("change", (e) => {
    state.voice = e.target.value;
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ vox_voice: state.voice });
    }
  });

  btnOpenPdf.addEventListener("click", () => {
    if (
      location.pathname.toLowerCase().endsWith(".pdf") ||
      document.contentType === "application/pdf"
    ) {
      openPdfInReader({ url: location.href });
    } else {
      pdfFileInput.click();
    }
  });

  pdfFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) openPdfInReader({ file });
  });

  shadow.getElementById("hud-close").addEventListener("click", () => {
    state.hudVisible = false;
    host.style.display = "none";
  });

  // -------------------------------------------------------------------------
  // 9. Interactive "Pick Paragraph" Mode & Alt+Click Shortcut
  // -------------------------------------------------------------------------
  let hoveredPickEl = null;

  btnPick.addEventListener("click", () => {
    state.pickMode = !state.pickMode;
    btnPick.classList.toggle("active-pick", state.pickMode);
    if (!state.pickMode && hoveredPickEl) {
      hoveredPickEl.classList.remove("vox-pick-hover");
      hoveredPickEl = null;
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (!state.pickMode) return;
    const target = e.target.closest?.("p, h1, h2, h3, h4, li, blockquote");
    if (target !== hoveredPickEl) {
      if (hoveredPickEl) hoveredPickEl.classList.remove("vox-pick-hover");
      if (target && !target.closest("#vox-overlay-host")) {
        hoveredPickEl = target;
        hoveredPickEl.classList.add("vox-pick-hover");
      } else {
        hoveredPickEl = null;
      }
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest?.("#vox-overlay-host")) return;

      // Support either active Pick Mode OR holding Alt + Click anywhere on the page
      if (state.pickMode || e.altKey) {
        const block = e.target.closest?.("p, h1, h2, h3, h4, li, blockquote");
        if (block) {
          e.preventDefault();
          e.stopPropagation();
          if (hoveredPickEl) hoveredPickEl.classList.remove("vox-pick-hover");
          state.pickMode = false;
          btnPick.classList.remove("active-pick");
          showHud();
          startReadingFrom(block);
        }
      }
    },
    true,
  );

  // Keyboard shortcuts while HUD is open: [ and ] adjust speed by 0.1x
  document.addEventListener("keydown", (e) => {
    if (!state.hudVisible) return;
    const tag = (e.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
      return;

    if (e.key === "]") {
      setSpeed(state.playbackRate + 0.1);
    } else if (e.key === "[") {
      setSpeed(state.playbackRate - 0.1);
    }
  });

  function showHud() {
    state.hudVisible = true;
    host.style.display = "block";
    checkServerHealth();
  }

  // Listen for messages from background.js (Toolbar button, Alt+R, Context Menu)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.command === "toggle-hud") {
      if (state.hudVisible) {
        state.hudVisible = false;
        host.style.display = "none";
      } else {
        showHud();
      }
    } else if (msg.command === "play-pause") {
      showHud();
      togglePlayPause();
    } else if (msg.command === "read-selection-or-page") {
      showHud();
      const sel = window.getSelection();
      const anchorEl = sel?.anchorNode?.parentElement?.closest(
        "p, h1, h2, h3, h4, li, blockquote",
      );
      startReadingFrom(anchorEl || null);
    }
  });
})();
