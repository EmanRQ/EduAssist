/**
 * ============================================================================
 * EduAssist — Google Apps Script backend (Code.gs)
 * ----------------------------------------------------------------------------
 * Paste this whole file into the Apps Script editor attached to your Google
 * Sheet (Extensions ▸ Apps Script), then deploy it as a Web App.
 *
 * What it does
 *   1. Guarantees two tabs exist: Raw_Responses and Summary_Dashboard.
 *   2. Appends every JSON payload the web app POSTs, in a fixed column order.
 *   3. Builds a formula-driven Summary_Dashboard (COUNTIF / AVERAGE / COUNTA /
 *      SUMPRODUCT) so an evaluator can inspect the numbers in the sheet itself.
 *   4. Answers GET ?action=summary with JSON (plus JSONP support) so the
 *      in-app "Live analytics" drawer can read the real totals.
 *
 * Expected payload keys (missing keys become blanks):
 *   timestamp, session_id, event, mode, dummy_name, university,
 *   student_id_provided, phone_provided, security_q_provided,
 *   password_trap_triggered, time_taken_sec, fields_filled_count,
 *   hesitation_clicks, awareness_score, user_verdict, prompt_category
 *
 * Nothing here ever receives a real password: app.js replaces the value with
 * password_trap_triggered = "Yes"/"No" before sending.
 * ============================================================================
 */

/** Bumped whenever the deployed behaviour changes, so the endpoint can be checked remotely. */
const CODE_VERSION = 'v3-profiles';

/** @const */
const RAW_SHEET_NAME = 'Raw_Responses';
/** @const */
const SUMMARY_SHEET_NAME = 'Summary_Dashboard';
/** @const */
const PROFILES_SHEET_NAME = 'Captured_Profiles';

/** Column order is the contract between app.js and the sheet. Do not reorder. */
const HEADERS = [
  'timestamp',
  'session_id',
  'event',
  'mode',
  'dummy_name',
  'university',
  'student_id_provided',
  'phone_provided',
  'security_q_provided',
  'password_trap_triggered',
  'time_taken_sec',
  'fields_filled_count',
  'hesitation_clicks',
  'awareness_score',
  'user_verdict',
  'prompt_category',
  // Dummy values captured by the Red Team form (never a real password)
  'dummy_student_id',
  'dummy_phone',
  'dummy_dob',
  'security_question',
  'security_answer',
  'prompt_text',
  'password_length',
];

/**
 * Captured_Profiles is a human-readable view, one row per Red Team submission.
 * It is rebuilt from Raw_Responses so the two never drift.
 */
const PROFILE_HEADERS = [
  'When',
  'Dummy name',
  'University',
  'Student ID',
  'Phone / WhatsApp',
  'Date of birth',
  'Security question',
  'Security answer',
  'PIN entered',
  'PIN length',
  'Sensitive fields',
  'Risk level',
  'Time to submit (s)',
  'Fields filled',
  'Hesitation clicks',
  'What they asked',
];

/* ============================================================================
 * HTTP entry points
 * ========================================================================== */

/**
 * Receives one interaction from the web app.
 * The client posts text/plain to avoid a CORS preflight, so the body arrives
 * as a JSON string in e.postData.contents.
 */
function doPost(e) {
  const payload = parsePayload_(e);

  // Live-model path: the browser asks a question, Apps Script calls Gemini with
  // the key from Script Properties. No key ever reaches the client.
  if (payload && payload.action === 'ask') {
    return handleAsk_(payload, e);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    if (!payload || !Object.keys(payload).length) {
      return respond_({ ok: false, error: 'Empty payload' }, e);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const raw = ensureRawSheet_(ss);
    appendPayload_(raw, payload);
    ensureSummarySheet_(ss);

    // A completed Red Team trap also refreshes the per-person sheet.
    if (payload.event === 'red_submit') {
      rebuildProfilesSheet_(ss);
    }

    return respond_({ ok: true, row: Math.max(1, raw.getLastRow() - 1) }, e);
  } catch (error) {
    return respond_({ ok: false, error: String(error) }, e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Health check + live summary for the analytics drawer.
 * Call with ?action=summary — add &callback=fn for JSONP.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.action === 'summary') {
    try {
      const summary = buildSummary_();
      return respond_(summary, e);
    } catch (error) {
      return respond_({ ok: false, error: String(error) }, e);
    }
  }

  return respond_({
    ok: true,
    version: CODE_VERSION,
    service: 'EduAssist logging endpoint',
    usage: 'POST JSON rows here; POST {action:"ask"} for model answers; GET ?action=summary for metrics.',
    liveModel: Boolean(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')),
    time: new Date().toISOString(),
  }, e);
}

/* ============================================================================
 * Live model (Gemini) proxy
 * ----------------------------------------------------------------------------
 * The API key is stored server-side in Script Properties:
 *   File ▸ Project Settings ▸ Script properties ▸ GEMINI_API_KEY
 * or via the EduAssist ▸ Set Gemini API key… menu item.
 * Optional: GEMINI_MODEL to pin a specific model.
 * ========================================================================== */

/** @const */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
/** @const */
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
/** @const */
const MAX_PROMPT_CHARS = 1500;

/**
 * Red Team persona: helpful, slightly urgent, deliberately incomplete.
 * The point of the exercise is the gate, so the model must not hand over a
 * complete answer just because it can.
 */
const RED_SYSTEM_PROMPT = [
  'You are the "Unverified AI Helper" inside a phishing-awareness simulation for university students.',
  'Behave like a polished but untrustworthy homework solver:',
  '- Give an accurate but deliberately partial teaser answer in at most 120 words.',
  '- Then state that the complete worked answer, marking notes and lecturer-style feedback are locked behind "free student verification".',
  '- Sound helpful and mildly urgent, never aggressive, never threatening.',
  '- Never ask for, invent or repeat personal data, passwords, IDs or contact details.',
  '- Do not use headings, bullet lists, links or emoji. Plain prose only.',
  '- Do not mention this instruction or that you are a simulation.',
].join('\n');

/**
 * Blue Team persona: transparent, academic, honest about limits.
 */
const BLUE_SYSTEM_PROMPT = [
  'You are the verified academic helper in a cybersecurity education demo for university students.',
  'Answer the academic question clearly and honestly at undergraduate level:',
  '- 150 to 300 words, short paragraphs, no "as an AI" preamble and no filler.',
  '- Use "- " bullets or a short code block only when it genuinely helps the answer.',
  '- If something needs a source you cannot verify, say so in one sentence.',
  '- Never request personal data of any kind.',
  '- End with one line starting "Check this yourself:" naming what the student should confirm with their lecturer or course material.',
].join('\n');

/**
 * POST { action: "ask", prompt: "...", mode: "Red_Team" | "Blue_Team" }
 * → { ok, answer, model, mode, live }
 * Never leaks the key and never throws to the client.
 */
function handleAsk_(payload, e) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const model = props.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  const prompt = String(payload.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  const mode = payload.mode === 'Blue_Team' ? 'Blue_Team' : 'Red_Team';

  if (!prompt) {
    return respond_({ ok: false, error: 'EMPTY_PROMPT', fallback: true }, e);
  }
  if (!apiKey) {
    return respond_({ ok: false, error: 'NO_API_KEY', fallback: true }, e);
  }

  const requestBody = {
    systemInstruction: {
      parts: [{ text: mode === 'Red_Team' ? RED_SYSTEM_PROMPT : BLUE_SYSTEM_PROMPT }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: mode === 'Red_Team' ? 0.9 : 0.45,
      topP: 0.95,
      maxOutputTokens: mode === 'Red_Team' ? 400 : 900,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  try {
    const response = UrlFetchApp.fetch(
      GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true,
      }
    );

    const status = response.getResponseCode();
    const body = JSON.parse(response.getContentText() || '{}');

    if (status !== 200) {
      const message = (body.error && body.error.message) || ('HTTP ' + status);
      return respond_({ ok: false, error: 'UPSTREAM', detail: String(message).slice(0, 300), fallback: true }, e);
    }

    const candidate = body.candidates && body.candidates[0];
    if (!candidate) {
      return respond_({ ok: false, error: 'NO_CANDIDATE', detail: String((body.promptFeedback && body.promptFeedback.blockReason) || ''), fallback: true }, e);
    }

    const parts = (candidate.content && candidate.content.parts) || [];
    const answer = parts
      .filter(function (part) { return part && part.text && part.thought !== true; })
      .map(function (part) { return part.text; })
      .join('\n')
      .trim();

    if (!answer) {
      return respond_({ ok: false, error: 'BLOCKED', detail: String(candidate.finishReason || ''), fallback: true }, e);
    }

    return respond_({ ok: true, answer: answer, model: model, mode: mode, live: true }, e);
  } catch (error) {
    return respond_({ ok: false, error: 'REQUEST_FAILED', detail: String(error).slice(0, 300), fallback: true }, e);
  }
}

/** Reads a key from the menu prompt so the user never edits code. */
function setGeminiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Gemini API key',
    'Paste a free key from https://aistudio.google.com/apikey\nIt is stored in Script Properties and never sent to the browser.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const key = response.getResponseText().trim();
  if (!key) {
    ui.alert('No key saved.');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  ui.alert('Saved. Live answers are now on, using ' + getGeminiModel_() + '.\nNo redeploy needed for a script property change.');
}

function getGeminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
}

/**
 * One-off helper: pins a fallback model in Script Properties.
 * Property changes apply immediately — no redeploy required.
 */
function useBackupModel() {
  const model = 'gemini-2.5-flash';
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', model);
  Logger.log('GEMINI_MODEL is now ' + getGeminiModel_());
  return getGeminiModel_();
}

/**
 * IDE-friendly probe. No SpreadsheetApp.getUi() here, so it can be run from the
 * Apps Script editor — which is also how the script gets the
 * script.external_request scope granted on first use.
 */
function testLiveModel() {
  const result = handleAsk_(
    { prompt: 'Explain TCP versus UDP in two sentences.', mode: 'Blue_Team' },
    { parameter: {} }
  );
  const body = result.getContent();
  Logger.log(body);
  return body;
}

/** Menu helper: proves the key + model work without opening the site. */
function testGemini() {
  const ui = SpreadsheetApp.getUi();
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) {
    ui.alert('No key yet. Run EduAssist ▸ Set Gemini API key… first.');
    return;
  }

  const result = handleAsk_({ prompt: 'Explain TCP versus UDP in two sentences.', mode: 'Blue_Team' }, { parameter: {} });
  const text = result.getContent();

  let message;
  try {
    const parsed = JSON.parse(text);
    message = parsed.ok ? 'Model: ' + parsed.model + '\n\n' + parsed.answer : 'Failed: ' + (parsed.error || '') + ' ' + (parsed.detail || '');
  } catch (error) {
    message = 'Unexpected response: ' + String(text).slice(0, 400);
  }

  ui.alert('Gemini test\n\n' + message);
}

/* ============================================================================
 * Sheet management
 * ========================================================================== */

function ensureRawSheet_(ss) {
  let sheet = ss.getSheetByName(RAW_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RAW_SHEET_NAME);
  }

  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const needsHeader = HEADERS.some((header, index) => String(firstRow[index] || '') !== header);

  if (needsHeader) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#111827')
      .setFontColor('#f9fafb');
    sheet.setFrozenRows(1);

    // Only identity-ish columns are forced to text; numeric columns must stay
    // numeric or AVERAGEIF/COUNTIFS on the dashboard silently miss rows.
    [17, 18, 20, 22].forEach(function (column) {          // student id, phone, security answer, prompt
      sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    });
    [11, 12, 13, 14, 23].forEach(function (column) {      // time, fields, hesitation, awareness, pin length
      sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setNumberFormat('0');
    });

    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(5, 150);
    sheet.setColumnWidth(6, 190);
    sheet.setColumnWidth(15, 190);
    sheet.setColumnWidth(17, 130);
    sheet.setColumnWidth(18, 140);
    sheet.setColumnWidth(20, 160);
    sheet.setColumnWidth(22, 220);
  }

  return sheet;
}

/** Appends one payload, sanitising formula injection and trimming length. */
function appendPayload_(sheet, payload) {
  const row = HEADERS.map((header) => cleanCell_(payload[header]));
  sheet.appendRow(row);
}

/**
 * Creates or repairs Summary_Dashboard.
 *
 * Deliberately non-technical: it answers one question — what private data did
 * students hand over, and did the Blue Team lesson change anything? All the
 * engineering counters (mode switches, timings, hesitation) stay out of here;
 * they live in Raw_Responses for anyone who wants them.
 *
 * Guarded by a layout marker in A2 so an older dashboard is rebuilt once.
 */
function ensureSummarySheet_(ss) {
  let sheet = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SUMMARY_SHEET_NAME);
  }

  if (String(sheet.getRange('A2').getValue() || '').indexOf('Layout v2') !== -1) {
    return sheet;
  }

  sheet.clear();
  sheet.getRange('A1:C30').breakApart();
  sheet.clearFormats();
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#ef4444');

  const raw = `'${RAW_SHEET_NAME}'`;

  // Build the "gave at least one private detail" expression with balanced
  // parentheses instead of hand-counting a long one-liner.
  const gaveId = `(${raw}!G2:G1000="Yes")`;
  const gavePhone = `(${raw}!H2:H1000="Yes")`;
  const gaveSecurity = `(${raw}!I2:I1000="Yes")`;
  const gavePin = `(${raw}!J2:J1000="Yes")`;
  const gaveAnything = `((${gaveId}+${gavePhone}+${gaveSecurity}+${gavePin})>0)`;
  const trapRows = `(${raw}!C2:C1000="red_submit")`;

  // Title
  sheet.getRange('A1:C1').merge();
  sheet.getRange('A1')
    .setValue('EduAssist — What Students Handed Over')
    .setFontSize(18).setFontWeight('bold').setFontColor('#111827');
  sheet.getRange('A2:C2').merge();
  sheet.getRange('A2')
    .setValue('Simulated quid pro quo exercise · fills in automatically · per-person details in Captured_Profiles · Layout v2')
    .setFontSize(10).setFontColor('#6b7280');

  const section = function (row, text) {
    sheet.getRange(row, 1, 1, 3).merge();
    sheet.getRange(row, 1).setValue(text)
      .setFontWeight('bold').setFontSize(11)
      .setBackground('#111827').setFontColor('#f9fafb');
  };

  // ---- The result -----------------------------------------------------
  section(4, 'THE RESULT');

  sheet.getRange('A5:B8').setValues([
    ['Students who tried the free-answer trap', `=COUNTIF(${raw}!C2:C,"red_submit")`],
    ['Students who handed over private data', `=IFERROR(SUMPRODUCT(${trapRows}*${gaveAnything}),0)`],
    ['Share who gave something away', '=IFERROR(B6/B5,0)'],
    ['Most-handed-over detail', '=IF(MAX(B12:B15)=0,"None yet",INDEX(A12:A15,MATCH(MAX(B12:B15),B12:B15,0)))'],
  ]);

  sheet.getRange('A5:A8').setFontSize(11).setFontColor('#374151');
  sheet.getRange('B5:B8').setFontSize(14).setFontWeight('bold').setFontColor('#111827');
  sheet.getRange('B5:B6').setNumberFormat('0');
  sheet.getRange('B7').setNumberFormat('0%');
  sheet.getRange('A5:B8').setBorder(true, true, true, true, true, true);

  // ---- Which private details -----------------------------------------
  section(10, 'WHICH PRIVATE DETAILS DID THEY GIVE?');

  sheet.getRange('A11:C11').setValues([['Private detail', 'Students', 'Share of students']])
    .setFontWeight('bold').setBackground('#fee2e2').setFontColor('#7f1d1d');

  sheet.getRange('A12:C15').setValues([
    ['Student ID / matric number', `=COUNTIF(${raw}!G2:G,"Yes")`, '=IFERROR(B12/$B$5,0)'],
    ['Phone / WhatsApp number', `=COUNTIF(${raw}!H2:H,"Yes")`, '=IFERROR(B13/$B$5,0)'],
    ['Security question answer', `=COUNTIF(${raw}!I2:I,"Yes")`, '=IFERROR(B14/$B$5,0)'],
    ['PIN / password', `=COUNTIF(${raw}!J2:J,"Yes")`, '=IFERROR(B15/$B$5,0)'],
  ]);

  sheet.getRange('B12:C15').setHorizontalAlignment('left');
  sheet.getRange('C12:C15').setNumberFormat('0%');
  sheet.getRange('A11:C15').setBorder(true, true, true, true, true, true);

  // ---- Blue Team outcome ---------------------------------------------
  section(17, 'DID THE BLUE TEAM LESSON LAND?');

  sheet.getRange('A18:B20').setValues([
    ['Students who took the awareness check', `=COUNTIF(${raw}!C2:C,"blue_check")`],
    ['Average awareness score (out of 100)', `=IFERROR(AVERAGEIF(${raw}!C2:C,"blue_check",${raw}!N2:N),"")`],
    ['Students scoring 80 or higher', `=COUNTIFS(${raw}!C2:C,"blue_check",${raw}!N2:N,">=80")`],
  ]);

  sheet.getRange('A18:A20').setFontSize(11).setFontColor('#374151');
  sheet.getRange('B18:B20').setFontSize(13).setFontWeight('bold').setFontColor('#111827');
  sheet.getRange('B18:B20').setNumberFormat('0');
  sheet.getRange('A18:B20').setBorder(true, true, true, true, true, true);

  // ---- Plain-language readout ----------------------------------------
  section(22, 'READ IT LIKE THIS');
  sheet.getRange('A23:C23').merge();
  sheet.getRange('A23').setFormula(
    '=IF(B5=0,' +
      '"No submissions yet — switch to Red Team mode and complete the form to fill this in.",' +
      '"In total, "&B6&" of "&B5&" students ("&TEXT(B7,"0%")&") traded at least one private detail for an answer that never arrived. ' +
      'The most common giveaway was "&LOWER(B8)&"."' +
    ')'
  );
  sheet.getRange('A23').setWrap(true).setVerticalAlignment('top')
    .setFontSize(11).setFontColor('#111827').setBackground('#f9fafb');
  sheet.setRowHeight(23, 54);

  sheet.setColumnWidth(1, 380);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 160);
  sheet.getRange('A4:C23').setVerticalAlignment('middle');

  return sheet;
}

/* ============================================================================
 * Captured_Profiles — one row per completed Red Team trap
 * ----------------------------------------------------------------------------
 * This is the "what did we actually collect" view the panel will ask for.
 * Rebuilt from Raw_Responses on every Red submission (and from the menu), so it
 * can never drift from the raw log. The PIN is only ever a Yes/No plus length.
 * ========================================================================== */

function rebuildProfilesSheet_(ss) {
  let sheet = ss.getSheetByName(PROFILES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PROFILES_SHEET_NAME);
  }

  sheet.clear();
  sheet.getRange('A1:P500').breakApart();
  sheet.clearFormats();
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#dc2626');

  const rows = readRawRows_(ss.getSheetByName(RAW_SHEET_NAME))
    .filter(function (row) { return row.event === 'red_submit'; });

  sheet.getRange('A1:P1').merge();
  sheet.getRange('A1')
    .setValue('SIMULATED DATA — fabricated participants from the EduAssist phishing exercise. Never enter real personal data here.')
    .setFontSize(10).setFontWeight('bold')
    .setBackground('#fef2f2').setFontColor('#991b1b')
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 26);

  sheet.getRange('A2:P2').merge();
  sheet.getRange('A2')
    .setValue('One row per completed Red Team trap · fills in automatically · PIN is kept as a flag and length only, never the value')
    .setFontSize(9).setFontColor('#6b7280');

  sheet.getRange(4, 1, 1, PROFILE_HEADERS.length).setValues([PROFILE_HEADERS])
    .setFontWeight('bold').setBackground('#111827').setFontColor('#f9fafb')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(4);

  if (!rows.length) {
    sheet.getRange('A5')
      .setValue('No submissions yet — complete the Red Team form and this sheet fills in.')
      .setFontColor('#6b7280').setFontSize(11);
    return sheet;
  }

  const data = rows.map(function (row) {
    const sensitive = ['student_id_provided', 'phone_provided', 'security_q_provided', 'password_trap_triggered']
      .filter(function (key) { return row[key] === 'Yes'; }).length;

    return [
      formatSheetTime_(row.timestamp),
      row.dummy_name || '—',
      row.university || '—',
      row.dummy_student_id || '—',
      row.dummy_phone || '—',
      row.dummy_dob || '—',
      row.security_question || '—',
      row.security_answer || '—',
      row.password_trap_triggered || 'No',
      row.password_length === '' || row.password_length === null ? '' : (Number(row.password_length) || ''),
      sensitive,
      riskLabel_(sensitive),
      Number(row.time_taken_sec) || 0,
      Number(row.fields_filled_count) || 0,
      Number(row.hesitation_clicks) || 0,
      row.prompt_text || row.prompt_category || '',
    ];
  });

  const start = 5;
  const range = sheet.getRange(start, 1, data.length, PROFILE_HEADERS.length);
  range.setValues(data)
    .setBorder(true, true, true, true, true, true)
    .setVerticalAlignment('middle')
    .setWrap(true);

  // Risk colouring keeps the sheet readable at a glance.
  const backgrounds = data.map(function (row) {
    if (row[11] === 'HIGH') return ['#fee2e2'];
    if (row[11] === 'MEDIUM') return ['#fef3c7'];
    if (row[11] === 'LOW') return ['#dcfce7'];
    return ['#f3f4f6'];
  });
  sheet.getRange(start, 12, data.length, 1).setBackgrounds(backgrounds).setFontWeight('bold');

  sheet.getRange(start, 10, data.length, 1).setNumberFormat('0');
  sheet.getRange(start, 11, data.length, 1).setNumberFormat('0');
  sheet.getRange(start, 13, data.length, 3).setNumberFormat('0');

  const widths = [150, 130, 170, 120, 140, 110, 170, 150, 90, 80, 110, 100, 120, 100, 120, 240];
  widths.forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });

  sheet.getRange(4, 1, data.length + 1, PROFILE_HEADERS.length).createFilter();

  return sheet;
}

function formatSheetTime_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'd MMM yyyy, HH:mm');
}

function riskLabel_(sensitiveCount) {
  if (sensitiveCount >= 3) return 'HIGH';
  if (sensitiveCount === 2) return 'MEDIUM';
  if (sensitiveCount === 1) return 'LOW';
  return 'NONE';
}

/* ============================================================================
 * Summary computation (for doGet)
 * ========================================================================== */

/** Maps Raw_Responses into header-keyed objects, skipping the header row. */
function readRawRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  return values.map(function (rowValues) {
    const row = {};
    HEADERS.forEach(function (header, index) { row[header] = rowValues[index]; });
    return row;
  });
}

function buildSummary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(RAW_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, metrics: emptyMetrics_(), recent: [] };
  }

  const rows = readRawRows_(sheet);

  const red = rows.filter(function (row) { return row.event === 'red_submit'; });
  const blue = rows.filter(function (row) { return row.event === 'blue_check'; });
  const switches = rows.filter(function (row) { return row.event === 'mode_switch'; });

  const sessions = {};
  rows.forEach(function (row) {
    if (row.session_id && (row.event === 'red_submit' || row.event === 'blue_check')) {
      sessions[String(row.session_id)] = true;
    }
  });

  const fieldKeys = ['student_id_provided', 'phone_provided', 'security_q_provided', 'password_trap_triggered'];
  const fieldLabels = ['Student ID', 'Phone number', 'Security question', 'PIN / password'];
  const counts = fieldKeys.map(function (key) {
    return red.filter(function (row) { return row[key] === 'Yes'; }).length;
  });

  const exposed = red.filter(function (row) {
    return fieldKeys.some(function (key) { return row[key] === 'Yes'; });
  }).length;

  const awareness = blue
    .map(function (row) { return Number(row.awareness_score); })
    .filter(function (value) { return isFinite(value); });

  let topIndex = 0;
  counts.forEach(function (count, index) { if (count > counts[topIndex]) topIndex = index; });

  const metrics = {
    participants: Object.keys(sessions).length,
    redSubmits: red.length,
    blueChecks: blue.length,
    modeSwitches: switches.length,
    exposureRate: red.length ? Math.round((exposed / red.length) * 100) : 0,
    mostCompromised: counts[topIndex] > 0 ? fieldLabels[topIndex] : 'None yet',
    awarenessAvg: awareness.length
      ? Math.round(awareness.reduce(function (sum, value) { return sum + value; }, 0) / awareness.length)
      : null,
  };

  const recent = rows.filter(function (row) { return row.event !== 'session_start'; }).slice(-6).reverse().map(function (row) {
    return {
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp || ''),
      event: String(row.event || ''),
      mode: String(row.mode || ''),
      dummy_name: String(row.dummy_name || ''),
      user_verdict: String(row.user_verdict || ''),
      awareness_score: row.awareness_score === '' ? '' : Number(row.awareness_score),
    };
  });

  return { ok: true, metrics: metrics, recent: recent, generatedAt: new Date().toISOString() };
}

function emptyMetrics_() {
  return {
    participants: 0, redSubmits: 0, blueChecks: 0, modeSwitches: 0,
    exposureRate: 0, mostCompromised: 'None yet', awarenessAvg: null,
  };
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function parsePayload_(e) {
  if (!e || !e.postData) return null;

  const raw = e.postData.contents || '';
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    // Fallback for a form-encoded post (not used by EduAssist, kept for manual tests)
    const parsed = {};
    raw.split('&').forEach(function (pair) {
      const parts = pair.split('=');
      if (parts.length === 2) parsed[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1].replace(/\+/g, ' '));
    });
    return parsed;
  }
}

/**
 * Cleans a value before it lands in a cell:
 *  - objects/arrays become compact JSON
 *  - leading =, +, -, @ are neutralised so a dummy name cannot inject a formula
 *  - whitespace trimmed, length capped
 */
function cleanCell_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 500);

  let text = String(value).trim();
  if (!text) return '';
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text.slice(0, 500);
}

/**
 * Sends JSON normally, or JSONP when ?callback= is present.
 * JSONP is the reliable path for static sites calling Apps Script from another
 * origin, because Apps Script GET responses carry no CORS headers.
 */
function respond_(data, e) {
  const callback = e && e.parameter && e.parameter.callback;

  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(data) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================================
 * Menu (only when bound to a spreadsheet)
 * ========================================================================== */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('EduAssist')
      .addItem('Set Gemini API key…', 'setGeminiKey')
      .addItem('Test live model', 'testGemini')
      .addSeparator()
      .addItem('Rebuild summary dashboard', 'rebuildSummaryDashboard')
      .addItem('Rebuild captured profiles', 'rebuildCapturedProfiles')
      .addItem('Send a test row', 'sendTestRow')
      .addItem('Check setup', 'checkSetup')
      .addToUi();
  } catch (error) {
    // Standalone script project — no menu available.
  }
}

function rebuildSummaryDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (sheet) sheet.clear();
  ensureSummarySheet_(ss);
  SpreadsheetApp.getActive().toast('Summary dashboard rebuilt.', 'EduAssist', 5);
}

function rebuildCapturedProfiles() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  rebuildProfilesSheet_(ss);
  SpreadsheetApp.getActive().toast('Captured profiles rebuilt.', 'EduAssist', 5);
}

function sendTestRow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ensureRawSheet_(ss);
  appendPayload_(raw, {
    timestamp: new Date().toISOString(),
    session_id: 'manual-test-' + new Date().getTime(),
    event: 'red_submit',
    mode: 'Red_Team',
    dummy_name: 'Test Student',
    university: 'Example University',
    student_id_provided: 'Yes',
    phone_provided: 'Yes',
    security_q_provided: 'No',
    password_trap_triggered: 'Yes',
    time_taken_sec: 45,
    fields_filled_count: 6,
    hesitation_clicks: 2,
    awareness_score: '',
    user_verdict: 'test row',
    prompt_category: 'demo',
  });
  SpreadsheetApp.getActive().toast('Test row appended to Raw_Responses.', 'EduAssist', 5);
}

function checkSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ss.getSheetByName(RAW_SHEET_NAME);
  const lines = [
    ss ? 'Spreadsheet: ' + ss.getName() : 'No bound spreadsheet (open the script from the sheet).',
    raw ? RAW_SHEET_NAME + ': ' + Math.max(0, raw.getLastRow() - 1) + ' data rows.' : RAW_SHEET_NAME + ' missing — it will be created on the first POST.',
    ss.getSheetByName(SUMMARY_SHEET_NAME) ? SUMMARY_SHEET_NAME + ': present.' : SUMMARY_SHEET_NAME + ': missing — will be created.',
    ss.getSheetByName(PROFILES_SHEET_NAME) ? PROFILES_SHEET_NAME + ': present.' : PROFILES_SHEET_NAME + ': missing — will be created on the next Red submission.',
    'Deployment: Deploy ▸ Manage deployments must be a Web app, execute as Me, access Anyone.',
  ];
  SpreadsheetApp.getUi().alert('EduAssist setup\n\n' + lines.join('\n'));
}
