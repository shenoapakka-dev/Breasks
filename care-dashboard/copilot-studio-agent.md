# Care Mailbox Agent — Microsoft Copilot Studio blueprint

## Why this path is more likely to get past IT than the earlier attempt

The Microsoft 365 connector we tried needed Entra **admin consent for a third-party OAuth app**
(this Claude connector) — that's what Pan Home IT declined.

Copilot Studio + Power Automate are **first-party Microsoft tools already inside your tenant**.
Building an agent there does not register a new external app, so it doesn't hit the same
admin-consent wall. What it still needs:

1. A **Copilot Studio / Power Platform maker license** for whoever builds it.
2. **Access to the shared mailbox** — either "Full Access" granted in the Exchange Admin Center,
   or (most likely already true) the builder already has delegate access to
   `care@panhomestores.com` in Outlook, the same way `care_email_test.py` reads it today.

If IT still says no to #2, ask specifically for "read access to the care@panhomestores.com
shared mailbox for Power Automate" rather than "an app" — it's a routine Exchange permission
grant, not a tenant-wide app approval.

> I have no access to Copilot Studio, Power Automate, or your Microsoft tenant from this
> session — someone with a maker seat in Pan Home has to actually build this. This file is the
> blueprint for them to follow (roughly 20–30 minutes of setup).

## What the agent should do

**Topic: "Check Care mailbox status"**
- Trigger phrases: "how's the care inbox", "any pending emails", "SLA status"
- Action: call the Power Automate flow below
- Responds with: total received, replied, pending, avg response time, SLA breaches, top agent

**Topic: "Daily Care summary"** (optional)
- Trigger: a Recurrence schedule in Power Automate (e.g. 9am daily)
- Posts the same KPIs as a Teams message or email, so the team doesn't have to open the
  dashboard to get the daily number

## Power Automate flow: `Get-Care-Mailbox-Status`

Trigger: Manual (called from Copilot Studio) or Recurrence.

1. **List emails (V2)** — Outlook connector, mailbox `care@panhomestores.com`, folder Inbox,
   filter `receivedDateTime ge {utcNow(-14,'Day')}`.
2. **Apply to each** email:
   - Skip it if the sender's domain is `panhomestores.com` (internal).
   - Check whether a reply exists: look up the message's `conversationId` in Sent Items from the
     shared mailbox, sent after `receivedDateTime`.
   - Compute the response time in **work minutes**, matching `work_minutes()` in
     `care_email_test.py` exactly: 08:30–17:00 workday, Sunday off, only business-day minutes
     counted. This is the one part too fiddly for a plain Power Automate expression — do it in an
     **Office Script** or **Azure Function** called from the flow, porting the same function
     (it's ~15 lines of straightforward date-looping code, already in this repo).
3. **Aggregate**: total received, total replied, SLA breaches (work-minutes > 480), counts and
   average response time per agent (by the Sent Items message's `From`).
4. Return the result as JSON shaped like `care_email_test_output.csv`'s columns (`received`,
   `from`, `subject`, `replied`, `action`, `reply_time`, `who_replied`, `work_mins`), so the
   existing dashboard, or a Copilot Studio Adaptive Card, can render it without changes.

## Keeping this in sync with the dashboard

Whoever builds the flow can reuse the exact SLA/working-hours rule already defined in
`care_email_test.py` (`WORK_START`, `WORK_END`, `DAY_OFF`, `work_minutes()`) so the agent's
numbers and the dashboard's numbers never drift apart. If the flow's output is saved back to
`care_email_test_output.csv` on a schedule, the dashboard's existing auto-refresh
(`serve_dashboard.py`, see the main README) picks it up automatically — no connector needed on
the dashboard's side at all.
