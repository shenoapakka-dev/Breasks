# Care Response Grid (2099)

A standalone dashboard for the **Care mailbox** (`care@panhomestores.com`), separate from the
Call Center and Complaints dashboards. It visualizes customer-email response performance:
volume, response rate, response time (work hours), load per agent, and an SLA-breach count.

## Run it

Open `index.html` in a browser. No build step, no server — it's a single static file
(Chart.js is loaded from a CDN).

## Data

On first load it shows **simulated demo data** shaped like the real export.

To see real numbers:
1. Run `care_email_test.py` on a PC with Outlook (`pip install pywin32`, then
   `python care_email_test.py`). It produces `care_email_test_output.csv` next to the script.
2. In the dashboard, click **UPLOAD CSV** and pick that file. Everything is parsed and
   rendered client-side — nothing is uploaded anywhere.

Expected CSV columns (matches the script's output exactly):

```
received, from, subject, replied, action, reply_time, who_replied, work_mins
```

Click **RESET DEMO DATA** to go back to the simulated feed at any time.
