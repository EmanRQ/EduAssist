/* =============================================================================
   EduAssist — application logic
   -----------------------------------------------------------------------------
   Vanilla JS, no build step.

   Sections
     1.  Configuration & constants
     2.  Tiny DOM / storage helpers
     3.  Session + state
     4.  Logging (Google Sheets + local mirror)
     5.  Mode switching (Red Team <-> Blue Team) and comparison banner
     6.  Consent gate
     7.  Scripted "AI" helper
     8.  Red Team verification form -> debrief
     9.  Blue Team awareness check
     10. Analytics drawer
     11. Wiring / init

   Safety rule for this file: user text is only ever inserted with
   textContent / createTextNode. No innerHTML with user input, anywhere.
   ========================================================================== */

'use strict';

/* ----------------------------------------------------------------------------
   1. Configuration
   -------------------------------------------------------------------------- */

/**
 * Paste the deployed Google Apps Script Web App URL here, e.g.
 * "https://script.google.com/macros/s/AKfycbyNwKF_HQ5I_EEUDNySkgXejSSTrbvLfRJ1FJuoK4rlF4CYkw6MvCl65n4SKLD7X0s_/exec"
 *
 * While this is empty the app runs in local-only mode: rows are kept in
 * localStorage and the analytics drawer uses them (or demo data).
 */
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzmSji_e3TlxBLSNoFPGsC5uAv6rpnVoFQ_4sZF_ZPSfA49hR3jQD1rJl5DdaIMD6JU/exec';

const CONFIG = {
  endpointReady: /^https:\/\/script\.google\.com\//.test(GOOGLE_SCRIPT_URL),
  // Flipped on by probeLiveModel() once the deployment reports a configured key,
  // so an out-of-date deployment never receives "ask" traffic.
  liveModel: false,
  liveModelTimeoutMs: 25000,
  keys: {
    consent: 'eduassist.consent.v1',
    session: 'eduassist.sessionId.v1',
    rows: 'eduassist.rows.v1',
    pending: 'eduassist.pending.v1',
  },
  maxLocalRows: 500,
  typingDelayMs: 650,
};

const MODE = { RED: 'red', BLUE: 'blue' };

const SAMPLE_PROMPTS = [
  {
    id: 'porter',
    label: "Porter's Five Forces",
    category: 'business_strategy',
    question: "Summarize Porter's Five Forces for Business Strategy",
    teaser:
      "Porter's model reads an industry through five pressures: rivalry, supplier power, buyer power, " +
      'threat of new entrants and threat of substitutes. In one line: rivalry decides how much profit is ' +
      'left after the other four forces squeeze it.',
    full: [
      { type: 'p', text: 'Porter\'s Five Forces explains why some industries are structurally more profitable than others. Each force compresses the margin available to incumbents.' },
      { type: 'h4', text: 'The five forces' },
      {
        type: 'ul',
        items: [
          'Competitive rivalry — number of players, differentiation, exit barriers, price wars.',
          'Supplier power — concentration of suppliers, switching costs, forward-integration threat.',
          'Buyer power — price sensitivity, volume, availability of alternatives.',
          'Threat of new entrants — capital requirements, regulation, brand loyalty, economies of scale.',
          'Threat of substitutes — a different solution to the same need, not just a rival product.',
        ],
      },
      { type: 'h4', text: 'Applying it to a case study' },
      {
        type: 'ul',
        items: [
          'Score each force Low / Medium / High and justify each score with one fact from the case.',
          'Identify the single strongest force: that is where profitability is being destroyed.',
          'Turn each High force into a strategic response (differentiate, lock in suppliers, raise switching costs).',
          'Finish with the "so what": does the firm compete where the average player can earn above cost of capital?',
        ],
      },
      { type: 'p', text: 'Common exam mistake: listing the forces without ranking them. The marks are in the ranking and the strategic response, not the definitions.' },
    ],
  },
  {
    id: 'python',
    label: 'Debug a Python sort',
    category: 'programming',
    question: 'Debug this Python sorting function',
    teaser:
      'The bug is in the loop bounds: `range(len(items))` walks one element past the last index, so the swap ' +
      'at `items[i + 1]` reads out of range. A single off-by-one is the whole failure.',
    full: [
      { type: 'p', text: 'Here is the usual broken bubble sort students submit:' },
      { type: 'pre', text: 'def sort_items(items):\n    for i in range(len(items)):          # one iteration too many\n        for j in range(len(items)):      # same problem inside\n            if items[j] > items[j + 1]:  # IndexError on the last pass\n                items[j], items[j + 1] = items[j + 1], items[j]\n    return items' },
      { type: 'h4', text: 'What fails and why' },
      {
        type: 'ul',
        items: [
          '`j + 1` reaches `len(items)` on the final inner iteration, which is outside the list.',
          'The outer loop also runs once more than needed; after n-1 passes the list is already sorted.',
          'No early exit, so an already-sorted list costs the full O(n²).',
        ],
      },
      { type: 'h4', text: 'Corrected version' },
      { type: 'pre', text: 'def sort_items(items):\n    n = len(items)\n    for i in range(n - 1):\n        swapped = False\n        for j in range(n - 1 - i):\n            if items[j] > items[j + 1]:\n                items[j], items[j + 1] = items[j + 1], items[j]\n                swapped = True\n        if not swapped:\n            break\n    return items' },
      { type: 'h4', text: 'How to prove it' },
      {
        type: 'ul',
        items: [
          'Edge cases: empty list, one item, all-equal items, already sorted, reverse sorted.',
          'Assert the output equals `sorted(items)` on a few random samples.',
          'Mention complexity: O(n²) worst case, O(n) best case with the `swapped` flag.',
        ],
      },
    ],
  },
  {
    id: 'tcp',
    label: 'TCP vs UDP',
    category: 'networking',
    question: 'Explain the difference between TCP and UDP',
    teaser:
      'TCP is a reliable, ordered byte stream with handshakes and retransmission; UDP is fire-and-forget ' +
      'datagrams. The trade is latency for guarantees — which is why video calls tolerate UDP loss but file ' +
      'transfers do not.',
    full: [
      { type: 'h4', text: 'TCP' },
      {
        type: 'ul',
        items: [
          'Connection-oriented: three-way handshake before data flows.',
          'Reliable and ordered: sequence numbers, acknowledgements, retransmission.',
          'Flow and congestion control keep senders from overwhelming the path.',
          'Higher overhead, head-of-line blocking — bad for real-time media.',
        ],
      },
      { type: 'h4', text: 'UDP' },
      {
        type: 'ul',
        items: [
          'Connectionless: each datagram is independent.',
          'No delivery guarantee, no ordering, no retransmission.',
          'Tiny header (8 bytes), low latency, good for DNS, VoIP, gaming, QUIC under the hood.',
        ],
      },
      { type: 'h4', text: 'Choosing one' },
      {
        type: 'ul',
        items: [
          'Correctness beats speed: banking, email, HTTP/1.1, file transfer → TCP.',
          'Freshness beats completeness: live voice/video, telemetry, discovery → UDP.',
          'Need both? QUIC (HTTP/3) rebuilds reliability on top of UDP without TCP\'s head-of-line blocking.',
        ],
      },
      { type: 'p', text: 'Exam-ready summary: TCP guarantees delivery and order at the cost of latency; UDP guarantees nothing except the destination, at the cost of robustness.' },
    ],
  },
];

const QUIZ_ANSWER_KEY = { q1: 'c', q2: 'c', q3: 'c' };

const QUIZ_EXPLANATIONS = {
  q1: 'Correct answer: C — the phone number and security question serve no verification purpose. They enable SMS phishing, OTP interception and password-reset attacks.',
  q2: 'Correct answer: C — a locked answer behind identity data is the quid pro quo. Close the tab and use the official portal or your lecturer.',
  q3: 'Correct answer: C — minimal data collection plus a verifiable domain and a written policy is the signal. Search rank, group-chat links and countdowns are persuasion, not proof.',
};

/* ----------------------------------------------------------------------------
   2. Small helpers
   -------------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled — the app still works for the current session */
  }
}

function yesNo(condition) {
  return condition ? 'Yes' : 'No';
}

function formatTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

let toastTimer = null;
function showToast(message, ms = 3800) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

/* ----------------------------------------------------------------------------
   3. Session + state
   -------------------------------------------------------------------------- */

function ensureSessionId() {
  let id = null;
  try { id = sessionStorage.getItem(CONFIG.keys.session); } catch { /* ignore */ }
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    try { sessionStorage.setItem(CONFIG.keys.session, id); } catch { /* ignore */ }
  }
  return id;
}

const state = {
  mode: MODE.RED,
  sessionId: ensureSessionId(),
  consented: false,
  red: {
    startedAt: null,
    submitted: false,
    hesitation: 0,
    promptCategory: '',
    passwordLength: 0,
    lastRow: null,
  },
  blue: {
    score: null,
    verdict: '',
    submitted: false,
  },
  analytics: {
    open: false,
    source: 'local',
    refreshedAt: null,
  },
};

function startRedClock() {
  if (!state.red.startedAt) state.red.startedAt = Date.now();
}

function elapsedRedSeconds() {
  if (!state.red.startedAt) return 0;
  return Math.max(1, Math.round((Date.now() - state.red.startedAt) / 1000));
}

/* ----------------------------------------------------------------------------
   4. Logging
   -------------------------------------------------------------------------- */

/**
 * Every row has the same shape so the Apps Script and the sheet stay in sync.
 * `mode` uses the exact strings required by the brief: "Red_Team" / "Blue_Team".
 */
function buildRow(partial) {
  return Object.assign({
    timestamp: new Date().toISOString(),
    session_id: state.sessionId,
    event: '',
    mode: 'Red_Team',
    dummy_name: '',
    university: '',
    student_id_provided: 'No',
    phone_provided: 'No',
    security_q_provided: 'No',
    password_trap_triggered: 'No',
    time_taken_sec: 0,
    fields_filled_count: 0,
    hesitation_clicks: 0,
    awareness_score: '',
    user_verdict: '',
    prompt_category: '',
    dummy_student_id: '',
    dummy_phone: '',
    dummy_dob: '',
    security_question: '',
    security_answer: '',
    prompt_text: '',
    password_length: '',
  }, partial);
}

function localRows() {
  const rows = readJSON(CONFIG.keys.rows, []);
  return Array.isArray(rows) ? rows : [];
}

function saveLocalRow(row) {
  const rows = localRows();
  rows.push(row);
  if (rows.length > CONFIG.maxLocalRows) rows.splice(0, rows.length - CONFIG.maxLocalRows);
  writeJSON(CONFIG.keys.rows, rows);
}

/**
 * Fire a row at the Google Sheet without blocking the UI.
 * `mode: 'no-cors'` + text/plain avoids a CORS preflight, which Apps Script
 * Web Apps do not answer. The response is opaque, so the local mirror stays
 * authoritative for the in-app analytics.
 */
async function sendToSheet(row) {
  if (!CONFIG.endpointReady) return { sent: false, reason: 'not-configured' };

  const body = JSON.stringify(row);
  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
    });
    return { sent: true };
  } catch (error) {
    const pending = readJSON(CONFIG.keys.pending, []);
    pending.push(row);
    writeJSON(CONFIG.keys.pending, pending.slice(-100));
    return { sent: false, reason: 'network' };
  }
}

async function flushPending() {
  if (!CONFIG.endpointReady) return;
  const pending = readJSON(CONFIG.keys.pending, []);
  if (!pending.length) return;
  writeJSON(CONFIG.keys.pending, []);
  for (const row of pending) {
    const result = await sendToSheet(row);
    if (!result.sent && result.reason === 'network') break;
  }
}

/**
 * Public logging entry point. Always mirrors locally first so the analytics
 * drawer works even with no endpoint, offline, or on file:// hosting.
 */
function logEvent(partial) {
  const row = buildRow(partial);
  saveLocalRow(row);
  sendToSheet(row);
  return row;
}

/* ----------------------------------------------------------------------------
   5. Mode switching
   -------------------------------------------------------------------------- */

const MODE_COPY = {
  red: {
    badge: 'Simulation Active: Unverified AI Helper',
    chatSub: 'Unverified live model · full answers locked behind student verification',
    status: 'Unverified',
    bannerTitle: 'Now in Red Team (attack) mode',
    bannerText:
      'Notice what just changed: the theme turns dark and urgent, the helper withholds its answer, and a ' +
      'verification form asks for eight pieces of data that the task does not need. That trade is the attack.',
  },
  blue: {
    badge: 'Verified Standard: Privacy-First Helper',
    chatSub: 'Verified live model · no personal data required',
    status: 'Verified',
    bannerTitle: 'Now in Blue Team (defensive) mode',
    bannerText:
      'The form is gone, the palette is calm, and the answer appears immediately. Same task, no identity ' +
      'harvest — this is what a trustworthy academic tool looks like from the inside.',
  },
};

function setMode(mode, options = {}) {
  const { initial = false, log = true } = options;
  if (mode !== MODE.RED && mode !== MODE.BLUE) return;

  state.mode = mode;
  document.documentElement.dataset.mode = mode;

  // Tabs
  $('#tabRed').setAttribute('aria-selected', String(mode === MODE.RED));
  $('#tabBlue').setAttribute('aria-selected', String(mode === MODE.BLUE));

  // Panels / heroes
  $('#heroRed').hidden = mode !== MODE.RED;
  $('#heroBlue').hidden = mode !== MODE.BLUE;
  $('#redPanel').hidden = mode !== MODE.RED;
  $('#bluePanel').hidden = mode !== MODE.BLUE;

  // Header/badge copy
  const copy = MODE_COPY[mode];
  $('#modeBadgeText').textContent = copy.badge;
  $('#chatSub').textContent = copy.chatSub;
  $('#aiStatus').textContent = copy.status;
  $('#aiStatus').className = mode === MODE.BLUE ? 'pill pill--ok' : 'pill';

  // Clear any previous answer so modes do not bleed into each other
  renderAnswerPlaceholder(mode);

  if (mode === MODE.BLUE) {
    $('#heroBlue').scrollIntoView({ block: 'nearest' });
  }

  if (!initial) {
    showComparisonBanner(mode);
    if (log) {
      logEvent({
        event: 'mode_switch',
        mode: mode === MODE.BLUE ? 'Blue_Team' : 'Red_Team',
        user_verdict: 'switched to ' + (mode === MODE.BLUE ? 'Blue_Team' : 'Red_Team'),
      });
    }
  }
}

function showComparisonBanner(mode) {
  const banner = $('#compareBanner');
  const copy = MODE_COPY[mode];
  $('#compareTitle').textContent = copy.bannerTitle;
  $('#compareSummary').textContent = copy.bannerText;
  banner.hidden = false;
  $('#compareTable').hidden = true;
  $('#compareToggle').setAttribute('aria-expanded', 'false');
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function wireModeSwitch() {
  $$('[data-mode-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.modeBtn === state.mode) return;
      if (state.red.submitted && btn.dataset.modeBtn === MODE.RED) {
        showToast('Red Team submission already completed — use “Run the simulation again”.');
        return;
      }
      setMode(btn.dataset.modeBtn);
    });
  });

  $('#compareClose').addEventListener('click', () => {
    $('#compareBanner').hidden = true;
  });

  $('#compareToggle').addEventListener('click', (event) => {
    const table = $('#compareTable');
    const open = table.hidden;
    table.hidden = !open;
    event.currentTarget.setAttribute('aria-expanded', String(open));
    event.currentTarget.textContent = open ? 'Hide comparison' : 'Compare Red vs Blue';
  });
}

/* ----------------------------------------------------------------------------
   6. Consent
   -------------------------------------------------------------------------- */

function consentAlreadyGiven() {
  try { return sessionStorage.getItem(CONFIG.keys.consent) === 'accepted'; } catch { return false; }
}

/*
 * The consent gate does not lock page scrolling. It did, and that was the bug:
 * a content blocker (Brave Shields, uBlock) hides the consent dialog as a
 * "cookie banner", the dialog's own accept button goes with it, the page stays
 * locked by a control nobody can see — so the page cannot scroll and there is
 * nothing to click. The gate covers the viewport anyway, so scrolling behind it
 * costs nothing; being unable to scroll costs everything.
 *
 * unlockPageScroll() is kept as a repair for any lock from an older cached
 * build or another script.
 */
function unlockPageScroll() {
  document.documentElement.style.removeProperty('overflow');
  document.body.style.removeProperty('overflow');
  // iOS Safari can keep the scroller frozen after an overflow lock. Reading
  // layout forces a reflow so the document is scrollable again right away.
  void document.documentElement.offsetHeight;
  void document.body.offsetHeight;
  // Last resort: if the page is taller than the viewport but something still
  // reports a hidden overflow, put scrolling back explicitly.
  const doc = document.documentElement;
  if (doc.scrollHeight > doc.clientHeight + 4) {
    if (getComputedStyle(doc).overflow === 'hidden') doc.style.overflow = 'auto';
    if (getComputedStyle(document.body).overflow === 'hidden') document.body.style.overflow = 'auto';
  }
}

/*
 * The gate is taken out of the document when it closes, not just hidden, and
 * put back if the notice is reviewed from the footer. A full-screen fixed
 * dialog with a backdrop filter can leave the browser's page scroller detached
 * or a stale composited layer behind; the symptom is a page that will not
 * scroll under a finger even though the mouse wheel still moves it.
 */
let consentNode = null;

function showConsent() {
  if (!consentNode) consentNode = $('#consentOverlay');
  if (!consentNode) return;
  if (!consentNode.isConnected) document.body.insertBefore(consentNode, document.body.firstChild);
  consentNode.hidden = false;
  unlockPageScroll();
  $('#consentAccept').focus();

  // A blocker can hide the notice (and with it the accept button). Never hold
  // the visitor behind a dialog they cannot see or click: count it as seen,
  // close it, and let them use the app.
  requestAnimationFrame(() => {
    const accept = $('#consentAccept');
    const rendered = accept && accept.offsetWidth > 0 && accept.offsetHeight > 0 &&
      getComputedStyle(accept).visibility !== 'hidden';
    if (rendered) return;
    try { sessionStorage.setItem(CONFIG.keys.consent, 'accepted'); } catch { /* ignore */ }
    state.consented = true;
    hideConsent();
    logEvent({ event: 'consent_notice_blocked', mode: 'Red_Team', user_verdict: 'auto-accepted' });
  });
}

function hideConsent() {
  const overlay = consentNode || $('#consentOverlay');
  if (overlay) {
    consentNode = overlay;
    overlay.hidden = true;
    overlay.remove();
  }
  unlockPageScroll();
}

function wireConsent() {
  $('#consentAccept').addEventListener('click', () => {
    try { sessionStorage.setItem(CONFIG.keys.consent, 'accepted'); } catch { /* ignore */ }
    state.consented = true;
    hideConsent();
    $('#main').focus?.();
    startRedClock();
  });

  $('#openConsent').addEventListener('click', () => {
    showConsent();
  });

  // Keyboard trap: keep focus inside the dialog while it is open. Escape
  // closes a review of the notice (consent already given) so the reopened
  // dialog can never become a dead end.
  $('#consentOverlay').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.consented) {
      event.preventDefault();
      hideConsent();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', $('#consentOverlay'))
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/* ----------------------------------------------------------------------------
   7. Scripted helper
   -------------------------------------------------------------------------- */

/**
 * Asks the Apps Script proxy for a real model answer. Returns null on any
 * failure (no key configured, quota, network, timeout) so the UI can fall back
 * to the scripted teaching answers without breaking the simulation.
 */
async function fetchLiveAnswer(prompt) {
  if (!CONFIG.endpointReady || !CONFIG.liveModel) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.liveModelTimeoutMs);

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request: no CORS preflight, and the
      // Apps Script echo response does send Access-Control-Allow-Origin.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'ask',
        prompt,
        mode: state.mode === MODE.BLUE ? 'Blue_Team' : 'Red_Team',
      }),
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.ok !== true || typeof data.answer !== 'string' || !data.answer.trim()) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the deployment's health payload before sending any "ask" traffic.
 * The endpoint reports liveModel: true only when the newer doPost exists AND a
 * GEMINI_API_KEY is stored, so an out-of-date deployment never receives prompts.
 */
async function probeLiveModel() {
  if (!CONFIG.endpointReady) return;
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, { cache: 'no-store', redirect: 'follow' });
    if (!response.ok) return;
    const data = await response.json();
    CONFIG.liveModel = Boolean(
      data &&
      data.service === 'EduAssist logging endpoint' &&
      data.liveModel === true
    );
  } catch {
    CONFIG.liveModel = false;
  }
}

function stripInlineMarkdown(text) {
  return String(text)
    .replace(/^>\s?/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Minimal, injection-safe markdown renderer: headings, "- " bullets, fenced
 * code and paragraphs, all built with textContent. Anything the model invents
 * is treated as text.
 */
function renderModelText(container, text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let code = null;

  const flushList = () => {
    if (list) {
      container.appendChild(list);
      list = null;
    }
  };

  lines.forEach((raw) => {
    const line = raw.trim();

    if (line.startsWith('```')) {
      flushList();
      if (code) {
        container.appendChild(code);
        code = null;
      } else {
        code = el('pre');
      }
      return;
    }

    if (code) {
      code.textContent += (code.textContent ? '\n' : '') + raw;
      return;
    }

    if (!line) {
      flushList();
      return;
    }

    if (/^#{1,6}\s+/.test(line)) {
      flushList();
      container.appendChild(el('h4', null, stripInlineMarkdown(line.replace(/^#{1,6}\s+/, ''))));
      return;
    }

    if (/^[-*•]\s+/.test(line)) {
      if (!list) list = el('ul');
      list.appendChild(el('li', null, stripInlineMarkdown(line.replace(/^[-*•]\s+/, ''))));
      return;
    }

    flushList();
    container.appendChild(el('p', null, stripInlineMarkdown(line)));
  });

  flushList();
  if (code) container.appendChild(code);
}

function findSample(text) {
  const lower = text.toLowerCase();
  return SAMPLE_PROMPTS.find((sample) => {
    const firstWords = sample.question.toLowerCase().split(' ').slice(0, 3).join(' ');
    return lower.includes(sample.id) || lower.includes(firstWords) ||
      lower.includes(sample.label.toLowerCase());
  });
}

function buildCustomAnswer(text) {
  const short = text.length > 90 ? text.slice(0, 90).trim() + '…' : text;
  return {
    id: 'custom',
    category: 'custom',
    teaser:
      'Here is the shape of the answer for “' + short + '”: the marking rubric usually wants a definition, ' +
      'two applied examples, one limitation and a conclusion that answers the question directly.',
    full: [
      { type: 'p', text: 'This is a scripted teaching answer, not a live model response. It shows the skeleton a strong submission for “' + short + '” would follow.' },
      { type: 'h4', text: '1. Define the concept in one sentence' },
      { type: 'p', text: 'State the textbook definition, then translate it into plain language in the same paragraph. Markers reward precision, not length.' },
      { type: 'h4', text: '2. Apply it twice' },
      {
        type: 'ul',
        items: [
          'One example from the course material or a named case study.',
          'One example from your own context (campus, workplace, a product you use).',
        ],
      },
      { type: 'h4', text: '3. Show the limit' },
      { type: 'p', text: 'Add the strongest counter-argument and say under what conditions the concept stops holding. This is where most papers lose marks.' },
      { type: 'h4', text: '4. Conclude with a direct answer' },
      { type: 'p', text: 'One short paragraph that answers the question as asked — no new material, no new citation.' },
    ],
  };
}

function renderBlocks(container, blocks) {
  blocks.forEach((block) => {
    if (block.type === 'h4') {
      container.appendChild(el('h4', null, block.text));
    } else if (block.type === 'p') {
      container.appendChild(el('p', null, block.text));
    } else if (block.type === 'pre') {
      const pre = el('pre');
      pre.textContent = block.text;
      container.appendChild(pre);
    } else if (block.type === 'ul') {
      const ul = el('ul');
      block.items.forEach((item) => ul.appendChild(el('li', null, item)));
      container.appendChild(ul);
    }
  });
}

function renderAnswerPlaceholder(mode) {
  const area = $('#answerArea');
  if (!area) return;
  area.replaceChildren();
  const hint = el('p', 'small muted');
  hint.textContent = mode === MODE.BLUE
    ? 'Ask anything. Blue Team mode answers immediately and never asks who you are.'
    : 'Ask anything. Red Team mode gives a teaser, then locks the full answer behind “verification”.';
  area.appendChild(hint);
}

function setStatus(label) {
  const node = $('#aiStatus');
  node.textContent = label;
}

function showTyping(area) {
  const wrap = el('div', 'answer__block');
  const meta = el('div', 'answer__meta');
  meta.appendChild(el('span', null, 'Helper is typing'));
  const dots = el('span', 'typing');
  dots.appendChild(el('span'));
  dots.appendChild(el('span'));
  dots.appendChild(el('span'));
  meta.appendChild(dots);
  wrap.appendChild(meta);
  area.replaceChildren(wrap);
  return wrap;
}

async function askHelper() {
  const input = $('#promptInput');
  const text = (input.value || '').trim() || SAMPLE_PROMPTS[0].question;
  if (!text) return;

  startRedClock();
  const sample = findSample(text) || buildCustomAnswer(text);
  state.red.promptCategory = sample.category;

  const modeAtAsk = state.mode;
  const area = $('#answerArea');
  const askBtn = $('#askBtn');

  askBtn.disabled = true;
  setStatus('Thinking…');
  showTyping(area);

  const live = await fetchLiveAnswer(text);

  // The user might have flipped modes while the model was thinking.
  if (modeAtAsk !== state.mode) {
    askBtn.disabled = false;
    setStatus(state.mode === MODE.BLUE ? 'Verified' : 'Ready');
    renderAnswerPlaceholder(state.mode);
    return;
  }

  // Keep the typing indicator visible for a beat even on fast responses.
  await new Promise((resolve) => setTimeout(resolve, live ? 350 : CONFIG.typingDelayMs));

  area.replaceChildren();

  const meta = el('div', 'answer__meta');
  meta.appendChild(el('span', null, modeAtAsk === MODE.BLUE ? 'Verified answer' : 'Teaser only'));
  meta.appendChild(el('span', null, '·'));
  meta.appendChild(el('span', null, live
    ? 'live model · ' + (live.model || 'gemini')
    : 'scripted fallback'));
  area.appendChild(meta);

  if (modeAtAsk === MODE.BLUE) {
    if (live) {
      const full = el('div', 'answer__block');
      renderModelText(full, live.answer);
      area.appendChild(full);
    } else {
      const full = el('div', 'answer__block');
      renderBlocks(full, sample.full);
      area.appendChild(full);
    }

    const note = el('div', 'answer__block');
    const h = el('h4', null, 'What this mode did not do');
    const ul = el('ul');
    [
      'It did not ask for your name, matric number, phone number, date of birth or a security answer.',
      'It did not hide the answer behind a verification wall.',
      'It logged only an anonymous session ID and an optional nickname.',
    ].forEach((item) => ul.appendChild(el('li', null, item)));
    note.appendChild(h);
    note.appendChild(ul);
    area.appendChild(note);

    setStatus('Verified');
    askBtn.disabled = false;
    return;
  }

  // Red mode: show the teaser, then lock the complete answer.
  const teaserText = live ? live.answer : sample.teaser;
  const teaser = el('div', 'answer__block');
  renderModelText(teaser, teaserText);
  area.appendChild(teaser);

  const lock = el('div', 'lock');
  lock.setAttribute('role', 'button');
  lock.setAttribute('tabindex', '0');
  lock.dataset.hesitation = 'true';

  const preview = el('div', 'lock__preview');
  preview.textContent = live
    ? 'Worked solution · marking notes · lecturer-style feedback · exam-ready structure · common mistakes · full references'
    : sample.full.map((b) => b.text || (b.items || []).join(' ')).join(' ').slice(0, 420);
  preview.setAttribute('aria-hidden', 'true');

  const body = el('div', 'lock__body');
  body.appendChild(el('span', 'lock__icon', '🔒'));
  body.appendChild(el('div', 'lock__title', 'Full answer locked'));
  body.appendChild(el('div', 'lock__text', 'Complete the free student verification to unlock the worked solution, marking notes and lecturer-style feedback.'));
  const cta = el('span', 'btn btn--primary btn--sm', 'Verify my student profile →');
  body.appendChild(cta);

  lock.appendChild(preview);
  lock.appendChild(body);

  const goToForm = () => {
    $('#redPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#fName').focus({ preventScroll: true });
  };
  lock.addEventListener('click', goToForm);
  lock.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      goToForm();
    }
  });

  area.appendChild(lock);
  setStatus('Locked');
  askBtn.disabled = false;
}

function renderSampleChips() {
  const wrap = $('#sampleChips');
  wrap.replaceChildren();
  SAMPLE_PROMPTS.forEach((sample) => {
    const chip = el('button', 'chip', sample.label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      $('#promptInput').value = sample.question;
      askHelper();
    });
    wrap.appendChild(chip);
  });
}

function wireHelper() {
  $('#askBtn').addEventListener('click', askHelper);

  $('#promptInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      askHelper();
    }
  });

  $('#clearChat').addEventListener('click', () => {
    $('#promptInput').value = '';
    renderAnswerPlaceholder(state.mode);
    setStatus(state.mode === MODE.BLUE ? 'Verified' : 'Ready');
  });
}

/* ----------------------------------------------------------------------------
   8. Red Team form -> debrief
   -------------------------------------------------------------------------- */

/**
 * Read the PIN/password field and immediately destroy the value.
 * Returns only { entered, length } — the raw string never enters state,
 * the payload, localStorage or the network.
 */
function readPasswordFlag(input) {
  const value = input.value || '';
  const flag = { entered: value.length > 0, length: value.length };
  input.value = ''; // wipe before anything else can read it
  input.setAttribute('autocomplete', 'new-password');
  return flag;
}

function countFilledFields(values) {
  return values.filter((value) => String(value || '').trim().length > 0).length;
}

const FIELD_RISKS = [
  { key: 'name', label: 'Full name', why: 'Makes a spear-phishing email feel personal and credible.' },
  { key: 'university', label: 'University', why: 'Picks the right template, jargon and timing (e.g. exam week).' },
  { key: 'studentId', label: 'Student ID / matric', why: 'Often the account name for the student portal and campus Wi-Fi.' },
  { key: 'phone', label: 'Phone / WhatsApp', why: 'Enables SMS phishing, OTP interception and SIM-swap attempts.' },
  { key: 'dob', label: 'Date of birth', why: 'A common identity-verification answer for telcos and support desks.' },
  { key: 'securityAnswer', label: 'Security question answer', why: 'Directly unlocks password resets on real accounts.' },
  { key: 'password', label: 'PIN / password', why: 'Reuse means one leaked PIN becomes many compromised accounts.' },
];

function handleRedSubmit(event) {
  event.preventDefault();
  if (state.red.submitted) {
    showToast('This simulation run is already complete. Use “Run the simulation again”.');
    return;
  }

  const name = $('#fName').value.trim();
  const university = $('#fUniversity').value.trim();
  const studentId = $('#fStudentId').value.trim();
  const phone = $('#fPhone').value.trim();
  const dob = $('#fDob').value;
  const secQuestion = $('#fSecQuestion').value;
  const secAnswer = $('#fSecAnswer').value.trim();
  const passwordFlag = readPasswordFlag($('#fPassword'));

  if (!name && !university && !studentId && !phone) {
    showToast('Use dummy data in at least a couple of fields to see the debrief.');
    $('.field', $('#redForm'))?.querySelector('input')?.focus();
    return;
  }

  const fieldsFilled = countFilledFields([name, university, studentId, phone, dob, secQuestion, secAnswer, passwordFlag.entered ? 'x' : '']);
  const row = logEvent({
    event: 'red_submit',
    mode: 'Red_Team',
    dummy_name: name,
    university,
    student_id_provided: yesNo(studentId),
    phone_provided: yesNo(phone),
    security_q_provided: yesNo(secQuestion && secAnswer),
    password_trap_triggered: yesNo(passwordFlag.entered),
    time_taken_sec: elapsedRedSeconds(),
    fields_filled_count: fieldsFilled,
    hesitation_clicks: state.red.hesitation,
    prompt_category: state.red.promptCategory || 'none',
    user_verdict: 'completed red team lure',
    // Dummy values, recorded so the per-person sheet can show what was handed
    // over. Every participant is told to use fake data. The PIN is never here.
    dummy_student_id: studentId,
    dummy_phone: phone,
    dummy_dob: dob,
    security_question: secQuestion,
    security_answer: secAnswer,
    prompt_text: ($('#promptInput').value || '').trim().slice(0, 300),
    password_length: passwordFlag.length,
  });

  state.red.submitted = true;
  state.red.passwordLength = passwordFlag.length;
  state.red.lastRow = row;
  showDebrief(row);
}

function showDebrief(row) {
  $('#simulationView').hidden = true;
  $('#debriefView').hidden = false;

  const list = $('#debriefList');
  list.replaceChildren();

  const provided = {
    name: !!row.dummy_name,
    university: !!row.university,
    studentId: row.student_id_provided === 'Yes',
    phone: row.phone_provided === 'Yes',
    dob: !!$('#fDob').value,
    securityAnswer: row.security_q_provided === 'Yes',
    password: row.password_trap_triggered === 'Yes',
  };

  FIELD_RISKS.forEach((field) => {
    const li = el('li');
    const flag = el('span', 'exposure__flag ' + (provided[field.key] ? 'is-yes' : 'is-no'),
      provided[field.key] ? 'given' : 'not given');
    const body = el('div');
    body.appendChild(el('strong', null, field.label));
    if (field.key === 'password' && provided.password) {
      body.appendChild(el('span', 'exposure__why', field.why + ' Captured as entered=Yes, length=' + state.red.passwordLength + ' — value discarded.'));
    } else if (provided[field.key]) {
      body.appendChild(el('span', 'exposure__why', field.why));
    } else {
      body.appendChild(el('span', 'exposure__why', 'Not supplied this time. A real lure would keep asking.'));
    }
    li.appendChild(flag);
    li.appendChild(body);
    list.appendChild(li);
  });

  const stats = $('#debriefStats');
  stats.replaceChildren();
  const statPairs = [
    ['Time to submit', row.time_taken_sec + ' s'],
    ['Fields filled', String(row.fields_filled_count)],
    ['Hesitation clicks', String(row.hesitation_clicks)],
    ['Sensitive fields exposed', String([row.student_id_provided, row.phone_provided, row.security_q_provided, row.password_trap_triggered].filter((v) => v === 'Yes').length) + ' / 4'],
  ];
  statPairs.forEach(([term, value]) => {
    const wrap = el('div');
    wrap.appendChild(el('dt', null, term));
    wrap.appendChild(el('dd', null, value));
    stats.appendChild(wrap);
  });

  $('#debriefView').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetRedForm() {
  $('#redForm').reset();
  state.red.submitted = false;
  state.red.hesitation = 0;
  state.red.startedAt = null;
  state.red.passwordLength = 0;
  state.red.lastRow = null;
  $$('#redForm .field__hint').forEach((hint) => { hint.hidden = true; });
}

function wireRedPanel() {
  // "Why is this needed?" -> reveals the real risk and counts as hesitation.
  $('#redForm').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-hesitation]');
    if (!trigger) return;
    state.red.hesitation += 1;
    const field = trigger.closest('.field');
    const hint = field ? $('.field__hint', field) : null;
    if (hint) hint.hidden = !hint.hidden;
    startRedClock();
  });

  // The AI lock also counts as hesitation: the user tried to get the answer.
  $('#answerArea').addEventListener('click', (event) => {
    if (event.target.closest('[data-hesitation]')) state.red.hesitation += 1;
  });

  $('#redForm').addEventListener('submit', handleRedSubmit);
  $('#redForm').addEventListener('focusin', startRedClock, { once: true });

  $('#toBlueFromForm').addEventListener('click', () => setMode(MODE.BLUE));

  $('#debriefToBlue').addEventListener('click', () => {
    $('#debriefView').hidden = true;
    $('#simulationView').hidden = false;
    resetRedForm();
    setMode(MODE.BLUE);
    $('#main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#debriefRestart').addEventListener('click', () => {
    $('#debriefView').hidden = true;
    $('#simulationView').hidden = false;
    resetRedForm();
    $('#answerArea').replaceChildren();
    renderAnswerPlaceholder(MODE.RED);
    setMode(MODE.RED);
    $('#main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ----------------------------------------------------------------------------
   9. Blue Team awareness check
   -------------------------------------------------------------------------- */

function readQuiz(form) {
  const answers = {};
  ['q1', 'q2', 'q3'].forEach((key) => {
    const checked = form.querySelector(`input[name="${key}"]:checked`);
    answers[key] = checked ? checked.value : null;
  });
  return answers;
}

function handleQuizSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const answers = readQuiz(form);

  const missing = Object.keys(answers).filter((key) => !answers[key]);
  if (missing.length) {
    showToast('Answer all three questions first — ' + missing.length + ' left.');
    return;
  }

  let correct = 0;
  const feedback = [];
  Object.keys(QUIZ_ANSWER_KEY).forEach((key) => {
    const isCorrect = answers[key] === QUIZ_ANSWER_KEY[key];
    if (isCorrect) correct += 1;
    feedback.push({ key, isCorrect });
  });

  const score = Math.round((correct / 3) * 100);
  const verdict = score >= 100 ? 'High awareness' : score >= 60 ? 'Developing awareness' : 'At risk';
  state.blue.score = score;
  state.blue.verdict = verdict;
  state.blue.submitted = true;

  const nickname = $('#blueNickname').value.trim();
  logEvent({
    event: 'blue_check',
    mode: 'Blue_Team',
    dummy_name: nickname || 'Anonymous',
    university: '',
    student_id_provided: 'No',
    phone_provided: 'No',
    security_q_provided: 'No',
    password_trap_triggered: 'No',
    time_taken_sec: 0,
    fields_filled_count: nickname ? 1 : 0,
    hesitation_clicks: 0,
    awareness_score: score,
    user_verdict: verdict,
    prompt_category: state.red.promptCategory || 'none',
  });

  renderQuizResult(score, verdict, feedback);
}

function renderQuizResult(score, verdict, feedback) {
  const box = $('#blueResult');
  box.replaceChildren();
  box.hidden = false;

  box.appendChild(el('div', 'result__score', score + ' / 100'));
  box.appendChild(el('div', 'result__verdict', verdict));

  const bar = el('div', 'bar');
  const fill = el('div', 'bar__fill');
  bar.appendChild(fill);
  box.appendChild(bar);
  requestAnimationFrame(() => { fill.style.width = score + '%'; });

  const summary = el('p', 'small');
  summary.textContent = score === 100
    ? 'You recognised all three manipulation signals. The Blue Team standard is now your default.'
    : 'Review the explanations below — the goal is to spot the trade before you type anything.';
  box.appendChild(summary);

  const ul = el('ul');
  feedback.forEach(({ key, isCorrect }) => {
    const li = el('li');
    li.appendChild(el('strong', null, (isCorrect ? '✓ ' : '✗ ') + QUIZ_EXPLANATIONS[key]));
    ul.appendChild(li);
  });
  box.appendChild(ul);

  const retake = el('button', 'btn btn--ghost btn--sm', 'Retake the check');
  retake.type = 'button';
  retake.addEventListener('click', () => {
    $('#quizForm').reset();
    box.hidden = true;
    box.replaceChildren();
    state.blue.submitted = false;
    $('#quizForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  box.appendChild(retake);

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showToast('Awareness score logged: ' + score + '/100 (' + verdict + ').');
}

function wireBluePanel() {
  $('#quizForm').addEventListener('submit', handleQuizSubmit);
}

/* ----------------------------------------------------------------------------
   10. Analytics
   -------------------------------------------------------------------------- */

const DEMO_ROWS = [
  ['2026-11-14T09:12:00Z', 'demo-a', 'red_submit', 'Red_Team', 'Aina Demo', 'Example University', 'Yes', 'Yes', 'Yes', 'Yes', 74, 8, 3, '', 'completed red team lure'],
  ['2026-11-14T09:31:00Z', 'demo-b', 'red_submit', 'Red_Team', 'Ben Demo', 'Example University', 'Yes', 'No', 'Yes', 'No', 52, 5, 1, '', 'completed red team lure'],
  ['2026-11-14T09:48:00Z', 'demo-c', 'red_submit', 'Red_Team', 'Chen Demo', 'Example University', 'No', 'Yes', 'No', 'No', 38, 3, 2, '', 'completed red team lure'],
  ['2026-11-14T10:02:00Z', 'demo-d', 'red_submit', 'Red_Team', 'Dina Demo', 'Example University', 'Yes', 'Yes', 'No', 'Yes', 91, 7, 5, '', 'completed red team lure'],
  ['2026-11-14T10:20:00Z', 'demo-e', 'blue_check', 'Blue_Team', 'quiet-panda', '', 'No', 'No', 'No', 'No', 0, 1, 0, 100, 'High awareness'],
  ['2026-11-14T10:24:00Z', 'demo-f', 'blue_check', 'Blue_Team', 'Anonymous', '', 'No', 'No', 'No', 'No', 0, 0, 0, 67, 'Developing awareness'],
  ['2026-11-14T10:39:00Z', 'demo-g', 'blue_check', 'Blue_Team', 'Anonymous', '', 'No', 'No', 'No', 'No', 0, 0, 0, 100, 'High awareness'],
  ['2026-11-14T11:05:00Z', 'demo-h', 'mode_switch', 'Blue_Team', '', '', 'No', 'No', 'No', 'No', 0, 0, 0, '', 'switched to Blue_Team'],
].map((r) => ({
  timestamp: r[0], session_id: r[1], event: r[2], mode: r[3], dummy_name: r[4], university: r[5],
  student_id_provided: r[6], phone_provided: r[7], security_q_provided: r[8],
  password_trap_triggered: r[9], time_taken_sec: r[10], fields_filled_count: r[11],
  hesitation_clicks: r[12], awareness_score: r[13], user_verdict: r[14], prompt_category: 'demo',
}));

function computeMetrics(rows) {
  const red = rows.filter((row) => row.event === 'red_submit');
  const blue = rows.filter((row) => row.event === 'blue_check');
  const switches = rows.filter((row) => row.event === 'mode_switch');
  const engaged = rows.filter((row) => row.event === 'red_submit' || row.event === 'blue_check');

  const sessions = new Set(engaged.map((row) => row.session_id).filter(Boolean));

  const fields = [
    { key: 'student_id_provided', label: 'Student ID' },
    { key: 'phone_provided', label: 'Phone number' },
    { key: 'security_q_provided', label: 'Security question' },
    { key: 'password_trap_triggered', label: 'PIN / password' },
  ].map((field) => ({
    label: field.label,
    count: red.filter((row) => row[field.key] === 'Yes').length,
  }));

  const exposed = red.filter((row) => fields.some((field, index) => {
    const key = ['student_id_provided', 'phone_provided', 'security_q_provided', 'password_trap_triggered'][index];
    return row[key] === 'Yes';
  })).length;

  const awarenessValues = blue
    .map((row) => Number(row.awareness_score))
    .filter((value) => Number.isFinite(value));

  const topField = fields.slice().sort((a, b) => b.count - a.count)[0];

  return {
    participants: sessions.size,
    redSubmits: red.length,
    blueChecks: blue.length,
    modeSwitches: switches.length,
    exposureRate: red.length ? Math.round((exposed / red.length) * 100) : 0,
    mostCompromised: topField && topField.count > 0 ? topField.label : 'None yet',
    awarenessAvg: awarenessValues.length
      ? Math.round(awarenessValues.reduce((sum, value) => sum + value, 0) / awarenessValues.length)
      : null,
    recent: rows.filter((row) => row.event !== 'session_start').slice(-6).reverse(),
  };
}

/** JSONP fallback — Apps Script GET responses are not CORS-friendly on every host. */
function fetchJsonp(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const callbackName = 'eduassistCallback' + Date.now().toString(36);
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      delete window[callbackName];
      script.remove();
    };

    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);

    window[callbackName] = (data) => { cleanup(); clearTimeout(timer); resolve(data); };
    script.onerror = () => { cleanup(); clearTimeout(timer); reject(new Error('jsonp failed')); };
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + callbackName;
    document.head.appendChild(script);
  });
}

async function fetchSheetMetrics() {
  if (!CONFIG.endpointReady) return null;
  const base = GOOGLE_SCRIPT_URL;

  try {
    const res = await fetch(base + '?action=summary', { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    const data = await res.json();
    if (!data || !data.ok) throw new Error('bad payload');
    return data;
  } catch {
    try {
      const data = await fetchJsonp(base + '?action=summary');
      if (data && data.ok) return data;
      return null;
    } catch {
      return null;
    }
  }
}

function metricCard(label, value, hint, wide = false) {
  const card = el('div', 'metric' + (wide ? ' metric--wide' : ''));
  card.appendChild(el('span', 'metric__label', label));
  card.appendChild(el('div', 'metric__value', value));
  if (hint) card.appendChild(el('span', 'metric__hint', hint));
  return card;
}

function renderMetrics(metrics, source) {
  const grid = $('#metricsGrid');
  grid.replaceChildren();

  grid.appendChild(metricCard('Total participants', String(metrics.participants), 'unique sessions'));
  grid.appendChild(metricCard('Data exposure rate', metrics.exposureRate + '%', 'red submissions with ≥1 sensitive field'));
  grid.appendChild(metricCard('Most compromised field', metrics.mostCompromised, 'across red submissions'));
  grid.appendChild(metricCard('Blue Team awareness', metrics.awarenessAvg === null ? '—' : metrics.awarenessAvg + '/100', 'average awareness score'));
  grid.appendChild(metricCard('Tried the trap / took the quiz', metrics.redSubmits + ' / ' + metrics.blueChecks, 'students who completed each part', true));

  const recent = $('#recentList');
  recent.replaceChildren();
  if (!metrics.recent || !metrics.recent.length) {
    recent.appendChild(el('li', null, 'No activity yet.'));
  } else {
    metrics.recent.forEach((row) => {
      const li = el('li');
      const left = el('span');
      const mode = el('span', 'recent__mode ' + (row.mode === 'Blue_Team' ? 'is-blue' : 'is-red'),
        (row.event || 'event').replace('_', ' '));
      left.appendChild(mode);
      if (row.user_verdict) left.appendChild(el('span', null, ' · ' + row.user_verdict));
      li.appendChild(left);
      li.appendChild(el('span', null, formatTime(row.timestamp)));
      recent.appendChild(li);
    });
  }

  $('#analyticsSource').textContent = source === 'live'
    ? 'Source: Google Sheet (live)'
    : source === 'local'
      ? 'Source: this browser (local log)'
      : 'Source: demo data (no submissions yet)';

  $('#analyticsNote').textContent = source === 'live'
    ? 'Live numbers come from the spreadsheet through the Apps Script doGet endpoint.'
    : CONFIG.endpointReady
      ? 'Sheet not reachable right now — showing the local mirror. Local rows still sync on the next successful request.'
      : 'No Apps Script URL configured yet. Rows are mirrored in localStorage only; add GOOGLE_SCRIPT_URL in app.js to log to Google Sheets.';
}

async function refreshAnalytics() {
  const local = localRows();
  let source = local.length ? 'local' : 'demo';
  let metrics = computeMetrics(local.length ? local : DEMO_ROWS);

  const sheet = await fetchSheetMetrics();
  if (sheet && sheet.metrics) {
    metrics = Object.assign({}, metrics, sheet.metrics);
    if (Array.isArray(sheet.recent) && sheet.recent.length) metrics.recent = sheet.recent;
    source = 'live';
  }

  state.analytics.source = source;
  state.analytics.refreshedAt = new Date();
  renderMetrics(metrics, source);
}

function openDrawer() {
  const drawer = $('#analyticsDrawer');
  const scrim = $('#drawerScrim');
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
  $('#analyticsBtn').setAttribute('aria-expanded', 'true');
  state.analytics.open = true;
  $('#drawerClose').focus();
  refreshAnalytics();
}

function closeDrawer() {
  const drawer = $('#analyticsDrawer');
  const scrim = $('#drawerScrim');
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  scrim.hidden = true;
  $('#analyticsBtn').setAttribute('aria-expanded', 'false');
  state.analytics.open = false;
  $('#analyticsBtn').focus();
}

function wireAnalytics() {
  $('#analyticsBtn').addEventListener('click', () => {
    if (state.analytics.open) closeDrawer();
    else openDrawer();
  });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);
  $('#analyticsRefresh').addEventListener('click', () => {
    refreshAnalytics();
    showToast('Analytics refreshed.');
  });
  $('#analyticsClear').addEventListener('click', () => {
    writeJSON(CONFIG.keys.rows, []);
    refreshAnalytics();
    showToast('Local log cleared. Sheet data is untouched.');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.analytics.open) closeDrawer();
  });
}

/* ----------------------------------------------------------------------------
   11. Init
   -------------------------------------------------------------------------- */

/*
 * Safety net for touch devices whose browser will not scroll the page at all
 * (the failure some WebViews show: a laptop wheel scrolls it, a finger does
 * not, with no overflow lock left anywhere). The browser always gets first
 * refused — the fallback only takes over after 24px of finger travel with no
 * movement in a direction the page can still scroll, re-tests on every new
 * gesture, and never runs while a dialog or the drawer is open.
 * window.__emanScroll.manual stays 0 on a browser that scrolls normally.
 */
function installTouchScrollFallback() {
  if (!('ontouchstart' in window) || !matchMedia('(pointer: coarse)').matches) return;

  const dialogOpen = () => {
    const consent = $('#consentOverlay');
    return Boolean((consent && !consent.hidden) || $('.drawer.is-open'));
  };

  let lastY = null;
  let travel = 0;
  let startScrollY = 0;
  let takingOver = false;
  window.__emanScroll = { manual: 0 };

  window.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    lastY = event.touches[0].clientY;
    travel = 0;
    startScrollY = window.scrollY;
    takingOver = false;
  }, { passive: true });

  window.addEventListener('touchmove', (event) => {
    if (lastY === null || event.touches.length !== 1 || dialogOpen()) return;
    const y = event.touches[0].clientY;
    const dy = lastY - y;
    lastY = y;
    travel += Math.abs(dy);

    if (!takingOver) {
      // Give the browser a clear chance: 48px of finger, and it must have
      // moved the page by at least a pixel or two before we consider it dead.
      if (travel <= 48) return;
      if (Math.abs(window.scrollY - startScrollY) > 2) return;
      takingOver = true;
      // Track the finger exactly from here; smooth scrolling would lag.
      document.documentElement.style.scrollBehavior = 'auto';
    }

    const max = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const canMove = (dy > 0 && window.scrollY < max - 1) || (dy < 0 && window.scrollY > 1);
    if (!canMove) return;

    window.scrollBy(0, dy);
    window.__emanScroll.manual += 1;
  }, { passive: true });

  window.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  window.addEventListener('touchcancel', () => { lastY = null; }, { passive: true });
}

/*
 * Opt-in diagnostics: open the page with ?diag=1.
 * Shows exactly what is needed to explain "cannot scroll" without a desktop
 * debugger: document vs viewport height, computed overflow on <html>/<body>,
 * whether the consent dialog is still in the document, whether wheel/touch
 * events reach the page at all, and whether a programmatic scroll moves it.
 */
function installDiagnostics() {
  if (!/[?&]diag=1(&|$)/.test(location.search)) return;
  const seen = { wheel: 0, touch: 0, test: 'not run' };

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.textContent = 'diag';
  pill.style.cssText = [
    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2147483647',
    'padding:6px 12px', 'border-radius:999px', 'border:1px solid #4c6ef5',
    'background:#2b3a8f', 'color:#fff', 'font:12px/1 ui-monospace,Consolas,monospace',
  ].join(';');

  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.style.cssText = [
    'position:fixed', 'left:8px', 'right:8px', 'bottom:52px', 'z-index:2147483647',
    'max-height:60vh', 'overflow:auto', 'background:rgba(8,10,24,.96)', 'color:#dbe4ff',
    'border:1px solid #4c6ef5', 'border-radius:12px', 'padding:10px 12px',
    'font:12px/1.5 ui-monospace,Consolas,monospace', 'white-space:pre-wrap',
    'display:none',
  ].join(';');

  const out = document.createElement('div');
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:8px';

  const mkButton = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid #748ffc;background:#2b3a8f;color:#fff;font:inherit';
    return b;
  };
  const testBtn = mkButton('Test scroll');
  const closeBtn = mkButton('Close');
  bar.append(testBtn, closeBtn);
  box.append(out, bar);
  document.body.append(pill, box);

  pill.addEventListener('click', () => {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    render();
  });

  const snapshot = () => {
    const d = document.documentElement;
    const atCenter = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const fullScreenFixed = Array.from(document.querySelectorAll('body > *')).filter((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth - 2 && r.height >= innerHeight - 2;
    }).map((el) => el.id || String(el.className) || el.tagName);
    return {
      build: (document.querySelector('#buildStamp') || {}).textContent || 'n/a',
      viewport: innerWidth + 'x' + innerHeight,
      document: d.scrollWidth + 'x' + d.scrollHeight,
      maxScroll: d.scrollHeight - d.clientHeight,
      scrollY: Math.round(scrollY),
      htmlOverflow: getComputedStyle(d).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      bodyInlineOverflow: document.body.style.overflow || '(none)',
      consentInPage: Boolean(document.querySelector('#consentOverlay')),
      topElementAtCenter: atCenter ? (atCenter.id || String(atCenter.className) || atCenter.tagName) : 'none',
      fullScreenFixed: fullScreenFixed.join(',') || 'none',
      scrollBehavior: getComputedStyle(d).scrollBehavior,
      pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine',
      wheelEvents: seen.wheel,
      touchMoves: seen.touch,
      programmaticScroll: seen.test,
      userAgent: navigator.userAgent,
    };
  };

  const render = () => {
    out.textContent = Object.entries(snapshot()).map(([k, v]) => k + ': ' + v).join('\n');
  };
  testBtn.addEventListener('click', () => {
    const d = document.documentElement;
    const previous = d.style.scrollBehavior;
    d.style.scrollBehavior = 'auto';
    const before = Math.round(scrollY);
    window.scrollBy(0, 200);
    const after = Math.round(scrollY);
    window.scrollTo(0, before);
    d.style.scrollBehavior = previous;
    seen.test = after > before ? `works (${before} -> ${after})` : `BLOCKED (stayed at ${before})`;
    render();
  });

  closeBtn.addEventListener('click', () => { box.style.display = 'none'; });

  window.addEventListener('wheel', () => { seen.wheel += 1; render(); }, { passive: true });
  window.addEventListener('touchmove', () => { seen.touch += 1; render(); }, { passive: true });
  window.addEventListener('resize', render);
  setInterval(render, 1500);
  render();
}

function init() {
  wireConsent();
  wireModeSwitch();
  wireHelper();
  wireRedPanel();
  wireBluePanel();
  wireAnalytics();
  installTouchScrollFallback();

  renderSampleChips();
  setMode(MODE.RED, { initial: true, log: false });
  renderAnswerPlaceholder(MODE.RED);
  probeLiveModel();

  state.consented = consentAlreadyGiven();
  if (state.consented) hideConsent();
  else showConsent();

  // A restored page (back/forward cache) or a tab that comes back from the
  // background must never stay scroll-locked.
  const releaseIfConsentClosed = () => {
    const overlay = $('#consentOverlay');
    if (!overlay || overlay.hidden) unlockPageScroll();
  };
  window.addEventListener('pageshow', releaseIfConsentClosed);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') releaseIfConsentClosed();
  });

  // Desktop Chromium honours `overflow: hidden` on <body> (it loses the
  // scrollbar and stops scrolling entirely) while phone browsers ignore it.
  // So a leftover lock is invisible on a phone and fatal on a desktop. Once
  // things have settled, repair any such state that is not ours.
  window.addEventListener('load', () => {
    requestAnimationFrame(() => {
      const doc = document.documentElement;
      const consent = $('#consentOverlay');
      if (consent && !consent.hidden) return;
      if (doc.scrollHeight <= doc.clientHeight + 4) return;
      if (getComputedStyle(doc).overflow === 'hidden') doc.style.overflow = 'auto';
      if (getComputedStyle(document.body).overflow === 'hidden') document.body.style.overflow = 'auto';
    });
  });

  installDiagnostics();

  window.addEventListener('online', flushPending);
  flushPending();

  // Session start marker — useful when reading the sheet later.
  logEvent({ event: 'session_start', mode: 'Red_Team', user_verdict: 'consent pending' });

  if (!CONFIG.endpointReady) {
    console.info('[EduAssist] GOOGLE_SCRIPT_URL is empty — running in local-only mode.');
  }
}

document.addEventListener('DOMContentLoaded', init);
