# Care Email Response Dashboard

A standalone dashboard for the **Care mailbox** (`care@panhomestores.com`), separate from the
Call Center and Complaints dashboards. It visualizes customer-email response performance:
volume, response rate, response time (work hours), per-agent KPIs, and an SLA-breach count.

## Why there's no "live" cloud connection

A direct Microsoft 365 / Outlook connector to `care@panhomestores.com` needs Pan Home IT to
grant admin consent for the app in the company's Entra (Azure AD) tenant. That request was
declined, so there is no way to pull live mailbox data from the cloud here. The setup below is
the closest practical substitute: fully automatic, but local to whichever PC has Outlook signed
into the shared mailbox.

## Option A — auto-refreshing (recommended)

1. On a PC where Outlook is open and signed into `care@panhomestores.com`:
   `pip install pywin32`, then `python care_email_test.py`. It writes
   `care_email_test_output.csv` next to itself.
   - Optional: schedule that command every 15–30 minutes with **Windows Task Scheduler** so the
     CSV keeps itself current without anyone running it by hand.
2. In the same folder, run `python serve_dashboard.py` (uses only Python's built-in
   `http.server` — nothing to install) and leave that window open.
3. Open **http://localhost:8787/** in your browser (not by double-clicking `index.html`).
   The dashboard fetches `care_email_test_output.csv` itself and refreshes every 60 seconds —
   the status bar at the top shows "Live CSV (auto-refresh)" and a green dot when this is working.

Nothing here touches the internet, Microsoft Graph, or needs any admin approval — it only reads
a file on the same machine over `localhost`.

## Option B — manual, no server

Just open `index.html` directly in a browser and click **Upload CSV** to pick a
`care_email_test_output.csv` you generated with `care_email_test.py`. Click **Reset demo data**
to go back to the simulated feed. Parsing happens entirely in the browser; nothing is uploaded
anywhere.

Expected CSV columns (matches the script's output exactly):

```
received, from, subject, replied, action, reply_time, who_replied, work_mins
```
