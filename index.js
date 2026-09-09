"use strict";

// Hydraciv Crew Portal — scheduled weekly timesheet email.
//
// One scheduled job, in Australia/Melbourne time:
//   mondayTimesheetEmail — 6am Monday: sends Grace & Andrew each crew member's
//   timesheet for the week that just finished, one email per crew member.
//
// The crew themselves are not emailed anything by this — only the office gets these.
//
// Emails are sent through EmailJS's REST API (the same account/template used for the
// instant "job logged" email in public/index.html). See SETUP-EMAIL.md for full setup
// instructions — creating the EmailJS account/template, upgrading to the Blaze plan, and
// deploying this function.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineString, defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const TIMEZONE = "Australia/Melbourne";
const OFFICE_EMAILS = ["grace@hydraciv.com.au", "andrew@hydraciv.com.au"];

// Non-secret EmailJS config — set these in functions/.env (see .env.example).
const EMAILJS_SERVICE_ID = defineString("EMAILJS_SERVICE_ID");
const EMAILJS_TEMPLATE_ID = defineString("EMAILJS_TEMPLATE_ID");
const EMAILJS_PUBLIC_KEY = defineString("EMAILJS_PUBLIC_KEY");
// Secret — set with: firebase functions:secrets:set EMAILJS_PRIVATE_KEY
const EMAILJS_PRIVATE_KEY = defineSecret("EMAILJS_PRIVATE_KEY");

// ---------- small date/format helpers (mirrors public/index.html) ----------
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function dateToStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function parseDateStr(s) { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function fmtDayLabel(s) { return parseDateStr(s).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); }
function fmtShortLabel(s) { return parseDateStr(s).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); }
function numHours(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// Cloud Functions run in UTC — this gives today's calendar date as seen in Melbourne.
function nowInMelbourne() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = +parts.find((p) => p.type === "year").value;
  const m = +parts.find((p) => p.type === "month").value;
  const d = +parts.find((p) => p.type === "day").value;
  return new Date(y, m - 1, d);
}
function getMonday(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff); }
function weekBounds(offsetWeeks) {
  const base = nowInMelbourne();
  const shifted = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetWeeks * 7);
  const mon = getMonday(shifted);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { startStr: dateToStr(mon), endStr: dateToStr(sun) };
}

// ---------- EmailJS ----------
async function sendViaEmailJS({ toEmail, ccEmail, subject, htmlBody }) {
  const payload = {
    service_id: EMAILJS_SERVICE_ID.value(),
    template_id: EMAILJS_TEMPLATE_ID.value(),
    user_id: EMAILJS_PUBLIC_KEY.value(),
    accessToken: EMAILJS_PRIVATE_KEY.value(),
    template_params: {
      to_email: toEmail,
      cc_email: ccEmail || "",
      subject: subject,
      html_body: htmlBody,
    },
  };
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EmailJS send failed (${res.status}): ${text}`);
  }
}

// Same visual shell as the instant-email in public/index.html, so every Hydraciv email matches.
function brandedEmailShell({ header, body }) {
  return (
    '<div style="background:#eef2f2;padding:24px 12px;font-family:\'Segoe UI\',-apple-system,Roboto,sans-serif;color:#16222b;">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #ccd7da;border-radius:10px;overflow:hidden;">' +
        '<div style="background:#123f5c;color:#eef6fb;padding:20px 24px;">' +
          '<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9fcbe3;margin:0 0 6px;font-family:monospace;">Hydraciv &middot; Crew Portal</div>' +
          header +
        "</div>" +
        '<div style="padding:20px 24px;">' + body + "</div>" +
        '<div style="padding:14px 24px 18px;border-top:1px solid #e2e9eb;font-size:12px;color:#7d8d94;">Auto-generated from the Hydraciv Crew Portal.</div>' +
      "</div>" +
    "</div>"
  );
}

async function getActiveCrew() {
  const snap = await db.collection("crew").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.active !== false);
}

// ---------- Monday morning timesheet email, per crew member, sent only to Grace & Andrew ----------
// Note: this never emails the crew member's own address (it doesn't need one on file) —
// every timesheet email goes only to OFFICE_EMAILS above.
exports.mondayTimesheetEmail = onSchedule(
  { schedule: "0 6 * * 1", timeZone: TIMEZONE, secrets: [EMAILJS_PRIVATE_KEY] },
  async () => {
    const wk = weekBounds(-1); // the week that just finished (Mon–Sun)
    const crew = await getActiveCrew();
    if (!crew.length) return;

    const logsSnap = await db.collection("job-logs").where("date", ">=", wk.startStr).where("date", "<=", wk.endStr).get();
    const allLogs = logsSnap.docs.map((d) => d.data());

    for (const c of crew) {
      const mine = allLogs.filter((l) => (l.employees || []).includes(c.name));
      if (!mine.length) continue; // nothing logged — skip rather than send an empty timesheet
      mine.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const total = mine.reduce((s, l) => s + numHours(l.hours), 0);

      let rowsHtml = "";
      mine.forEach((l) => {
        rowsHtml +=
          "<tr>" +
          '<td style="padding:10px 0;border-bottom:1px solid #e2e9eb;vertical-align:top;white-space:nowrap;">' + esc(fmtDayLabel(l.date)) + "</td>" +
          '<td style="padding:10px 0;border-bottom:1px solid #e2e9eb;vertical-align:top;">' +
            '<div style="font-weight:700;">' + esc(l.venue || "") + "</div>" +
            (l.jobDescription ? '<div style="color:#55676f;font-size:12.5px;margin-top:1px;">' + esc(l.jobDescription) + "</div>" : "") +
            (!l.completed ? '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;margin-top:4px;background:#faedd6;color:#b5791c;">Follow-up needed</span>' : "") +
          "</td>" +
          '<td style="padding:10px 0;border-bottom:1px solid #e2e9eb;vertical-align:top;text-align:right;font-family:monospace;white-space:nowrap;font-weight:600;">' + esc(l.hours || "") + "</td>" +
          "</tr>";
      });

      const bodyHtml =
        '<div style="display:flex;justify-content:space-between;align-items:center;background:#e1edf3;border-radius:8px;padding:14px 16px;margin-bottom:18px;">' +
          '<div style="font-size:13px;color:#55676f;font-weight:600;text-transform:uppercase;letter-spacing:.03em;">Total hours this week</div>' +
          '<div style="font-size:26px;font-weight:800;color:#123f5c;font-family:monospace;">' + total.toFixed(1) + "h</div>" +
        "</div>" +
        '<table style="width:100%;border-collapse:collapse;font-size:13.5px;">' +
          "<tr>" +
            '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#7d8d94;padding:0 0 8px;border-bottom:2px solid #ccd7da;">Day</th>' +
            '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#7d8d94;padding:0 0 8px;border-bottom:2px solid #ccd7da;">Job</th>' +
            '<th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#7d8d94;padding:0 0 8px;border-bottom:2px solid #ccd7da;">Hours</th>' +
          "</tr>" +
          rowsHtml +
        "</table>";

      const headerHtml =
        '<h1 style="margin:0;font-size:24px;font-weight:800;color:#fff;">' + esc(c.name) + "</h1>" +
        '<p style="margin:6px 0 0;font-size:13.5px;color:#cfe6f4;">' + esc(fmtShortLabel(wk.startStr)) + " – " + esc(fmtShortLabel(wk.endStr)) + "</p>";

      const html = brandedEmailShell({ header: headerHtml, body: bodyHtml });

      try {
        // Sent only to the office — the crew member themselves is never a recipient.
        await sendViaEmailJS({
          toEmail: OFFICE_EMAILS.join(","),
          subject: c.name + "’s timesheet — " + fmtShortLabel(wk.startStr) + " to " + fmtShortLabel(wk.endStr),
          htmlBody: html,
        });
      } catch (err) {
        logger.error("mondayTimesheetEmail failed for " + c.name, err);
      }
    }
  }
);
