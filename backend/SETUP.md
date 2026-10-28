# Pan Home Cancel Desk — backend setup (Google Apps Script)

This gives the public page (`index.html`) a free, server-side home for its data,
with no Claude or Google account needed by employees — only you (the owner) do
this one-time setup.

## 1. Create the spreadsheet
1. Go to https://sheets.google.com and create a new blank spreadsheet.
2. Name it something like "Pan Home Cancel Desk DB".

## 2. Add the script
1. In the sheet, open **Extensions → Apps Script**.
2. Delete the placeholder code and paste the contents of `apps-script-backend.gs`
   (in this folder) in full.
3. Save the project (Ctrl/Cmd+S).

## 3. Run setup once
1. In the toolbar dropdown that lists functions, choose **setup**, then click **Run**.
2. The first run asks you to authorize the script — click through and allow it
   (it's your own script acting on your own sheet).
3. Check the spreadsheet: it should now have two tabs, **Users** and **Requests**,
   each with a header row.

## 4. Deploy as a web app
1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Set **Execute as**: Me. Set **Who has access**: **Anyone**.
4. Click **Deploy**, approve any permission prompts, then copy the **Web app URL**
   (it ends in `/exec`).
5. Send that URL back — it gets pasted into `index.html` as `API_URL`.

## Notes
- `APP_KEY` in the script must match `API_KEY` in `index.html` — they're already
  the same in both files as shipped. If you ever regenerate the key, change it in
  both places.
- If you later change the code in the Apps Script editor, you must create a
  **new deployment** (or "Manage deployments → Edit → New version") for the
  change to go live — editing the script alone does not update the running URL.
- This is deliberately simple, low-security auth (shared default password
  "12345", app key visible in the page's source) suited to an internal tool.
  Don't put highly sensitive data through it.
