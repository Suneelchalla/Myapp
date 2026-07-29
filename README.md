# Ripple — deploy guide

A mobile-first chat app. **Frontend** = static files (GitHub Pages). **Backend** = one Google Apps Script file talking to a Google Sheet.

There are only **two things you must fill in**: your admin password (backend) and your Web App URL (frontend).

---

## Part 1 — Backend (Google Apps Script)

1. Create a new Google Sheet (this is your database). Leave it empty.
2. In that sheet: **Extensions → Apps Script**.
3. Delete whatever code is there, paste the entire contents of **`backend/Code.gs`**, and click **Save**.
4. In the function dropdown (top toolbar) choose **`initializeProject`** → **Run**. Approve the permission prompt. This creates all 8 tabs and your secret keys.
5. Open the **`setAdminPassword`** function in the code. Change `ADMIN_PW` to a strong password, Save, then run **`setAdminPassword`** once. After it succeeds, set `ADMIN_PW` back to `''` and Save (so your password isn't sitting in the code). Admin username stays `Admin` unless you change it.
6. Run **`verifySetup`** and open **View → Logs** — everything should say `OK` / `SET`.
7. **Deploy → New deployment → Web app.**
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy**, authorise, and **copy the Web app URL** (ends in `/exec`).
8. Paste that `/exec` URL in a browser — you should see `{"success":true,...}`. That confirms the backend is live.

> Whenever you change the backend code, use **Deploy → Manage deployments → Edit → New version**, otherwise the old version keeps serving.

---

## Part 2 — Frontend (GitHub Pages)

1. Open **`frontend/js/config.js`** and paste your `/exec` URL into `API_URL`:
   ```js
   export const API_URL = "https://script.google.com/macros/s/AKfy...../exec";
   ```
2. Create a new **public** GitHub repository and upload **the contents of the `frontend/` folder** to the repo root (so `index.html` is at the top level, not inside a `frontend/` subfolder).
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` / root, Save.
4. Wait a minute, then open the Pages URL GitHub gives you (e.g. `https://yourname.github.io/ripple/`).
5. On a phone, use the browser's **Add to Home Screen** to install it as an app.

> When you update frontend files, also bump `CACHE_VERSION` in `service-worker.js` (e.g. `ripple-v2`) so devices pick up the new version.

---

## Using it

- **Register** an account, have your friends register too.
- Go to **Contacts**, search a username, send a request; they accept; now you can chat.
- **Admin:** on the sign-in screen tap **Admin sign in**, log in with `Admin` + your password to review reports and suspend/reactivate users.

## Notes & limits

- Messages feel live via polling (about every 2 seconds in an open chat), not instant push.
- Text + emoji only, up to 2000 characters. One-to-one chats.
- "Clear chat" removes messages from your device only; your contact keeps theirs.
- Built for a small group (a handful of active people). It's backed by a spreadsheet, so it's not meant for large scale.
