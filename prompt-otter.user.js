// ==UserScript==
// @name         Prompt Otter
// @namespace    https://github.com/Robinja2200/prompt-otter
// @version      1.0.0
// @description  Navigate, search, and load all your prompts in long ChatGPT conversations.
// @author       Robin Janssens
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// @homepageURL  https://github.com/Robinja2200/prompt-otter
// @supportURL   https://github.com/Robinja2200/prompt-otter/issues
// ==/UserScript==

(() => {
  'use strict';

  const IDS = {
    style: 'gpn-style-v2',
    panel: 'gpn-panel-v2',
    restore: 'gpn-restore-v2',
  };

  const STORE = {
    position: 'gpn:v2:position',
    sizes: 'gpn:v2:sizes',
    expanded: 'gpn:v2:expanded',
    hidden: 'gpn:v2:hidden',
    query: 'gpn:v2:query',
  };

  const CONFIG = {
    margin: 8,
    edge: 8,
    corner: 15,
    scanDebounceMs: 100,
    maxRenderedRows: 800,
    minSizes: {
      expanded: { width: 420, height: 340 },
      collapsed: { width: 330, height: 108 },
    },
    defaultSizes: {
      expanded: { width: 590, height: 660 },
      collapsed: { width: 430, height: 136 },
    },
    // Turbo is the default because it tested as accurate while being much faster.
    loadAll: {
      topStablePasses: 1,
      bottomStablePasses: 1,
      maxTopPasses: 45,
      maxBottomPasses: 45,
      maxSweepSteps: 2500,
      waitTimeoutMs: 750,
      quietMs: 80,
      stepRatio: 0.92,
      minStepPx: 520,
    },
    // Safe load is kept as a slower fallback for unusually slow/network-laggy chats.
    safeLoad: {
      topStablePasses: 3,
      bottomStablePasses: 3,
      maxTopPasses: 120,
      maxBottomPasses: 120,
      maxSweepSteps: 5000,
      waitTimeoutMs: 1800,
      quietMs: 220,
      stepRatio: 0.56,
      minStepPx: 320,
    },
    jump: {
      topOffsetPx: 92,
      tolerancePx: 18,
      waitTimeoutMs: 950,
      quietMs: 90,
      maxAlignAttempts: 8,
      maxMountNudges: 14,
      maxFallbackSteps: 260,
    },
  };

  const state = {
    conversationKey: getConversationKey(),
    records: [],
    recordMap: new Map(),
    activeKey: null,
    nextSeq: 1,

    expanded: localStorage.getItem(STORE.expanded) === '1',
    hidden: localStorage.getItem(STORE.hidden) === '1',
    query: localStorage.getItem(STORE.query) || '',
    sizes: mergeSizes(readJson(STORE.sizes), CONFIG.defaultSizes),

    scroller: null,
    scrollerLabel: 'unknown',
    removeScrollListener: null,

    scanTimer: null,
    scrollTimer: null,
    noticeTimer: null,
    renderTimer: null,
    scanRunning: false,
    scanAgain: false,
    deferRender: false,
    lastRenderSignature: '',

    loadAllRunning: false,
    loadAllAbort: false,
    activeLoadConfig: null,
    progressLastAt: 0,

    menuOpen: false,
    dragging: false,
    resizing: false,
  };

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function mergeSizes(saved, defaults) {
    return {
      expanded: {
        width: Number(saved?.expanded?.width) || defaults.expanded.width,
        height: Number(saved?.expanded?.height) || defaults.expanded.height,
      },
      collapsed: {
        width: Number(saved?.collapsed?.width) || defaults.collapsed.width,
        height: Number(saved?.collapsed?.height) || defaults.collapsed.height,
      },
    };
  }

  function getConversationKey() {
    return `${location.origin}${location.pathname}`;
  }

  function checkConversationChanged() {
    const key = getConversationKey();
    if (key === state.conversationKey) return false;
    state.conversationKey = key;
    clearPromptCache({ keepNotice: true });
    redetectScroller({ silent: true });
    return true;
  }

  function injectStyle() {
    if (document.getElementById(IDS.style)) return;

    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      .gpn-prompt-v2 {
        position: relative !important;
        scroll-margin-top: 96px !important;
      }

      .gpn-prompt-v2 [data-message-author-role="user"],
      .gpn-prompt-v2.gpn-fallback-v2 {
        outline: 2px solid rgba(245, 158, 11, .86) !important;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, .14) !important;
        border-radius: 14px !important;
        transition: outline-color .15s ease, box-shadow .15s ease !important;
      }

      .gpn-active-v2 [data-message-author-role="user"],
      .gpn-active-v2.gpn-fallback-v2 {
        outline: 3px solid rgba(34, 197, 94, .96) !important;
        box-shadow: 0 0 0 6px rgba(34, 197, 94, .20) !important;
      }

      #${IDS.panel}, #${IDS.restore} {
        font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${IDS.panel} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(128,128,128,.38);
        border-radius: 14px;
        background: color-mix(in srgb, Canvas 92%, transparent);
        color: CanvasText;
        box-shadow: 0 14px 44px rgba(0,0,0,.24);
        backdrop-filter: blur(12px);
        user-select: auto;
      }

      #${IDS.panel}.gpn-hidden-v2 { display: none !important; }
      #${IDS.panel} * { box-sizing: border-box; }

      #${IDS.panel} button,
      #${IDS.panel} input {
        font: inherit;
        border-radius: 9px;
        border: 1px solid rgba(128,128,128,.36);
        background: Canvas;
        color: CanvasText;
      }

      #${IDS.panel} button {
        cursor: pointer;
        padding: 5px 8px;
        min-height: 29px;
        white-space: nowrap;
      }

      #${IDS.panel} button:hover,
      #${IDS.panel} .gpn-row:hover {
        background: color-mix(in srgb, CanvasText 8%, Canvas);
      }

      #${IDS.panel} button:disabled {
        cursor: not-allowed;
        opacity: .55;
      }

      #${IDS.panel} button:focus-visible,
      #${IDS.panel} input:focus-visible {
        outline: 2px solid rgba(59, 130, 246, .95);
        outline-offset: 1px;
      }

      #${IDS.panel} .gpn-header {
        position: relative;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 48px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(128,128,128,.18);
        user-select: none;
        flex-shrink: 0;
      }

      #${IDS.panel}.gpn-collapsed-v2 .gpn-header {
        border-bottom: 1px solid rgba(128,128,128,.12);
      }

      #${IDS.panel} .gpn-drag {
        cursor: grab;
        min-width: 24px;
        text-align: center;
        opacity: .72;
        font-size: 16px;
        line-height: 1;
        padding: 6px 2px;
      }

      #${IDS.panel}.gpn-dragging-v2 .gpn-drag { cursor: grabbing; }
      #${IDS.panel}.gpn-dragging-v2,
      #${IDS.panel}.gpn-resizing-v2 { user-select: none; }

      #${IDS.panel} .gpn-title {
        font-weight: 650;
        white-space: nowrap;
        margin-right: 2px;
      }

      #${IDS.panel} .gpn-count {
        min-width: 64px;
        text-align: center;
        opacity: .82;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      #${IDS.panel} .gpn-spacer { flex: 1 1 auto; min-width: 4px; }
      #${IDS.panel} .gpn-secondary,
      #${IDS.panel} .gpn-tertiary { display: inline-flex; }

      #${IDS.panel} .gpn-menu-wrap { position: relative; }
      #${IDS.panel} .gpn-menu {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        z-index: 40;
        display: none;
        min-width: 252px;
        padding: 6px;
        border: 1px solid rgba(128,128,128,.35);
        border-radius: 12px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 14px 36px rgba(0,0,0,.22);
      }

      #${IDS.panel}.gpn-menu-open-v2 .gpn-menu { display: grid; gap: 4px; }
      #${IDS.panel} .gpn-menu button {
        width: 100%;
        text-align: left;
        border-color: transparent;
        background: transparent;
      }

      #${IDS.panel} .gpn-body {
        display: none;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        flex: 1;
        padding: 8px 10px 10px;
      }

      #${IDS.panel}.gpn-expanded-v2 .gpn-body { display: flex; }

      #${IDS.panel} .gpn-compact {
        display: none;
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 8px 10px 12px;
      }

      #${IDS.panel}.gpn-collapsed-v2 .gpn-compact { display: block; }
      #${IDS.panel} .gpn-compact-label { opacity: .66; font-size: 12px; margin-bottom: 4px; }
      #${IDS.panel} .gpn-compact-text { line-height: 1.35; overflow-wrap: anywhere; }

      #${IDS.panel} .gpn-search-row {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }

      #${IDS.panel} .gpn-search {
        width: 100%;
        min-width: 0;
        padding: 7px 9px;
      }

      #${IDS.panel} .gpn-list {
        overflow: auto;
        min-height: 0;
        flex: 1;
        border: 1px solid rgba(128,128,128,.23);
        border-radius: 10px;
        background: color-mix(in srgb, Canvas 89%, transparent);
      }

      #${IDS.panel} .gpn-row {
        display: grid;
        grid-template-columns: 50px minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        width: 100%;
        padding: 8px;
        border: 0;
        border-bottom: 1px solid rgba(128,128,128,.14);
        border-radius: 0;
        background: transparent;
        color: CanvasText;
        text-align: left;
      }

      #${IDS.panel} .gpn-row:last-child { border-bottom: 0; }
      #${IDS.panel} .gpn-row.gpn-selected { background: rgba(34, 197, 94, .15); }
      #${IDS.panel} .gpn-num { opacity: .66; font-variant-numeric: tabular-nums; }
      #${IDS.panel} .gpn-text {
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      #${IDS.panel} .gpn-status { opacity: .58; font-size: 12px; white-space: nowrap; }
      #${IDS.panel} .gpn-empty { padding: 14px; opacity: .72; text-align: center; }

      #${IDS.panel} .gpn-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 32px;
        font-size: 12px;
        opacity: .82;
        flex-shrink: 0;
      }

      #${IDS.panel} .gpn-notice {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${IDS.panel} .gpn-footer-actions { display: flex; gap: 6px; flex-shrink: 0; }
      #${IDS.panel}.gpn-loading-v2 .gpn-load-label::after { content: "…"; }

      #${IDS.panel}.gpn-sm-v2 .gpn-title,
      #${IDS.panel}.gpn-xs-v2 .gpn-title,
      #${IDS.panel}.gpn-xs-v2 .gpn-secondary,
      #${IDS.panel}.gpn-xs-v2 .gpn-tertiary,
      #${IDS.panel}.gpn-sm-v2 .gpn-tertiary { display: none !important; }

      #${IDS.panel}.gpn-short-v2 .gpn-footer,
      #${IDS.panel}.gpn-collapsed-v2.gpn-short-v2 .gpn-compact-label { display: none !important; }

      #${IDS.panel}.gpn-xs-v2 .gpn-header { gap: 4px; padding-left: 8px; padding-right: 8px; }
      #${IDS.panel}.gpn-xs-v2 button { padding-left: 7px; padding-right: 7px; }
      #${IDS.panel}.gpn-xs-v2 .gpn-count { min-width: 56px; }

      #${IDS.panel} .gpn-resize {
        position: absolute;
        z-index: 25;
        background: transparent;
        touch-action: none;
      }
      #${IDS.panel} .gpn-r-n { top: 0; left: ${CONFIG.corner}px; right: ${CONFIG.corner}px; height: ${CONFIG.edge}px; cursor: ns-resize; }
      #${IDS.panel} .gpn-r-s { bottom: 0; left: ${CONFIG.corner}px; right: ${CONFIG.corner}px; height: ${CONFIG.edge}px; cursor: ns-resize; }
      #${IDS.panel} .gpn-r-e { right: 0; top: ${CONFIG.corner}px; bottom: ${CONFIG.corner}px; width: ${CONFIG.edge}px; cursor: ew-resize; }
      #${IDS.panel} .gpn-r-w { left: 0; top: ${CONFIG.corner}px; bottom: ${CONFIG.corner}px; width: ${CONFIG.edge}px; cursor: ew-resize; }
      #${IDS.panel} .gpn-r-ne, #${IDS.panel} .gpn-r-nw, #${IDS.panel} .gpn-r-se, #${IDS.panel} .gpn-r-sw { width: ${CONFIG.corner}px; height: ${CONFIG.corner}px; }
      #${IDS.panel} .gpn-r-ne { top: 0; right: 0; cursor: nesw-resize; }
      #${IDS.panel} .gpn-r-nw { top: 0; left: 0; cursor: nwse-resize; }
      #${IDS.panel} .gpn-r-se { bottom: 0; right: 0; cursor: nwse-resize; }
      #${IDS.panel} .gpn-r-sw { bottom: 0; left: 0; cursor: nesw-resize; }

      #${IDS.panel}.gpn-resizing-v2::after {
        content: "";
        position: absolute;
        inset: 0;
        border: 1px dashed rgba(59, 130, 246, .9);
        border-radius: 14px;
        pointer-events: none;
        z-index: 26;
      }

      #${IDS.restore} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        display: none;
        border: 1px solid rgba(128,128,128,.38);
        border-radius: 999px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 10px 28px rgba(0,0,0,.20);
        padding: 8px 12px;
        cursor: pointer;
      }
      #${IDS.restore}.gpn-visible-v2 { display: block; }
    `;

    document.head.appendChild(style);
  }

  function getPanel() {
    let panel = document.getElementById(IDS.panel);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = IDS.panel;
    document.body.appendChild(panel);

    const pos = readJson(STORE.position);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      panel.style.left = `${pos.left}px`;
      panel.style.top = `${pos.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('keydown', onPanelKeyDown);
    panel.addEventListener('pointerdown', onPanelPointerDown);
    return panel;
  }

  function getRestoreTab() {
    let tab = document.getElementById(IDS.restore);
    if (tab) return tab;
    tab = document.createElement('button');
    tab.id = IDS.restore;
    tab.type = 'button';
    tab.textContent = 'Prompt Otter';
    tab.title = 'Show prompt navigator (Alt+P)';
    tab.addEventListener('click', () => setHidden(false));
    document.body.appendChild(tab);
    return tab;
  }

  function mode() { return state.expanded ? 'expanded' : 'collapsed'; }
  function minSize() { return CONFIG.minSizes[mode()]; }
  function size() { return state.sizes[mode()]; }
  function activeLoadConfig() { return state.activeLoadConfig || CONFIG.loadAll; }

  function applyPanelGeometry(panel = getPanel()) {
    const s = size();
    const m = minSize();
    s.width = clamp(s.width, m.width, Math.max(m.width, window.innerWidth - CONFIG.margin * 2));
    s.height = clamp(s.height, m.height, Math.max(m.height, window.innerHeight - CONFIG.margin * 2));
    panel.style.width = `${s.width}px`;
    panel.style.height = `${s.height}px`;
    writeJson(STORE.sizes, state.sizes);
    keepPanelOnScreen(panel);
    updateResponsiveClasses(panel);
  }

  function updateResponsiveClasses(panel = getPanel()) {
    const width = panel.offsetWidth || size().width;
    const height = panel.offsetHeight || size().height;
    panel.classList.toggle('gpn-xs-v2', width < 445);
    panel.classList.toggle('gpn-sm-v2', width >= 445 && width < 540);
    panel.classList.toggle('gpn-md-v2', width >= 540);
    panel.classList.toggle('gpn-short-v2', state.expanded ? height < 405 : height < 126);
    panel.classList.toggle('gpn-loading-v2', state.loadAllRunning);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isTypingTarget(el) {
    return el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }

  function isDocumentScroller(el) {
    return !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  function getScrollTop(el = state.scroller) {
    if (isDocumentScroller(el)) return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    return el.scrollTop;
  }

  function setScrollTop(el, top) {
    const y = clamp(Math.round(top), 0, getMaxScrollTop(el));
    if (isDocumentScroller(el)) {
      window.scrollTo({ top: y, behavior: 'auto' });
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y;
    } else {
      el.scrollTop = y;
    }
  }

  function getClientHeight(el = state.scroller) {
    if (isDocumentScroller(el)) return window.innerHeight;
    return el.clientHeight;
  }

  function getScrollHeight(el = state.scroller) {
    if (isDocumentScroller(el)) {
      return Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        document.scrollingElement?.scrollHeight || 0
      );
    }
    return el.scrollHeight;
  }

  function getMaxScrollTop(el = state.scroller) {
    return Math.max(0, getScrollHeight(el) - getClientHeight(el));
  }

  function elementLabel(el) {
    if (isDocumentScroller(el)) return 'document';
    const id = el.id ? `#${el.id}` : '';
    const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
  }

  function isScrollableElement(el) {
    if (!el || el.nodeType !== 1 || el.closest?.(`#${IDS.panel}, #${IDS.restore}`)) return false;
    const range = el.scrollHeight - el.clientHeight;
    if (range < 120) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 280 || rect.height < 180) return false;
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    return /(auto|scroll|overlay)/.test(oy) || range > 300;
  }

  function detectConversationScroller() {
    const prompts = [...document.querySelectorAll('[data-message-author-role="user"], [data-testid^="conversation-turn-"]')]
      .filter(n => !n.closest?.(`#${IDS.panel}, #${IDS.restore}`));

    const candidates = new Set([document.scrollingElement || document.documentElement]);

    for (const node of prompts.slice(0, 20)) {
      let el = node.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        if (isScrollableElement(el)) candidates.add(el);
        el = el.parentElement;
      }
    }

    // Fallback: scan likely scroll containers. This runs only when redetecting, not on every mutation.
    for (const el of document.querySelectorAll('main, [role="main"], div[class*="overflow"], div[class*="scroll"], div')) {
      if (isScrollableElement(el)) candidates.add(el);
    }

    let best = document.scrollingElement || document.documentElement;
    let bestScore = -Infinity;

    for (const el of candidates) {
      const range = getScrollHeight(el) - getClientHeight(el);
      const containsCount = prompts.reduce((n, prompt) => n + (isDocumentScroller(el) || el.contains(prompt) ? 1 : 0), 0);
      const rect = isDocumentScroller(el) ? { height: window.innerHeight, width: window.innerWidth } : el.getBoundingClientRect();
      const score = containsCount * 100000 + Math.max(0, range) * 10 + rect.height + rect.width * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function setScroller(el) {
    if (!el) el = document.scrollingElement || document.documentElement;
    if (state.scroller === el) return;

    if (state.removeScrollListener) {
      state.removeScrollListener();
      state.removeScrollListener = null;
    }

    state.scroller = el;
    state.scrollerLabel = elementLabel(el);

    if (isDocumentScroller(el)) {
      window.addEventListener('scroll', onAnyScroll, { passive: true });
      state.removeScrollListener = () => window.removeEventListener('scroll', onAnyScroll, { passive: true });
    } else {
      el.addEventListener('scroll', onAnyScroll, { passive: true });
      state.removeScrollListener = () => el.removeEventListener('scroll', onAnyScroll, { passive: true });
    }
  }

  function redetectScroller(options = {}) {
    const next = detectConversationScroller();
    setScroller(next);
    if (!options.silent) showNotice(`Scroller ready: ${state.scrollerLabel}, range ${Math.round(getMaxScrollTop(next))}px.`);
    return next;
  }

  function getRelativeTop(el, scroller = state.scroller) {
    const rect = el.getBoundingClientRect();
    if (isDocumentScroller(scroller)) return getScrollTop(scroller) + rect.top;
    const srect = scroller.getBoundingClientRect();
    return getScrollTop(scroller) + rect.top - srect.top;
  }

  function getPromptNodes() {
    const direct = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const fallback = [...document.querySelectorAll('h5.sr-only, .sr-only')]
      .filter(el => /you said|user/i.test(el.textContent || ''))
      .map(el => el.parentElement)
      .filter(Boolean);
    return [...direct, ...fallback].filter(node => !node.closest?.(`#${IDS.panel}, #${IDS.restore}`));
  }

  function closestTurn(node) {
    return (
      node.closest('[data-testid^="conversation-turn-"]') ||
      node.closest('[data-turn-id]') ||
      node.closest('article') ||
      node.closest('main div[class*="group"]') ||
      node
    );
  }

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, svg, textarea, input, select, [aria-hidden="true"]').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '')
      .replace(/^\s*You said:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getTurnInfo(turn) {
    const testId = turn?.getAttribute?.('data-testid') || turn?.querySelector?.('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '';
    const turnId = turn?.getAttribute?.('data-turn-id') || turn?.querySelector?.('[data-turn-id]')?.getAttribute('data-turn-id') || '';
    const messageId = turn?.getAttribute?.('data-message-id') || turn?.querySelector?.('[data-message-id]')?.getAttribute('data-message-id') || '';
    let turnNumber = null;
    const match = testId.match(/conversation-turn-(\d+)/i);
    if (match) turnNumber = Number(match[1]);
    return { testId, turnId, messageId, turnNumber };
  }

  function stableKeyFrom(info, textHash) {
    if (info.turnId) return `turn:${info.turnId}`;
    if (info.messageId) return `msg:${info.messageId}`;
    if (info.testId) return `test:${info.testId}`;
    return `weak:${textHash}`;
  }

  function findExistingByText(text, textHash, matched) {
    for (const rec of state.records) {
      if (matched.has(rec.key)) continue;
      if (rec.textHash === textHash && rec.text === text) return rec;
    }
    return null;
  }

  function upgradeRecordKey(rec, newKey) {
    if (!rec || rec.key === newKey || state.recordMap.has(newKey)) return rec;
    state.recordMap.delete(rec.key);
    if (state.activeKey === rec.key) state.activeKey = newKey;
    rec.key = newKey;
    state.recordMap.set(newKey, rec);
    return rec;
  }

  function scheduleScan(reason = 'auto', immediate = false) {
    checkConversationChanged();
    if (!state.scroller || !document.contains(state.scroller)) setScroller(detectConversationScroller());

    if (state.scanRunning) {
      state.scanAgain = true;
      return;
    }

    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      const run = () => runScan(reason);
      if ('requestIdleCallback' in window && !immediate && !state.loadAllRunning) {
        requestIdleCallback(run, { timeout: 600 });
      } else {
        requestAnimationFrame(run);
      }
    }, immediate ? 0 : CONFIG.scanDebounceMs);
  }

  async function runScan(reason = 'manual', options = {}) {
    if (state.scanRunning) {
      state.scanAgain = true;
      return { added: 0, updated: 0 };
    }

    state.scanRunning = true;
    try {
      return scanMountedPrompts(reason, options);
    } finally {
      state.scanRunning = false;
      if (state.scanAgain) {
        state.scanAgain = false;
        scheduleScan('followup');
      }
    }
  }

  function scanMountedPrompts(reason = 'scan', options = {}) {
    injectStyle();
    checkConversationChanged();
    if (!state.scroller || !document.contains(state.scroller)) setScroller(detectConversationScroller());

    document.querySelectorAll('.gpn-prompt-v2, .gpn-active-v2, .gpn-fallback-v2').forEach(el => {
      el.classList.remove('gpn-prompt-v2', 'gpn-active-v2', 'gpn-fallback-v2');
      delete el.dataset.gpnKey;
    });

    const now = Date.now();
    const matched = new Set();
    const seenTurns = new Set();
    let added = 0;
    let updated = 0;

    for (const rec of state.records) {
      rec.mounted = false;
      rec.node = null;
      rec.turn = null;
    }

    const nodes = getPromptNodes();
    for (const node of nodes) {
      const turn = closestTurn(node);
      if (!turn || seenTurns.has(turn) || turn.closest?.(`#${IDS.panel}, #${IDS.restore}`)) continue;

      const text = cleanText(node) || cleanText(turn);
      if (!text || text.length < 2) continue;

      seenTurns.add(turn);
      const textHash = hashText(text);
      const info = getTurnInfo(turn);
      const candidateKey = stableKeyFrom(info, textHash);
      const isWeak = candidateKey.startsWith('weak:');
      let key = isWeak ? `${candidateKey}:${state.nextSeq}` : candidateKey;
      let rec = state.recordMap.get(candidateKey) || state.recordMap.get(key);

      if (!rec) {
        const byText = findExistingByText(text, textHash, matched);
        if (byText && !isWeak) rec = upgradeRecordKey(byText, candidateKey);
        else if (byText) rec = byText;
      }

      if (!rec) {
        rec = {
          key,
          text,
          textHash,
          seq: state.nextSeq++,
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 0,
          mounted: false,
          node: null,
          turn: null,
          turnId: info.turnId || '',
          messageId: info.messageId || '',
          testId: info.testId || '',
          turnNumber: Number.isFinite(info.turnNumber) ? info.turnNumber : null,
          firstAbsTop: null,
          lastAbsTop: null,
          lastScrollTop: null,
          lastRatio: null,
          crawlSeen: false,
        };
        state.records.push(rec);
        state.recordMap.set(rec.key, rec);
        added++;
      } else {
        updated++;
      }

      const scrollTop = getScrollTop();
      const maxTop = getMaxScrollTop();
      const absTop = getRelativeTop(turn);

      rec.text = text;
      rec.textHash = textHash;
      rec.lastSeenAt = now;
      rec.seenCount++;
      rec.mounted = true;
      rec.node = node;
      rec.turn = turn;
      rec.turnId = info.turnId || rec.turnId || '';
      rec.messageId = info.messageId || rec.messageId || '';
      rec.testId = info.testId || rec.testId || '';
      rec.turnNumber = Number.isFinite(info.turnNumber) ? info.turnNumber : rec.turnNumber;
      rec.lastAbsTop = absTop;
      rec.firstAbsTop = Number.isFinite(rec.firstAbsTop) ? Math.min(rec.firstAbsTop, absTop) : absTop;
      rec.lastScrollTop = scrollTop;
      rec.lastRatio = maxTop > 0 ? clamp(scrollTop / maxTop, 0, 1) : 0;
      if (options.crawl) rec.crawlSeen = true;

      matched.add(rec.key);
      turn.classList.add('gpn-prompt-v2');
      turn.dataset.gpnKey = rec.key;
      if (!turn.querySelector('[data-message-author-role="user"]')) turn.classList.add('gpn-fallback-v2');
    }

    sortRecords();

    if (!state.activeKey || !state.recordMap.has(state.activeKey)) {
      state.activeKey = nearestMountedRecord()?.key || state.records[0]?.key || null;
    }

    applyActiveClass();

    if (!state.deferRender) {
      maybeRenderPanel();
    } else {
      renderActiveOnly();
    }

    return { added, updated, total: state.records.length, reason };
  }

  function sortRecords() {
    state.records.sort((a, b) => {
      const atn = Number.isFinite(a.turnNumber), btn = Number.isFinite(b.turnNumber);
      if (atn && btn && a.turnNumber !== b.turnNumber) return a.turnNumber - b.turnNumber;
      const ay = Number.isFinite(a.lastAbsTop) ? a.lastAbsTop : a.firstAbsTop;
      const by = Number.isFinite(b.lastAbsTop) ? b.lastAbsTop : b.firstAbsTop;
      if (Number.isFinite(ay) && Number.isFinite(by) && Math.abs(ay - by) > 2) return ay - by;
      return a.seq - b.seq;
    });
  }

  function renderSignature() {
    const filteredCount = getFilteredRecords().length;
    return [
      state.records.length,
      filteredCount,
      state.records.map(r => `${r.key}:${r.textHash}`).join('|'),
      state.expanded ? 1 : 0,
      state.hidden ? 1 : 0,
      state.loadAllRunning ? 1 : 0,
      state.query,
    ].join('::');
  }

  function maybeRenderPanel() {
    const sig = renderSignature();
    if (sig === state.lastRenderSignature) {
      renderActiveOnly();
      return;
    }
    state.lastRenderSignature = sig;
    renderPanel();
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => {
      state.lastRenderSignature = '';
      renderPanel();
    }, 50);
  }

  function getRecordIndex(key) {
    return state.records.findIndex(r => r.key === key);
  }

  function getActiveIndex() {
    return getRecordIndex(state.activeKey);
  }

  function getFilteredRecords() {
    const query = state.query.trim().toLowerCase();
    return state.records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => !query || record.text.toLowerCase().includes(query));
  }

  function nearestMountedRecord() {
    const mounted = state.records.filter(r => r.mounted && r.turn?.isConnected);
    if (!mounted.length) return null;
    const target = getClientHeight() * 0.35;
    let best = mounted[0];
    let bestDistance = Infinity;
    for (const rec of mounted) {
      const rel = getRelativeTop(rec.turn) - getScrollTop();
      const d = Math.abs(rel - target);
      if (d < bestDistance) {
        best = rec;
        bestDistance = d;
      }
    }
    return best;
  }

  function applyActiveClass() {
    document.querySelectorAll('.gpn-active-v2').forEach(el => el.classList.remove('gpn-active-v2'));
    const rec = state.recordMap.get(state.activeKey);
    if (rec?.mounted && rec.turn?.isConnected) rec.turn.classList.add('gpn-active-v2');
  }

  function renderPanel() {
    const panel = getPanel();
    const activeIndex = getActiveIndex();
    const activeText = activeIndex >= 0 ? `${activeIndex + 1}/${state.records.length}` : `0/${state.records.length}`;
    const activePrompt = state.recordMap.get(state.activeKey)?.text || 'No prompt selected yet.';
    const filtered = getFilteredRecords();
    const tooMany = filtered.length > CONFIG.maxRenderedRows;
    const rows = tooMany ? filtered.slice(0, CONFIG.maxRenderedRows) : filtered;
    const loadAction = state.loadAllRunning ? 'stop-load-all' : 'load-all';
    const safeLoadAction = state.loadAllRunning ? 'stop-load-all' : 'safe-load';
    const loadText = state.loadAllRunning ? 'Stop' : 'Load all';

    panel.classList.toggle('gpn-expanded-v2', state.expanded);
    panel.classList.toggle('gpn-collapsed-v2', !state.expanded);
    panel.classList.toggle('gpn-hidden-v2', state.hidden);
    panel.classList.toggle('gpn-menu-open-v2', state.menuOpen);
    panel.classList.toggle('gpn-loading-v2', state.loadAllRunning);

    panel.replaceChildren(
      createHeader(activeText, loadAction, safeLoadAction, loadText),
      createCompact(activePrompt),
      createBody(rows, tooMany, loadAction, loadText),
      ...createResizeHandles(),
    );

    getRestoreTab().classList.toggle('gpn-visible-v2', state.hidden);
    applyPanelGeometry(panel);
    renderActiveOnly();
  }

  function createHeader(activeText, loadAction, safeLoadAction, loadText) {
    const menuWrap = el('span', { className: 'gpn-menu-wrap' }, [
      button('menu', '⋯', {
        'aria-haspopup': 'true',
        'aria-expanded': state.menuOpen ? 'true' : 'false',
        title: 'More actions',
      }),
      el('span', { className: 'gpn-menu', role: 'menu' }, [
        button(loadAction, state.loadAllRunning ? 'Stop load all' : 'Load all prompts'),
        button(safeLoadAction, state.loadAllRunning ? 'Stop load all' : 'Safe load (slower)'),
        button('refresh', 'Refresh visible prompts'),
        button('copy', 'Copy current prompt'),
        button('clear-cache', 'Clear prompt cache'),
        button('reset', 'Reset window'),
        button('hide', 'Hide navigator'),
      ]),
    ]);

    return el('div', { className: 'gpn-header' }, [
      el('span', { className: 'gpn-drag', title: 'Drag to move' }, ['⋮⋮']),
      el('span', { className: 'gpn-title' }, ['Prompts']),
      button('prev', '↑', { title: 'Previous prompt: Alt+↑' }),
      button('next', '↓', { title: 'Next prompt: Alt+↓' }),
      el('span', { className: 'gpn-count' }, [activeText]),
      el('span', { className: 'gpn-spacer' }),
      button(loadAction, loadText, {
        className: 'gpn-tertiary gpn-load-label',
        title: 'Fast load all cached prompts',
      }),
      button('refresh', '↻', {
        className: 'gpn-tertiary',
        title: 'Scan currently loaded prompts only',
      }),
      menuWrap,
      button('toggle', state.expanded ? 'Collapse' : 'Expand', { title: 'Expand or collapse' }),
      button('hide', '×', { title: 'Hide. Press Alt+P to show again.' }),
    ]);
  }

  function createCompact(activePrompt) {
    return el('div', { className: 'gpn-compact' }, [
      el('div', { className: 'gpn-compact-label' }, ['Current prompt']),
      el('div', { className: 'gpn-compact-text' }, [activePrompt]),
    ]);
  }

  function createBody(rows, tooMany, loadAction, loadText) {
    const search = el('input', {
      className: 'gpn-search',
      'data-gpn-search': '',
      type: 'search',
      placeholder: 'Search cached prompts…',
      value: state.query,
    });
    const list = el('div', { className: 'gpn-list' });

    if (rows.length) {
      rows.forEach(({ record, index }) => list.append(createRow(record, index)));
      if (tooMany) {
        list.append(el('div', { className: 'gpn-empty' }, [
          `Showing first ${CONFIG.maxRenderedRows} matches. Use search to narrow the list.`,
        ]));
      }
    } else {
      list.append(el('div', { className: 'gpn-empty' }, ['No cached prompts yet. Scroll manually or click Load all.']));
    }

    return el('div', { className: 'gpn-body' }, [
      el('div', { className: 'gpn-search-row' }, [search]),
      list,
      el('div', { className: 'gpn-footer' }, [
        el('span', { className: 'gpn-notice' }, ['Load all uses fast mode. Use Safe load only if prompts are missing.']),
        el('span', { className: 'gpn-footer-actions' }, [button(loadAction, loadText)]),
      ]),
    ]);
  }

  function createRow(record, index) {
    return button(null, '', {
      className: `gpn-row ${record.key === state.activeKey ? 'gpn-selected' : ''}`,
      'data-gpn-key': record.key,
      title: `Jump to prompt ${index + 1}`,
    }, [
      el('span', { className: 'gpn-num' }, [`#${index + 1}`]),
      el('span', { className: 'gpn-text' }, [record.text]),
      el('span', { className: 'gpn-status' }, [record.mounted ? 'loaded' : 'cached']),
    ]);
  }

  function createResizeHandles() {
    return ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
      .map(dir => el('span', {
        className: `gpn-resize gpn-r-${dir}`,
        'data-gpn-resize': dir,
        'aria-hidden': 'true',
      }));
  }

  function button(action, text, attrs = {}, children = [text]) {
    const buttonAttrs = { type: 'button', ...attrs };
    if (action) buttonAttrs['data-gpn-action'] = action;
    return el('button', buttonAttrs, children);
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([name, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (name === 'className') {
        node.className = value;
      } else if (name === 'value') {
        node.value = value;
      } else {
        node.setAttribute(name, String(value));
      }
    });
    children.forEach(child => {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function renderActiveOnly() {
    const panel = document.getElementById(IDS.panel);
    if (!panel) return;
    const activeIndex = getActiveIndex();
    const count = panel.querySelector('.gpn-count');
    if (count) count.textContent = activeIndex >= 0 ? `${activeIndex + 1}/${state.records.length}` : `0/${state.records.length}`;
    const compact = panel.querySelector('.gpn-compact-text');
    if (compact) compact.textContent = state.recordMap.get(state.activeKey)?.text || 'No prompt selected yet.';
    panel.querySelectorAll('.gpn-row').forEach(row => {
      const rec = state.recordMap.get(row.dataset.gpnKey);
      row.classList.toggle('gpn-selected', row.dataset.gpnKey === state.activeKey);
      const status = row.querySelector('.gpn-status');
      if (status && rec) status.textContent = rec.mounted ? 'loaded' : 'cached';
    });
  }

  function setNoticeText(message) {
    const notice = document.querySelector(`#${IDS.panel} .gpn-notice`);
    if (notice) notice.textContent = message;
  }

  function showNotice(message, ms = 2800) {
    setNoticeText(message);
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => {
      setNoticeText('Load all uses fast mode. Use Safe load only if prompts are missing.');
    }, ms);
  }

  function showProgress(message) {
    const now = Date.now();
    if (now - state.progressLastAt < 180) return;
    state.progressLastAt = now;
    setNoticeText(message);
    renderActiveOnly();
  }

  function closeMenu() {
    state.menuOpen = false;
    const panel = document.getElementById(IDS.panel);
    panel?.classList.remove('gpn-menu-open-v2');
    panel?.querySelector('[data-gpn-action="menu"]')?.setAttribute('aria-expanded', 'false');
  }

  function onPanelClick(event) {
    event.stopPropagation();

    const row = event.target.closest('[data-gpn-key]');
    if (row) {
      event.preventDefault();
      closeMenu();
      goToKey(row.dataset.gpnKey);
      return;
    }

    const btn = event.target.closest('[data-gpn-action]');
    if (!btn) return;
    event.preventDefault();

    const action = btn.dataset.gpnAction;
    if (action === 'menu') {
      state.menuOpen = !state.menuOpen;
      const panel = getPanel();
      panel.classList.toggle('gpn-menu-open-v2', state.menuOpen);
      btn.setAttribute('aria-expanded', state.menuOpen ? 'true' : 'false');
      return;
    }

    closeMenu();

    if (action === 'prev') jump(-1);
    if (action === 'next') jump(1);
    if (action === 'copy') copyCurrentPrompt();
    if (action === 'refresh') refreshVisible();
    if (action === 'load-all') loadAllPrompts('turbo');
    if (action === 'safe-load') loadAllPrompts('safe');
    if (action === 'stop-load-all') stopLoadAll();
    if (action === 'clear-cache') clearPromptCache();
    if (action === 'reset') resetPanel();
    if (action === 'hide') setHidden(true);
    if (action === 'toggle') toggleExpanded();
  }

  function onPanelInput(event) {
    if (!event.target.matches('[data-gpn-search]')) return;
    state.query = event.target.value;
    localStorage.setItem(STORE.query, state.query);
    state.lastRenderSignature = '';
    renderPanel();
    const input = document.querySelector(`#${IDS.panel} [data-gpn-search]`);
    if (input) {
      input.focus();
      input.setSelectionRange(state.query.length, state.query.length);
    }
  }

  function onPanelKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (state.menuOpen) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.target.matches('[data-gpn-search]')) {
      event.preventDefault();
      state.query = '';
      localStorage.setItem(STORE.query, '');
      state.lastRenderSignature = '';
      renderPanel();
    }
  }

  function onPanelPointerDown(event) {
    if (event.button !== 0) return;
    const resize = event.target.closest('[data-gpn-resize]');
    if (resize) {
      startResize(event, resize.dataset.gpnResize);
      return;
    }
    const drag = event.target.closest('.gpn-drag');
    if (drag) startDrag(event);
  }

  function startDrag(event) {
    event.preventDefault();
    closeMenu();
    const panel = getPanel();
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.classList.add('gpn-dragging-v2');
    state.dragging = true;
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    const move = e => {
      if (!state.dragging) return;
      const left = clamp(e.clientX - offsetX, CONFIG.margin, Math.max(CONFIG.margin, window.innerWidth - panel.offsetWidth - CONFIG.margin));
      const top = clamp(e.clientY - offsetY, CONFIG.margin, Math.max(CONFIG.margin, window.innerHeight - panel.offsetHeight - CONFIG.margin));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const up = () => {
      state.dragging = false;
      panel.classList.remove('gpn-dragging-v2');
      savePanelPosition(panel);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function startResize(event, dir) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    const panel = getPanel();
    const rect = panel.getBoundingClientRect();
    const activeMode = mode();
    const min = minSize();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.classList.add('gpn-resizing-v2');
    state.resizing = true;

    const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };

    const move = e => {
      if (!state.resizing) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      let left = start.left, top = start.top, width = start.width, height = start.height;
      if (dir.includes('e')) width = clamp(start.width + dx, min.width, window.innerWidth - start.left - CONFIG.margin);
      if (dir.includes('s')) height = clamp(start.height + dy, min.height, window.innerHeight - start.top - CONFIG.margin);
      if (dir.includes('w')) { width = clamp(start.width - dx, min.width, start.right - CONFIG.margin); left = start.right - width; }
      if (dir.includes('n')) { height = clamp(start.height - dy, min.height, start.bottom - CONFIG.margin); top = start.bottom - height; }
      state.sizes[activeMode] = { width, height };
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
      updateResponsiveClasses(panel);
    };

    const up = () => {
      state.resizing = false;
      panel.classList.remove('gpn-resizing-v2');
      savePanelPosition(panel);
      writeJson(STORE.sizes, state.sizes);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function savePanelPosition(panel = getPanel()) {
    const rect = panel.getBoundingClientRect();
    writeJson(STORE.position, { left: rect.left, top: rect.top });
  }

  function keepPanelOnScreen(panel = getPanel()) {
    requestAnimationFrame(() => {
      if (state.hidden) return;
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      let left = rect.left, top = rect.top, changed = false;
      if (rect.right > window.innerWidth - CONFIG.margin) { left = Math.max(CONFIG.margin, window.innerWidth - rect.width - CONFIG.margin); changed = true; }
      if (rect.bottom > window.innerHeight - CONFIG.margin) { top = Math.max(CONFIG.margin, window.innerHeight - rect.height - CONFIG.margin); changed = true; }
      if (rect.left < CONFIG.margin) { left = CONFIG.margin; changed = true; }
      if (rect.top < CONFIG.margin) { top = CONFIG.margin; changed = true; }
      if (changed) {
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        savePanelPosition(panel);
      }
    });
  }

  function setActiveKey(key, options = {}) {
    if (!state.recordMap.has(key)) return;
    state.activeKey = key;
    applyActiveClass();
    renderActiveOnly();
    if (options.scrollList) scrollActiveRowIntoView();
  }

  function scrollActiveRowIntoView() {
    const row = document.querySelector(`#${IDS.panel} [data-gpn-key="${cssEscape(state.activeKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  function goToIndex(index, options = {}) {
    if (!state.records.length) {
      refreshVisible();
      return;
    }
    const safeIndex = clamp(index, 0, state.records.length - 1);
    const current = getActiveIndex();
    const direction = Number.isFinite(options.direction)
      ? options.direction
      : Math.sign(safeIndex - (current >= 0 ? current : safeIndex));
    goToKey(state.records[safeIndex].key, { direction });
  }

  async function goToKey(key, options = {}) {
    const rec = state.recordMap.get(key);
    if (!rec) return;

    const currentIndex = getActiveIndex();
    const targetIndex = getRecordIndex(key);
    const direction = Number.isFinite(options.direction)
      ? options.direction
      : Math.sign(targetIndex - (currentIndex >= 0 ? currentIndex : targetIndex));

    setActiveKey(key, { scrollList: true });

    let fresh = state.recordMap.get(key);
    if (!fresh?.mounted || !fresh.turn?.isConnected) {
      showNotice('Mounting cached prompt…');
      const mounted = await mountRecord(fresh || rec, direction || 0);
      if (!mounted) {
        showNotice('Could not mount it. Run Load all or Safe load, then try again.', 4600);
        return;
      }
    }

    const resolvedKey = state.recordMap.has(key) ? key : state.activeKey;
    const aligned = await alignRecordAtTop(resolvedKey, direction || 0);
    if (aligned) {
      setActiveKey(resolvedKey, { scrollList: true });
      showNotice('Jumped to prompt.');
    } else {
      showNotice('Prompt mounted, but alignment is still settling. Click once more or use Safe load.', 5000);
    }
  }

  async function mountRecord(rec, direction = 0) {
    if (!rec) return false;

    let key = rec.key;
    const candidates = getMountCandidates(rec);
    for (const y of candidates) {
      if (state.loadAllAbort) return false;
      await scrollWaitScan(y, 'mount-candidate', {
        crawl: false,
        waitTimeoutMs: CONFIG.jump.waitTimeoutMs,
        quietMs: CONFIG.jump.quietMs,
      });
      if (rec.key !== key) key = rec.key;
      let fresh = state.recordMap.get(key) || rec;
      if (fresh?.mounted && fresh.turn?.isConnected) return true;

      if (direction) {
        const foundByNudge = await nudgeToMount(key, direction, CONFIG.jump.maxMountNudges);
        if (rec.key !== key) key = rec.key;
        fresh = state.recordMap.get(key) || rec;
        if (foundByNudge || (fresh?.mounted && fresh.turn?.isConnected)) return true;
      }
    }

    return findRecordBySweep(rec, direction);
  }

  function getMountCandidates(rec) {
    const max = getMaxScrollTop();
    const client = getClientHeight();
    const idx = getRecordIndex(rec.key);
    const values = [];

    if (Number.isFinite(rec.lastScrollTop)) values.push(rec.lastScrollTop);
    if (Number.isFinite(rec.lastAbsTop)) values.push(rec.lastAbsTop - CONFIG.jump.topOffsetPx);
    if (Number.isFinite(rec.firstAbsTop)) values.push(rec.firstAbsTop - CONFIG.jump.topOffsetPx);
    if (Number.isFinite(rec.lastRatio)) values.push(rec.lastRatio * max);
    if (idx >= 0 && state.records.length > 1) values.push((idx / (state.records.length - 1)) * max);

    const before = state.records[idx - 1];
    const after = state.records[idx + 1];
    if (Number.isFinite(before?.lastScrollTop)) values.push(before.lastScrollTop);
    if (Number.isFinite(after?.lastScrollTop)) values.push(after.lastScrollTop);

    const unique = [];
    const seen = new Set();
    for (const raw of values) {
      if (!Number.isFinite(raw)) continue;
      const y = clamp(Math.round(raw), 0, max);
      for (const offset of [0, -client * 0.30, client * 0.30, -client * 0.70, client * 0.70, -client * 1.15, client * 1.15]) {
        const candidate = clamp(Math.round(y + offset), 0, max);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          unique.push(candidate);
        }
      }
    }
    return unique;
  }

  async function nudgeToMount(key, direction, maxSteps) {
    const client = getClientHeight();
    const step = Math.max(180, Math.floor(client * 0.48));

    for (let i = 0; i < maxSteps && !state.loadAllAbort; i++) {
      const next = clamp(getScrollTop() + step * Math.sign(direction), 0, getMaxScrollTop());
      const before = getScrollTop();
      await scrollWaitScan(next, 'jump-nudge', {
        crawl: false,
        waitTimeoutMs: CONFIG.jump.waitTimeoutMs,
        quietMs: CONFIG.jump.quietMs,
      });
      const fresh = state.recordMap.get(key);
      if (fresh?.mounted && fresh.turn?.isConnected) return true;
      if (Math.abs(getScrollTop() - before) < 3) break;
    }
    return false;
  }

  async function findRecordBySweep(rec, direction = 0) {
    const original = getScrollTop();
    const client = getClientHeight();
    const step = Math.max(220, Math.floor(client * 0.62));
    const max = getMaxScrollTop();
    const idx = getRecordIndex(rec.key);
    const approximate = idx >= 0 && state.records.length > 1 ? (idx / (state.records.length - 1)) * max : original;

    const directions = direction < 0 ? [-1, 1] : direction > 0 ? [1, -1] : [1, -1];
    const starts = [approximate, rec.lastScrollTop, rec.lastRatio * max, original]
      .filter(Number.isFinite)
      .map(v => clamp(Math.round(v), 0, max));

    const tried = new Set();
    for (const start of starts) {
      for (const dir of directions) {
        let y = start;
        for (let i = 0; i < CONFIG.jump.maxFallbackSteps && !state.loadAllAbort; i++) {
          const key = `${dir}:${Math.round(y)}`;
          if (tried.has(key)) break;
          tried.add(key);

          showProgress(`Searching cached prompt: ${Math.round((y / Math.max(1, getMaxScrollTop())) * 100)}%`);
          await scrollWaitScan(y, 'mount-sweep', {
            crawl: false,
            waitTimeoutMs: CONFIG.jump.waitTimeoutMs,
            quietMs: CONFIG.jump.quietMs,
          });
          const fresh = state.recordMap.get(rec.key);
          if (fresh?.mounted && fresh.turn?.isConnected) return true;

          const next = clamp(y + dir * step, 0, getMaxScrollTop());
          if (Math.abs(next - y) < 3) break;
          y = next;
        }
      }
    }

    await scrollWaitScan(original, 'mount-restore', {
      crawl: false,
      waitTimeoutMs: CONFIG.jump.waitTimeoutMs,
      quietMs: CONFIG.jump.quietMs,
    });
    return false;
  }

  async function alignRecordAtTop(key, direction = 0) {
    for (let attempt = 1; attempt <= CONFIG.jump.maxAlignAttempts && !state.loadAllAbort; attempt++) {
      let rec = state.recordMap.get(key);
      if (!rec?.mounted || !rec.turn?.isConnected) {
        const mounted = await mountRecord(rec, direction);
        if (!mounted) return false;
        rec = state.recordMap.get(key);
        if (!rec?.mounted || !rec.turn?.isConnected) return false;
      }

      const desiredTop = clamp(getRelativeTop(rec.turn) - CONFIG.jump.topOffsetPx, 0, getMaxScrollTop());
      setScrollTop(state.scroller, desiredTop);
      await waitForScrollStability(CONFIG.jump.waitTimeoutMs, CONFIG.jump.quietMs);
      await runScan(`jump-align-${attempt}`, { crawl: false });

      rec = state.recordMap.get(key);
      if (!rec?.mounted || !rec.turn?.isConnected) continue;

      const relativeTop = getRelativeTop(rec.turn) - getScrollTop();
      if (Math.abs(relativeTop - CONFIG.jump.topOffsetPx) <= CONFIG.jump.tolerancePx) {
        applyActiveClass();
        return true;
      }

      // If ChatGPT's virtualizer landed on a render boundary, push one viewport
      // in the intended direction so the next batch mounts, then try exact alignment again.
      if (direction && attempt <= Math.ceil(CONFIG.jump.maxAlignAttempts / 2)) {
        const client = getClientHeight();
        const nudge = Math.sign(direction) * Math.max(160, Math.floor(client * 0.38));
        setScrollTop(state.scroller, getScrollTop() + nudge);
        await waitForScrollStability(CONFIG.jump.waitTimeoutMs, CONFIG.jump.quietMs);
        await runScan(`jump-align-nudge-${attempt}`, { crawl: false });
      }
    }
    return false;
  }

  function jump(delta) {
    if (!state.records.length) {
      refreshVisible();
      return;
    }
    const idx = getActiveIndex();
    goToIndex((idx >= 0 ? idx : 0) + delta, { direction: Math.sign(delta) });
  }

  function refreshVisible() {
    redetectScroller({ silent: true });
    runScan('manual-refresh', { crawl: false }).then(result => {
      showNotice(`Visible refresh: +${result.added}, cached ${state.records.length}.`);
    });
  }

  function stopLoadAll() {
    if (!state.loadAllRunning) return;
    state.loadAllAbort = true;
    showNotice('Stopping Load all after the current scroll step…', 5000);
  }

  async function loadAllPrompts(profile = 'turbo') {
    if (state.loadAllRunning) {
      stopLoadAll();
      return;
    }

    state.loadAllRunning = true;
    state.loadAllAbort = false;
    state.deferRender = true;
    state.menuOpen = false;
    state.progressLastAt = 0;
    state.lastRenderSignature = '';
    state.activeLoadConfig = profile === 'safe' ? CONFIG.safeLoad : CONFIG.loadAll;

    redetectScroller({ silent: true });
    const originalTop = getScrollTop();
    const originalKey = state.activeKey;
    const label = profile === 'safe' ? 'Safe load' : 'Load all';

    renderPanel();
    showNotice(`${label} started. The page will scroll once from top to bottom.`, 6000);

    try {
      for (const rec of state.records) rec.crawlSeen = false;

      await runScan('load-start', { crawl: true });
      await crawlToBoundary('top');
      await sweep('down');
      await crawlToBoundary('bottom');
      await runScan('load-end', { crawl: true });

      const aborted = state.loadAllAbort;
      state.deferRender = false;
      state.loadAllRunning = false;
      state.loadAllAbort = false;
      state.activeLoadConfig = null;
      state.lastRenderSignature = '';
      renderPanel();

      if (originalKey && state.recordMap.has(originalKey)) {
        await goToKey(originalKey);
      } else {
        await scrollWaitScan(originalTop, 'restore-original', {
          crawl: false,
          waitTimeoutMs: CONFIG.jump.waitTimeoutMs,
          quietMs: CONFIG.jump.quietMs,
        });
      }

      showNotice(aborted
        ? `${label} stopped. Cached ${state.records.length} prompts so far.`
        : `${label} complete. Cached ${state.records.length} prompts.`, 6000);
    } catch (err) {
      console.error('[GPN] Load all failed:', err);
      state.deferRender = false;
      state.loadAllRunning = false;
      state.loadAllAbort = false;
      state.activeLoadConfig = null;
      state.lastRenderSignature = '';
      renderPanel();
      showNotice(`${label} failed. Check the browser console for details.`, 6000);
    }
  }

  async function crawlToBoundary(boundary) {
    const cfg = activeLoadConfig();
    let stable = 0;
    let lastHeight = -1;
    let lastTop = -1;
    let lastCount = -1;
    const maxPasses = boundary === 'top' ? cfg.maxTopPasses : cfg.maxBottomPasses;

    for (let pass = 1; pass <= maxPasses && !state.loadAllAbort; pass++) {
      const target = boundary === 'top' ? 0 : getMaxScrollTop();
      showProgress(`Loading ${boundary === 'top' ? 'older/top' : 'newer/bottom'}: pass ${pass}, cached ${state.records.length}`);
      await scrollWaitScan(target, `load-${boundary}`, { crawl: true });
      await sleep(120);
      await runScan(`load-${boundary}-settle`, { crawl: true });

      const top = Math.round(getScrollTop());
      const height = Math.round(getScrollHeight());
      const count = state.records.length;
      const atBoundary = boundary === 'top' ? top <= 5 : top >= getMaxScrollTop() - 5;
      const unchanged = Math.abs(height - lastHeight) <= 3 && Math.abs(top - lastTop) <= 3 && count === lastCount;

      if (atBoundary && unchanged) stable++;
      else stable = 0;

      lastHeight = height;
      lastTop = top;
      lastCount = count;

      if (stable >= (boundary === 'top' ? cfg.topStablePasses : cfg.bottomStablePasses)) break;
    }
  }

  async function sweep(direction) {
    const cfg = activeLoadConfig();
    const client = getClientHeight();
    const step = Math.max(cfg.minStepPx, Math.floor(client * cfg.stepRatio));
    let noMove = 0;
    let previousTop = -1;

    for (let i = 0; i < cfg.maxSweepSteps && !state.loadAllAbort; i++) {
      await runScan(`sweep-${direction}`, { crawl: true });
      const top = getScrollTop();
      const max = getMaxScrollTop();
      const percent = max > 0 ? Math.round((top / max) * 100) : 100;
      showProgress(`Sweeping ${direction}: ${percent}% scanned, cached ${state.records.length}`);

      if (direction === 'down' && top >= max - 6) break;
      if (direction === 'up' && top <= 6) break;

      const next = direction === 'down'
        ? Math.min(max, top + step)
        : Math.max(0, top - step);

      if (Math.abs(next - previousTop) < 3) noMove++;
      else noMove = 0;
      if (noMove >= 4) break;
      previousTop = next;

      await scrollWaitScan(next, `sweep-${direction}-step`, { crawl: true });
    }
  }

  async function scrollWaitScan(top, reason, scanOptions = {}) {
    setScrollTop(state.scroller, top);
    const cfg = activeLoadConfig();
    const waitTimeoutMs = Number.isFinite(scanOptions.waitTimeoutMs) ? scanOptions.waitTimeoutMs : cfg.waitTimeoutMs;
    const quietMs = Number.isFinite(scanOptions.quietMs) ? scanOptions.quietMs : cfg.quietMs;
    await waitForScrollStability(waitTimeoutMs, quietMs);
    return runScan(reason, scanOptions);
  }

  async function waitForScrollStability(timeoutMs = 2000, quietMs = 250) {
    const start = performance.now();
    let lastTop = Math.round(getScrollTop());
    let lastHeight = Math.round(getScrollHeight());
    let stableSince = performance.now();

    while (performance.now() - start < timeoutMs) {
      await sleep(80);
      const top = Math.round(getScrollTop());
      const height = Math.round(getScrollHeight());
      if (Math.abs(top - lastTop) <= 2 && Math.abs(height - lastHeight) <= 2) {
        if (performance.now() - stableSince >= quietMs) break;
      } else {
        lastTop = top;
        lastHeight = height;
        stableSince = performance.now();
      }
    }
    await waitFrames(2);
  }

  function waitFrames(count = 1) {
    return new Promise(resolve => {
      const next = n => n <= 0 ? resolve() : requestAnimationFrame(() => next(n - 1));
      next(count);
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function copyCurrentPrompt() {
    const text = state.recordMap.get(state.activeKey)?.text;
    if (!text) {
      showNotice('No prompt selected.');
      return;
    }
    const ok = await copyText(text);
    showNotice(ok ? 'Current prompt copied.' : 'Copy failed.');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function showDiagnostics() {
    const mounted = state.records.filter(r => r.mounted).length;
    const max = Math.round(getMaxScrollTop());
    const top = Math.round(getScrollTop());
    showNotice(`Scroller: ${state.scrollerLabel}; top ${top}/${max}; prompts ${state.records.length}; mounted ${mounted}.`, 8000);
  }

  function toggleExpanded() {
    state.expanded = !state.expanded;
    localStorage.setItem(STORE.expanded, state.expanded ? '1' : '0');
    state.lastRenderSignature = '';
    renderPanel();
    scrollActiveRowIntoView();
  }

  function resetPanel() {
    localStorage.removeItem(STORE.position);
    localStorage.removeItem(STORE.sizes);
    state.sizes = mergeSizes(null, CONFIG.defaultSizes);
    state.menuOpen = false;
    const panel = getPanel();
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '18px';
    panel.style.bottom = '18px';
    state.lastRenderSignature = '';
    renderPanel();
    showNotice('Window reset.');
  }

  function clearPromptCache(options = {}) {
    if (state.loadAllRunning) return;
    state.records = [];
    state.recordMap = new Map();
    state.activeKey = null;
    state.nextSeq = 1;
    state.lastRenderSignature = '';
    document.querySelectorAll('.gpn-prompt-v2, .gpn-active-v2, .gpn-fallback-v2').forEach(el => {
      el.classList.remove('gpn-prompt-v2', 'gpn-active-v2', 'gpn-fallback-v2');
    });
    if (!options.keepNotice) showNotice('Cache cleared. Refresh visible or Load all to rebuild.');
    scheduleRender();
    scheduleScan('clear-cache', true);
  }

  function setHidden(hidden) {
    state.hidden = hidden;
    state.menuOpen = false;
    localStorage.setItem(STORE.hidden, hidden ? '1' : '0');
    getPanel().classList.toggle('gpn-hidden-v2', hidden);
    getRestoreTab().classList.toggle('gpn-visible-v2', hidden);
    if (!hidden) {
      state.lastRenderSignature = '';
      renderPanel();
      showNotice('Navigator shown.');
    }
  }

  function onAnyScroll() {
    if (state.resizing || state.dragging) return;
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => {
      if (!state.loadAllRunning) {
        const nearest = nearestMountedRecord();
        if (nearest && nearest.key !== state.activeKey) setActiveKey(nearest.key, { scrollList: false });
      }
      scheduleScan('scroll');
    }, 110);
  }

  document.addEventListener('keydown', event => {
    if (event.altKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      setHidden(!state.hidden);
      return;
    }

    if (!event.altKey || isTypingTarget(document.activeElement)) return;
    if (event.key === 'ArrowUp') { event.preventDefault(); jump(-1); }
    if (event.key === 'ArrowDown') { event.preventDefault(); jump(1); }
  }, true);

  document.addEventListener('click', event => {
    if (!event.target.closest?.(`#${IDS.panel}`)) closeMenu();
  }, true);

  window.addEventListener('resize', () => {
    applyPanelGeometry();
    keepPanelOnScreen();
    scheduleScan('resize');
  }, { passive: true });

  window.addEventListener('popstate', () => {
    checkConversationChanged();
    redetectScroller({ silent: true });
    scheduleScan('popstate', true);
  });

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    setTimeout(() => { checkConversationChanged(); redetectScroller({ silent: true }); scheduleScan('pushstate', true); }, 0);
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    setTimeout(() => { checkConversationChanged(); redetectScroller({ silent: true }); scheduleScan('replacestate', true); }, 0);
    return result;
  };

  const observer = new MutationObserver(mutations => {
    const onlyOwnUi = mutations.length > 0 && mutations.every(m => {
      const t = m.target;
      return t?.closest?.(`#${IDS.panel}, #${IDS.restore}`) || t?.id === IDS.panel || t?.id === IDS.restore || t?.id === IDS.style;
    });
    if (!onlyOwnUi) scheduleScan('mutation');
  });

  function init() {
    injectStyle();
    getPanel();
    getRestoreTab();
    setScroller(detectConversationScroller());
    applyPanelGeometry();
    renderPanel();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleScan('initial', true);
  }

  init();
})();
