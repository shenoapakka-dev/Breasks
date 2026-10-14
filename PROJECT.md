# Care Email Response Dashboard — Project Overview

A dashboard that tracks how fast Pan Home's Care team (`care@panhomestores.com`) responds to
customer emails: volume, response rate, response time in work hours, SLA breaches, and
per-agent performance. It's deliberately separate from the existing Call Center and Complaints
dashboards — different mailbox, different team, different metrics.

Everything lives under [`care-dashboard/`](./care-dashboard/).

## Files

| File | What it is |
|---|---|
| `care-dashboard/index.html` | The dashboard itself. Single static HTML file, no build step. Opens straight in a browser. |
| `care-dashboard/care_email_test.py` | Reads the shared mailbox through Outlook on a Windows PC (via `pywin32`) and writes `care_email_test_output.csv`. This is the only piece that touches real email data. |
| `care-dashboard/serve_dashboard.py` | A one-file local HTTP server (stdlib only). Lets the dashboard auto-fetch the CSV and refresh itself every 60s — see "Getting live data" below. |
| `care-dashboard/README.md` | Setup instructions (the two data options, expected CSV columns). |
| `care-dashboard/copilot-studio-agent.md` | Blueprint for rebuilding the live-data piece as a Microsoft Copilot Studio agent instead, since that may avoid the IT approval that blocked the direct connector (see below). |

## What the dashboard shows

- **KPIs**: response rate, average response time (work hours), total emails received, SLA
  breach rate (>8 work-hours), each with a trend delta.
- **Response funnel**: Received → Replied → Within SLA → Fast reply (≤1h), with the conversion
  rate at each stage.
- **Agent performance table**: per agent — emails handled, share of total replies, average
  response time, SLA compliance (color-coded), fastest reply.
- **Trend charts**: daily received-vs-replied volume, and response-rate/SLA-breach-rate over
  time.
- **Transmission log**: the full filtered list of emails with their status.
- **Filters**: date range, agent, status (replied/pending), free-text search.

All computation (the work-hours SLA math, the funnel, the per-agent stats) happens client-side
in the browser from whatever data is loaded — nothing is sent to a server.

## Getting live data

There's no live cloud connection to the mailbox (see "Why no live connector" below). Instead:

- **Option A — auto-refreshing (recommended)**: run `care_email_test.py` on a PC where Outlook
  is signed into the shared mailbox (optionally on a schedule via Windows Task Scheduler), then
  run `serve_dashboard.py` and open `http://localhost:8787/`. The dashboard fetches the CSV
  itself and re-renders every 60 seconds — a status bar shows "Live CSV (auto-refresh)" with a
  green dot when it's working. Nothing leaves the machine; no internet or connector involved.
- **Option B — manual**: open `index.html` directly and click **Upload CSV** to load a
  `care_email_test_output.csv` you generated separately. Click **Reset demo data** to go back to
  the built-in simulated feed.

Full details, including the exact CSV column names, are in `care-dashboard/README.md`.

## Why no live cloud connector

A direct connection from this dashboard to `care@panhomestores.com` via Microsoft 365/Outlook
was attempted using a Microsoft 365 connector. Connecting it requires **Entra (Azure AD) admin
consent** for the app in Pan Home's tenant, since it's a third-party integration. That request
was submitted and **declined by IT**, so that path is closed.

The suggested alternative is `care-dashboard/copilot-studio-agent.md`: building this as a
**Microsoft Copilot Studio agent** instead. Copilot Studio and Power Automate are first-party
Microsoft tools already inside the Pan Home tenant, so building there doesn't register a new
external app and likely sidesteps the same admin-consent requirement — it would instead need a
Copilot Studio maker license and (probably already-granted) access to the shared mailbox. That
file has the full blueprint: the topics, the Power Automate flow, and the exact SLA logic to
port from `care_email_test.py` so the two stay in sync.

## Design notes

The dashboard went through two visual passes:
1. An initial "2099" cyberpunk/neon theme (dark, glowing, monospace).
2. The current clean analytics look — light background, gradient KPI cards, a funnel chart —
   matching the visual language of tools like Coupler.io's Mailchimp dashboard, at the user's
   request.

Both the standalone file (`care-dashboard/index.html`, committed to this repo) and a published
Claude Artifact copy are kept in sync; the Artifact is for quick viewing/sharing, the repo file
is the one meant to live on a Pan Home machine long-term.
