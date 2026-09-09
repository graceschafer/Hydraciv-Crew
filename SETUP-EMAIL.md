# Setting up email: instant job emails, reminders & timesheets

This covers the last bit of wiring needed to turn on:

1. **Instant email** to the office the moment any job sheet is submitted or updated (already wired into `public/index.html` — just needs your EmailJS keys).
2. **4pm reminder** (Mon–Fri) to any crew member who hasn't logged a job that day.
3. **Sunday reminder** (5pm) — a polite nudge to everyone to make sure the week's jobs are all logged.
4. **Monday timesheet email** (6am) — each crew member gets their own weekly timesheet, cc'd to `grace@hydraciv.com.au` and `andrew@hydraciv.com.au`.

Steps 2–4 run on a schedule with no browser open, so they live in Firebase Cloud Functions (`functions/`) rather than in the app itself. That needs the Firebase project on the **Blaze (pay-as-you-go)** plan — see below; at this volume of email it should cost nothing or close to it, Cloud Scheduler's free tier covers the first 3 jobs and we use exactly 3.

Nothing here is deployed yet — this is a checklist to run through once.

## 1. Create an EmailJS account

1. Go to [emailjs.com](https://www.emailjs.com) and sign up (the free tier — 200 emails/month — is plenty to start; upgrade later if the crew grows).
2. **Add an email service**: Email Services → Add New Service. Easiest is to connect the Gmail or Outlook account Hydraciv already sends mail from, or use SMTP if you have `@hydraciv.com.au` email hosting. Note the **Service ID** it gives you.
3. **Create one template**: Email Templates → Create New Template. This one template is reused for every email type (instant job, reminders, timesheet) — the app sends fully-formed HTML, so the template itself just needs to pass it through:
   - **To email**: `{{to_email}}`
   - **CC**: `{{cc_email}}` (leave blank when unused — that's fine)
   - **Subject**: `{{subject}}`
   - **Content**: switch the editor to raw HTML/code view and set the entire body to `{{{html_body}}}` — note the **triple** braces, which tells EmailJS not to HTML-escape it.
   - Save, and note the **Template ID**.
4. **Get your keys**: Account → General.
   - **Public Key** — used client-side in `public/index.html`.
   - **Private Key** — used server-side only, in Cloud Functions. Never put this in `public/index.html` or commit it to git.
5. Recommended: Account → Security → restrict the Public Key to your site's domain (e.g. `hydraciv-crew.web.app` / `hydraciv-crew.firebaseapp.com` / your custom domain) so it can't be used from elsewhere.

## 2. Wire the instant job email (client-side)

Open `public/index.html`, find this block near the top of the `<script>` (search for `EMAILJS_PUBLIC_KEY`), and fill in your real values:

```js
var EMAILJS_PUBLIC_KEY  = "YOUR_EMAILJS_PUBLIC_KEY";
var EMAILJS_SERVICE_ID  = "YOUR_EMAILJS_SERVICE_ID";
var EMAILJS_TEMPLATE_ID = "YOUR_EMAILJS_TEMPLATE_ID";
var EMAILJS_OFFICE_EMAIL = "grace@hydraciv.com.au";
```

Commit and push to `main` — the existing GitHub Action deploys hosting automatically. That's it for instant emails; every job sheet submitted or updated will email `grace@hydraciv.com.au`.

## 3. Upgrade the Firebase project to Blaze

Scheduled Cloud Functions need Cloud Scheduler, which requires billing to be enabled on the project (even though usage here should stay in the free tier):

1. [console.firebase.google.com/project/hydraciv-crew/usage/details](https://console.firebase.google.com/project/hydraciv-crew/usage/details) → **Modify plan** → choose **Blaze**.
2. Add a billing account/card if the project doesn't have one yet.

## 4. Deploy the scheduled functions

From your machine (this can't be done from here since it needs your Firebase login and billing account):

```bash
npm install -g firebase-tools      # if you don't have it
firebase login
cd hydraciv-crew-repo/functions
npm install
```

Set the config the functions need. The three non-secret values go in `functions/.env` (copy `functions/.env.example`, gitignored so it never gets committed):

```
EMAILJS_SERVICE_ID=...
EMAILJS_TEMPLATE_ID=...
EMAILJS_PUBLIC_KEY=...
```

The private key is a secret, set separately (it'll prompt you to paste it):

```bash
firebase functions:secrets:set EMAILJS_PRIVATE_KEY
```

Then deploy, from the repo root:

```bash
firebase deploy --only functions
```

That creates three scheduled jobs (all in Australia/Melbourne time):

| Function | Schedule | What it does |
|---|---|---|
| `dailyLogReminder` | 4pm, Mon–Fri | Emails anyone with no job-log dated today |
| `sundayLogReminder` | 5pm, Sunday | Polite reminder to everyone to log any outstanding jobs |
| `mondayTimesheetEmail` | 6am, Monday | Sends each crew member last week's timesheet, cc'd to Grace & Andrew |

## 5. Test before trusting it

- In the Firebase Console → Functions, each scheduled function has a matching entry in **Cloud Scheduler** — open it and hit **Force run** to trigger one immediately rather than waiting for the schedule, then check your inbox and the function's logs.
- Check `Firestore` has crew with an `email` field set — the Crew tab in Management already flags anyone missing one ("No email — reminders won't reach them").
- If a send fails, it'll show up in Functions → Logs with the EmailJS error message.

## Notes

- Redeploying `functions` only happens via the Firebase CLI above — the GitHub Action currently only deploys **hosting**, not functions. If you'd like pushes to `main` to also deploy functions automatically, that's a small addition to `.github/workflows/firebase-deploy.yml` (needs a service account with Cloud Functions deploy permission) — just ask.
- Separately, worth knowing: `firestore.rules` in this repo is still the placeholder `allow read, write: if false` for everything, and `firebase.json` doesn't deploy Firestore rules at all yet — so whatever rules are actually protecting your data live directly in the Firebase Console, not in this repo. Not something this email setup touches, but worth locking down properly before go-live.
