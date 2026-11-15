# EduAssist

An educational **Quid Pro Quo social engineering simulation** for university students, built as a
single-page web app with a **Red Team (attack) mode** and a **Blue Team (defence) mode**.

> **Academic simulation only.** The Red Team mode imitates a malicious "free AI homework solver".
> It never asks for, stores or transmits real credentials. Do not enter real passwords, real
> IC/passport numbers or any sensitive personal data — dummy data only.

---

## What it does

| Mode | Experience |
|---|---|
| **Red Team** (default) | Dark `#0a0a0f` UI with crimson neon borders and an *Unverified AI Helper* badge. The helper gives a teaser answer, then locks the full solution behind a "Free Student Verification" form that asks for name, university, matric number, phone, date of birth, a security question and a PIN. After submitting, a **Simulated Attack Debrief** shows every field handed over, what each one is worth to an attacker, and the behavioural metrics captured silently. |
| **Blue Team** | Warm ivory `#faf8f5` UI with blue/emerald accents, verified-domain and privacy badges. The same homework helper answers **immediately** with no personal data, publishes what it does and does not collect, offers a red-flag checklist, and runs a 3-question **Spot the Red Flags** awareness check with a scored result. |

Switching modes swaps the theme, the form, the helper behaviour and the logged payload, and
reveals an interactive **Red vs Blue comparison banner**.

Other features:

- Informed-consent gate on first load of a session.
- Behavioural metrics: `time_to_submit_seconds`, `fields_filled_count`, `hesitation_clicks`.
- **Password trap**: the PIN/password field is reduced to `entered: Yes/No` + length and wiped
  from the field *before* any network call.
- **Live Simulations Analytics** drawer: total participants, data-exposure rate, most compromised
  field, Blue Team awareness score, recent activity — read live from your Google Sheet when
  reachable, otherwise from the local log, otherwise from demo data.

---

## Files

```
EduAssist/
├── index.html    # markup for both modes, consent modal, debrief, analytics drawer
├── style.css     # design tokens + components; themes keyed on <html data-mode="red|blue">
├── app.js        # mode switching, simulated helper, form/quiz logic, logging, analytics
├── Code.gs       # Google Apps Script backend (doPost / doGet / auto-built dashboard)
├── requirement.txt
└── README.md
```

No build step, no framework, no backend server. Tailwind is loaded from the CDN for layout
utilities; every theme-critical style lives in `style.css` so the app still looks right if the
CDN is slow or blocked.

---

## 1. Run it locally

The app is static, but it must be served over HTTP for the Apps Script calls (and not opened as
`file://`), because `file://` sends a `null` origin.

```powershell
cd "C:\Users\Eman\Desktop\ITT320 EduAssist"
npx --yes serve . -l 5173
```

Then open <http://localhost:5173>. Try a sample prompt in Red Team mode, fill the form with fake
data, read the debrief, then switch to Blue Team and take the awareness check.

You can also use the VS Code "Live Server" extension — any static server works.

---

## 2. Connect Google Sheets

### 2.1 Create the spreadsheet and the script

1. Go to <https://sheets.new> and name the file **EduAssist Simulation Log**.
2. In the sheet: **Extensions ▸ Apps Script**.
3. Delete the placeholder `myFunction` and paste the entire contents of `Code.gs` from this repo.
4. **Save** (Ctrl+S). Name the project `EduAssist Logger`.

### 2.2 Deploy as a Web App

1. Top right: **Deploy ▸ New deployment**.
2. Gear icon ▸ select type **Web app**.
3. Set:
   - **Description**: `EduAssist logging v1`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone** *(required — the student browser is an anonymous caller)*
4. **Deploy** → **Authorize access** → pick your Google account → *Advanced* →
   *Go to EduAssist Logger (unsafe)* → **Allow**. This warning is normal for personal scripts.
5. Copy the **Web app URL**. It ends in `/exec` and looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

### 2.3 The URL is already configured

`app.js` already points at the deployed Web App, so the sheet starts receiving rows as soon as the
site is served over HTTP:

```js
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

If you redeploy to a **new** URL, replace that constant. Keep the endpoint treated as public:
anyone with the link can append rows, which is required for anonymous participants.

> **Re-deploying after edits:** Apps Script keeps serving the old code until you publish a new
> version. Use **Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy**, keeping the
> same `/exec` URL.

### 2.4 Verify it works

1. In the sheet, reload the page — a new **EduAssist** menu appears.
2. **EduAssist ▸ Send a test row** → check that a row appears in `Raw_Responses` and the numbers
   move in `Summary_Dashboard`.
3. In the web app, complete a Red Team submission, then open **Live analytics** — the source
   label should read *Google Sheet (live)*.

### 2.5 Turn on live model answers (free)

Without a key the helper falls back to hand-written teaching answers, clearly labelled
**scripted fallback**. With a key it answers any prompt using Gemini Flash.

1. Get a free key at <https://aistudio.google.com/apikey> (Google account, no billing needed).
2. In the spreadsheet: **EduAssist ▸ Set Gemini API key…** and paste it.
   *Alternative:* **Project Settings ▸ Script properties ▸ Add** `GEMINI_API_KEY`.
3. **EduAssist ▸ Test live model** — you should see a two-sentence TCP/UDP answer.
4. Reload the site and ask anything. The answer meta line should read **live model · gemini-3.8-flash**.

Notes:

- Script-property changes take effect immediately; **no redeploy is required**.
- Free tier is roughly 1,500 Flash requests/day. If you hit the cap, the app logs the failure and
  silently falls back to the scripted answers, so the demo never breaks.
- To pin a different model, add a script property `GEMINI_MODEL` (e.g. `gemini-3.7-flash`).
- Free-tier prompts may be used by Google to improve products. That is disclosed in Blue Team mode;
  the simulation only ever sends the question text, never form data.

---

## 3. Host it

The app is three static files, so any host works:

- **GitHub Pages** — *Settings ▸ Pages ▸ Deploy from a branch ▸ `main` / `root`*. Because of the
  `/EduAssist/` sub-path, keep the relative `style.css` and `app.js` links as they are.
- **Your own website** — upload `index.html`, `style.css` and `app.js` to the same folder. Do not
  upload `Code.gs` (it is server-side Apps Script) or `requirement.txt` (it is the brief).

The Apps Script side needs no changes when the site moves: the Web App URL is absolute.

---

## 4. Data dictionary

Every row in `Raw_Responses` uses this fixed column order (defined in `HEADERS` in `Code.gs`).

| Column | Field | Values | Purpose |
|---|---|---|---|
| A | `timestamp` | ISO-8601 | When the event happened |
| B | `session_id` | UUID | Anonymous browser session |
| C | `event` | `session_start`, `mode_switch`, `red_submit`, `blue_check` | Which interaction |
| D | `mode` | `Red_Team`, `Blue_Team` | Active mode at the time |
| E | `dummy_name` | text | Dummy name (Red) or optional nickname (Blue) |
| F | `university` | text | Dummy university |
| G | `student_id_provided` | `Yes` / `No` | Matric field filled |
| H | `phone_provided` | `Yes` / `No` | Phone field filled |
| I | `security_q_provided` | `Yes` / `No` | Security question + answer filled |
| J | `password_trap_triggered` | `Yes` / `No` | PIN field used (**never the value**) |
| K | `time_taken_sec` | integer | First interaction → submit (the brief's `time_to_submit_seconds`) |
| L | `fields_filled_count` | 0–8 | How much of the form was completed |
| M | `hesitation_clicks` | integer | "Why is this needed?" + lock clicks |
| N | `awareness_score` | 0–100 | Blue Team quiz score |
| O | `user_verdict` | text | `completed red team lure`, `High awareness`, … |
| P | `prompt_category` | text | `business_strategy`, `programming`, `networking`, `custom` |

### Summary_Dashboard

Auto-built with live formulas, not static numbers:

- Total interactions, Red submissions, Blue checks, mode switches, unique participants.
- Per-field counts (`COUNTIF`) and share of Red submissions.
- Data exposure rate (`SUMPRODUCT` over the four sensitive flags).
- Most compromised field (`INDEX` + `MATCH` over the highest count).
- Average awareness score, average time to submit, average hesitation clicks (`AVERAGEIF`).

If the dashboard ever looks stale after manual sheet edits, run **EduAssist ▸ Rebuild summary
dashboard** (it clears and regenerates the formulas).

---

## 5. What the app deliberately does *not* do

- **No real passwords.** `readPasswordFlag()` in `app.js` reads the value, keeps only the length,
  and blanks the input before building the payload. The raw string never reaches state,
  `localStorage` or the network. The sheet only ever sees `Yes`/`No`.
- **No third-party analytics or fonts beyond Google Fonts / Tailwind CDN.** No tracking pixels.
- **No authentication.** This is a demo; the sheet endpoint accepts anonymous writes by design
  so participants can submit from their own phones. If you run it with a real cohort, consider
  rate-limiting or a shared secret in the payload.
- **Live model, with a fallback.** Answers come from `gemini-3.8-flash` through your Apps Script
  proxy, so the API key stays server-side. If the key is missing, quota is exhausted or the
  network fails, the helper silently falls back to hand-written teaching answers and labels the
  response *scripted fallback*.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Analytics shows *local log* even after submitting | URL empty or fetch blocked | Check `GOOGLE_SCRIPT_URL` ends in `/exec`; reload; open the drawer's **Refresh** |
| Answers say *scripted fallback* | No `GEMINI_API_KEY`, wrong key, or quota exhausted | Run **EduAssist ▸ Test live model**; check the error text it prints |
| `NO_API_KEY` in the Apps Script log | Property not saved on the deployment's project | Add `GEMINI_API_KEY` in **Project Settings ▸ Script properties** |
| Rows never appear in the sheet | Deployment access not set to **Anyone** | Manage deployments → edit → *Who has access: Anyone* → new version → deploy |
| `401` / "Script function not found" | You deployed the wrong project | Confirm the deployment points at the project containing `doPost` |
| Sheet has data, app shows demo data | Local log empty **and** JSONP blocked | The drawer falls back to demo only when both sources fail; check the browser console |
| CORS error in console | Apps Script does not send CORS headers on GET | Expected — the app retries automatically via JSONP |
| Mode switch resets the answer area | Intentional | Each mode re-asks the helper so answers are not carried across modes |
| `ReferenceError: GOOGLE_SCRIPT_URL` | `app.js` edited but not saved | Save and hard-reload (Ctrl+F5) |

---

## 7. Pushing changes

```powershell
git add -A
git commit -m "Describe the change"
git push
```

Deployment checklist for submission:

1. `GOOGLE_SCRIPT_URL` filled in and the sheet receiving rows.
2. `Summary_Dashboard` showing non-zero metrics.
3. Consent modal appears on a fresh session.
4. Red mode form → debrief works; Blue mode quiz → score works.
5. Repo pushed, Pages/site URL added to the report.
