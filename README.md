# Work Tracker

A simple, easy-to-read website for tracking the hours you work on each project,
with spreadsheets for expenses and costs, folders for your files, a calendar,
a dashboard, and a built-in AI Helper.

Designed to be easy to use: large text (with a text-size switch), big clearly
labelled buttons, plain language, and nothing is ever lost by accident —
everything you delete goes to the **Recycle Bin** and can be restored
(there is also an **Undo** button right after you delete something).

## What it does

| Page | What you can do |
|---|---|
| **Home** | Hours today / this week / this month, a chart of the last 2 weeks, hours per project, what's coming up, recent activity and recent files. |
| **My Hours** | Start/Stop stopwatch (keeps running even if you close the page), add hours by hand, change or delete past hours. |
| **Projects** | Create projects (with an optional hourly rate and colour). Each project gets its own folder with *Spreadsheets*, *Documents* and *Reports* inside. |
| **Calendar** | Month view showing hours worked each day and your reminders/appointments. |
| **Files & Folders** | Upload Word documents, Excel/CSV files, PDFs, pictures. Make folders, move, rename. Make editable spreadsheets (Expenses, Budget, Mileage or blank) that add up number columns automatically; download them as Excel. |
| **Reports** | Hours report (any dates, one or all projects) or a full project summary, as Word (.docx) or Excel (.xlsx). You always choose which folder it's saved in. |
| **Recycle Bin** | Restore anything you deleted. Restoring a project brings back its hours, calendar items, folders and files. |
| **Help** | Step-by-step answers in plain words. |
| **Ask the Helper** | An AI assistant (Claude) that can explain how to use the site, open pages for you, log hours, find files, read attached Word/Excel files, make spreadsheets, write custom reports and file them. If you don't say where something should be saved, it asks you first. |

## Running it

You need [Node.js](https://nodejs.org) version 22.9 or newer.

```bash
npm install
cp .env.example .env     # then edit .env (add your Anthropic API key, a password)
npm start
```

Then open http://localhost:3000 in your web browser.

- **AI Helper**: put your Anthropic API key in `ANTHROPIC_API_KEY`. Without it,
  everything else works and the Helper explains that it isn't switched on.
- **Password**: set `APP_PASSWORD` to require a password. Do this if the site
  is reachable from the internet.
- **Your data** lives in the `data/` folder (a database file plus your uploaded
  files). Back up that folder to back up everything. When hosting online, make
  sure `DATA_DIR` points at a persistent disk.

## For developers

- `server/` — Express app. `services.js` holds all the business logic (shared by
  the web pages and the AI Helper), `db.js` the SQLite schema (built-in
  `node:sqlite`), `reports.js` Word/Excel generation, `sheets.js` spreadsheet
  helpers, `assistant.js` the Claude tool-use loop.
- `public/` — the website: plain HTML/CSS and JavaScript modules, no build step.
- Deleting is always a soft delete: rows get `deleted_at` + a `delete_batch` id
  and one row in `trash`; restoring a batch brings back everything deleted together.
- `npm test` runs the tests (uses a temporary data folder and a fake AI client).
