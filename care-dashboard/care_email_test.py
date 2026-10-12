# -*- coding: utf-8 -*-
"""
Care Mailbox - Response Report (test script)   -   Pan Home
Reads the shared care mailbox through Outlook on this PC (read-only).
Lists recent customer emails and, for each, whether/when it was answered,
which team member answered, and the response time counted in work hours.

Setup once:  pip install pywin32
Run:         python care_email_test.py
"""

import csv
import datetime as dt

# ---------- SETTINGS ----------
SHARED_MAILBOX  = "care@panhomestores.com"   # shared mailbox as it shows in Outlook
INTERNAL_DOMAIN = "@panhomestores.com"       # anything else = customer
LAST_N          = 50
LOOKBACK_DAYS   = 14
WORK_START      = (8, 30)
WORK_END        = (17, 0)
DAY_OFF         = 6          # Mon=0 .. Sun=6  -> Sunday off
# ------------------------------

PR_SENDER_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F"
PR_VERB        = "http://schemas.microsoft.com/mapi/proptag/0x10810003"  # last action: reply/fwd
PR_VERB_TIME   = "http://schemas.microsoft.com/mapi/proptag/0x10820040"  # time of that action
PR_MODIFIER    = "http://schemas.microsoft.com/mapi/proptag/0x3FFA001F"  # who last changed the item
VERBS = {102: "Reply", 103: "Reply All", 104: "Forward"}


def get(pa, tag):
    try:
        return pa.GetProperty(tag)
    except Exception:
        return None


def to_local(pa, tag):
    v = get(pa, tag)
    if v is None:
        return None
    try:
        v = pa.UTCToLocalTime(v)
    except Exception:
        pass
    return dt.datetime(v.year, v.month, v.day, v.hour, v.minute, v.second)


def sender(item):
    a = get(item.PropertyAccessor, PR_SENDER_SMTP)
    if a:
        return str(a).lower()
    try:
        if item.SenderEmailType == "EX":
            return item.Sender.GetExchangeUser().PrimarySmtpAddress.lower()
    except Exception:
        pass
    return (item.SenderEmailAddress or "").lower()


def work_minutes(start, end):
    """Minutes between two times counted only on working days inside 08:30-17:00."""
    if not start or not end or end <= start:
        return 0
    ws = dt.time(*WORK_START)
    we = dt.time(*WORK_END)
    total = 0
    cur = start
    while cur < end:
        day_end = dt.datetime.combine(cur.date(), we)
        day_start = dt.datetime.combine(cur.date(), ws)
        if cur.weekday() != DAY_OFF:
            s = max(cur, day_start)
            e = min(end, day_end)
            if e > s:
                total += (e - s).total_seconds() / 60
        # jump to next day 00:00
        cur = dt.datetime.combine(cur.date() + dt.timedelta(days=1), dt.time(0, 0))
    return round(total)


def open_mailbox():
    import win32com.client
    ol = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
    # try to resolve the shared mailbox as a store/recipient
    try:
        rcp = ol.CreateRecipient(SHARED_MAILBOX)
        rcp.Resolve()
        return ol.GetSharedDefaultFolder(rcp, 6)  # 6 = Inbox
    except Exception:
        pass
    # fallback: find a store whose name matches
    for i in range(1, ol.Folders.Count + 1):
        f = ol.Folders.Item(i)
        if SHARED_MAILBOX.split("@")[0].lower() in f.Name.lower() or SHARED_MAILBOX.lower() in f.Name.lower():
            return f.Folders["Inbox"]
    raise SystemExit("Could not find the shared mailbox in Outlook. Edit SHARED_MAILBOX.")


def main():
    inbox = open_mailbox()
    items = inbox.Items
    items.Sort("[ReceivedTime]", True)
    cutoff = dt.datetime.now() - dt.timedelta(days=LOOKBACK_DAYS)

    rows, checked = [], 0
    for item in items:
        if checked >= LAST_N:
            break
        try:
            if item.Class != 43:      # 43 = MailItem
                continue
        except Exception:
            continue
        rt = item.ReceivedTime
        recv = dt.datetime(rt.year, rt.month, rt.day, rt.hour, rt.minute, rt.second)
        if recv < cutoff:
            break
        frm = sender(item)
        if INTERNAL_DOMAIN in frm:    # skip internal senders
            continue
        checked += 1

        pa = item.PropertyAccessor
        verb = get(pa, PR_VERB)
        replied = verb in VERBS
        reply_time = to_local(pa, PR_VERB_TIME) if replied else None
        who = get(pa, PR_MODIFIER) if replied else None
        rmins = work_minutes(recv, reply_time) if reply_time else None

        rows.append({
            "received":   recv.strftime("%Y-%m-%d %H:%M"),
            "from":       frm,
            "subject":    (item.Subject or "")[:50],
            "replied":    "yes" if replied else "NO",
            "action":     VERBS.get(verb, "") if replied else "",
            "reply_time": reply_time.strftime("%Y-%m-%d %H:%M") if reply_time else "",
            "who_replied": who or "",
            "work_mins":  rmins if rmins is not None else "",
        })

    # print
    print(f"\nChecked {checked} customer emails (last {LOOKBACK_DAYS} days)\n" + "-" * 70)
    for r in rows:
        print(f"{r['received']} | {r['from'][:28]:28} | {r['replied']:3} "
              f"| {r['who_replied'][:22]:22} | {str(r['work_mins']):>5} min | {r['subject']}")

    # save CSV next to the script
    out = "care_email_test_output.csv"
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else
                           ["received","from","subject","replied","action","reply_time","who_replied","work_mins"])
        w.writeheader()
        w.writerows(rows)
    print("-" * 70 + f"\nSaved: {out}")
    print("\nCHECK: does 'who_replied' show the right team member for each email?")


if __name__ == "__main__":
    main()
