# EduAssist

A small teaching app for a university security tutorial. It shows a *quid pro quo* social
engineering attack and then the defensive counterpart, in one page.

- **Red Team** — a fake "free AI homework" helper. It gives a teaser answer and then asks
  for a student profile (name, matric, phone, date of birth, security question) to "unlock"
  the rest. Everything entered is dummy data by design.
- **Blue Team** — the same helper done safely: no profile required, red flags called out,
  and a short awareness check.

No framework, no build step, no dependencies.

## Files

| File | What |
|---|---|
| `index.html` | markup for both modes, consent gate, analytics drawer |
| `style.css` | theme tokens (Red/Blue) and components |
| `app.js` | behaviour, logging, consent, mode switch |
| `Code.gs` | Google Apps Script `doPost` endpoint that writes rows to a Sheet |

## Run it

Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000
```

Logging is optional. Set `GOOGLE_SCRIPT_URL` in `app.js` to your Apps Script web app URL;
with it empty the app runs local-only and keeps rows in `localStorage`.

## Where the data goes

`Code.gs` writes one row per event to `Raw_Responses`, and builds `Summary_Dashboard`
(totals, exposure rate, awareness score) and `Captured_Profiles` from it.

The password field never leaves the browser as text — only whether something was typed and
how long it was.

## Notes

The consent gate is part of the lesson: the simulation deliberately asks for data a real
service should never ask for, and the debrief explains why each field matters.
