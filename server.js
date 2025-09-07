// Echo Flow API (Render-friendly)
// ------------------------------------------------------------
const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

// ---------- config ----------
const PORT = process.env.PORT || 8080;
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID || "primary";

// store Google tokens in /tmp (writable on Render)
const TOKENS_PATH = path.join("/tmp", "echoflow-google-tokens.json");

// providers
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks use form-encoding

// Simple CORS (so browser tools don't time out)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-app-secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// health
app.get("/", (_req, res) => res.send("Echo Flow Booking API OK"));
app.get("/health", (_req, res) => res.send("ok"));

// gate for tool calls (require x-app-secret)
app.use((req, res, next) => {
  if (
    req.path.startsWith("/oauth/") ||
    req.path.startsWith("/twilio/") ||
    req.path.startsWith("/cron/") ||
    req.path === "/" ||
    req.path === "/health"
  ) {
    return next();
  }
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) return next(); // open if not set
  if (req.get("x-app-secret") === secret) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// ---------- Google OAuth helpers ----------
function oauth() {
  return new google.auth.OAuth2(
    process.env.GCAL_CLIENT_ID,
    process.env.GCAL_CLIENT_SECRET,
    process.env.GCAL_REDIRECT_URI
  );
}
function loadTokens(o) {
  try {
    const raw = fs.readFileSync(TOKENS_PATH, "utf8");
    o.setCredentials(JSON.parse(raw));
  } catch {}
}
function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.error("Failed to save tokens:", e.message);
  }
}

// OAuth routes
app.get("/oauth/google/start", (_req, res) => {
  const o = oauth();
  const url = o.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const o = oauth();
    const code = String(req.query.code || "");
    const { tokens } = await o.getToken(code);
    saveTokens(tokens);
    res.send("Google Calendar connected. You can close this tab.");
  } catch (e) {
    console.error("OAuth token exchange error:", e?.response?.data || e.message || e);
    res.status(500).send("OAuth error. Check server logs.");
  }
});

// ---------- utilities ----------
const e164 = (p) => {
  const digits = String(p).replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
};

function buildICS({ uid, start, end, title, location, description }) {
  const pad = (n) => String(n).padStart(2, "0");
  const toIcs = (d) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
      d.getUTCHours()
    )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const esc = (s) => String(s).replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Echo Flow//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${toIcs(new Date())}
DTSTART:${toIcs(start)}
DTEND:${toIcs(end)}
SUMMARY:${esc(title)}
LOCATION:${esc(location)}
DESCRIPTION:${esc(description)}
END:VEVENT
END:VCALENDAR`;
}

async function requireCalendar() {
  const o = oauth();
  loadTokens(o);
  if (!o.credentials || !(o.credentials.access_token || o.credentials.refresh_token)) {
    const err = new Error("oauth_not_connected");
    err.code = "oauth_not_connected";
    throw err;
  }
  return google.calendar({ version: "v3", auth: o });
}

async function isFree(calendar, startISO, endISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: TIMEZONE,
      items: [{ id: CALENDAR_ID }]
    }
  });
  const busy = (fb.data.calendars?.[CALENDAR_ID]?.busy) || [];
  return busy.length === 0;
}

// ---------- find slots ----------
app.post("/vapi/find-slots", async (req, res) => {
  try {
    const { startDateTimeISO, endDateTimeISO, slotDurationMin = 30 } = req.body || {};
    const calendar = await requireCalendar();

    const start = startDateTimeISO ? new Date(startDateTimeISO) : new Date();
    const end = endDateTimeISO ? new Date(endDateTimeISO) : new Date(Date.now() + 14 * 864e5);

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });
    const busy = (fb.data.calendars?.[CALENDAR_ID]?.busy) || [];

    const overlaps = (s, e) =>
      busy.some((b) => {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        return s < be && e > bs;
      });

    const slots = [];
    const stepMs = 30 * 60 * 1000;
    for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
      const d = new Date(t);
      const dow = d.getDay(); // 0 Sun .. 6 Sat
      const hr = d.getHours();
      if (dow === 0 || dow === 6) continue; // Mon–Fri only
      if (hr < 9 || hr >= 18) continue; // 9am–6pm
      const s = t;
      const e = t + slotDurationMin * 60 * 1000;
      if (!overlaps(s, e)) {
        slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), timezone: TIMEZONE });
      }
      if (slots.length >= 60) break;
    }

    res.json({ success: true, slots });
  } catch (err) {
    if (err.code === "oauth_not_connected") {
      return res.status(400).json({ success: false, error: "oauth_not_connected", message: "Open /oauth/google/start and allow access first." });
    }
    console.error("find-slots error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ---------- booking endpoint ----------
app.post("/vapi/book", async (req, res) => {
  try {
    const {
      customer_name,
      customer_phone,
      customer_email,
      service = "Setup with Laith — personalize your AI assistant (30-minute)",
      requested_start,
      duration_minutes = 30,
      notes = ""
    } = req.body || {};

    if (!customer_phone || !requested_start) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    const calendar = await requireCalendar();

    const startISO = new Date(requested_start).toISOString();
    const endISO = new Date(new Date(requested_start).getTime() + duration_minutes * 60000).toISOString();

    // ensure slot free (no double-book)
    const free = await isFree(calendar, startISO, endISO);
    if (!free) {
      return res.status(409).json({ success: false, error: "slot_unavailable" });
    }

    const summary = `${service}${customer_name ? ` - ${customer_name}` : ""}`;
    const description = [
      `Booked by Echo (Echo Flow).`,
      customer_name ? `Customer: ${customer_name}` : null,
      `Phone: ${customer_phone}`,
      customer_email ? `Email: ${customer_email}` : null,
      notes ? `Notes: ${notes}` : null
    ]
      .filter(Boolean)
      .join("\n");

    const { data: event } = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO, timeZone: TIMEZONE },
        end: { dateTime: endISO, timeZone: TIMEZONE },
        attendees: customer_email ? [{ email: customer_email }] : undefined,
        location: "(online demo)"
      }
    });

    const whenText = new Date(startISO).toLocaleString("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });

    // SMS: customer
    if (twilioClient && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: e164(customer_phone),
        from: process.env.TWILIO_FROM_NUMBER,
        body: `✅ Echo Flow: You’re booked for ${whenText} (${TIMEZONE})\nService: ${service}\nReply STOP to opt out.`
      });
    }
    // SMS: owner
    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body:
          `📩 New booking\nWhen: ${whenText} (${TIMEZONE})\nService: ${service}\n` +
          `Name: ${customer_name || "Guest"}\nPhone: ${e164(customer_phone)}` +
          (customer_email ? `\nEmail: ${customer_email}` : "")
      });
    }

    // Email: customer (optional)
    if (process.env.SENDGRID_API_KEY && customer_email) {
      const ics = buildICS({
        uid: event.id,
        start: new Date(startISO),
        end: new Date(endISO),
        title: `${service} - Echo Flow`,
        location: "(online demo)",
        description: `Appointment for ${customer_name || "Guest"} (${service}).`
      });

      await sgMail.send({
        to: customer_email,
        from: {
          email: process.env.CONFIRM_FROM_EMAIL || "laith@echoflw.com",
          name: process.env.CONFIRM_FROM_NAME || "Echo Flow"
        },
        replyTo: process.env.CONFIRM_REPLY_TO || "laith@echoflw.com",
        subject: "✅ You’re booked at Echo Flow",
        text: `When: ${whenText} (${TIMEZONE})\nService: ${service}`,
        html: `<p><b>You’re booked.</b></p><p>When: ${whenText} (${TIMEZONE})<br/>Service: ${service}</p>`,
        attachments: [
          {
            content: Buffer.from(ics, "utf8").toString("base64"),
            filename: "appointment.ics",
            type: "text/calendar",
            disposition: "attachment"
          }
        ]
      });
    }

    return res.json({
      success: true,
      event_id: event.id,
      start_time: startISO,
      end_time: endISO,
      timezone: TIMEZONE
    });
  } catch (err) {
    if (err.code === "oauth_not_connected") {
      return res.status(400).json({
        success: false,
        error: "oauth_not_connected",
        message: "Open /oauth/google/start and allow access first."
      });
    }
    console.error("book error:", err);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ---------- reschedule ----------
app.post("/vapi/reschedule", async (req, res) => {
  try {
    const { appointmentId, newStartDateTimeISO, duration_minutes = 30, notes = "" } = req.body || {};
    if (!appointmentId || !newStartDateTimeISO) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    const calendar = await requireCalendar();
    const startISO = new Date(newStartDateTimeISO).toISOString();
    const endISO = new Date(new Date(newStartDateTimeISO).getTime() + duration_minutes * 60000).toISOString();

    const free = await isFree(calendar, startISO, endISO);
    if (!free) return res.status(409).json({ success: false, error: "slot_unavailable" });

    const { data: event } = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: appointmentId,
      requestBody: {
        start: { dateTime: startISO, timeZone: TIMEZONE },
        end: { dateTime: endISO, timeZone: TIMEZONE },
        description: notes || undefined
      }
    });

    const whenText = new Date(startISO).toLocaleString("en-US", {
      timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `🔁 Rescheduled booking\nEvent: ${appointmentId}\nNew: ${whenText} (${TIMEZONE})`
      });
    }

    res.json({ success: true, event_id: event.id, start_time: startISO, end_time: endISO, timezone: TIMEZONE });
  } catch (err) {
    if (err.code === "oauth_not_connected") {
      return res.status(400).json({ success: false, error: "oauth_not_connected" });
    }
    console.error("reschedule error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ---------- cancel ----------
app.post("/vapi/cancel", async (req, res) => {
  try {
    const { appointmentId, reason = "" } = req.body || {};
    if (!appointmentId) return res.status(400).json({ success: false, error: "missing_fields" });

    const calendar = await requireCalendar();
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: appointmentId });

    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `❌ Booking cancelled\nEvent: ${appointmentId}${reason ? `\nReason: ${reason}` : ""}`
      });
    }

    res.json({ success: true });
  } catch (err) {
    if (err.code === "oauth_not_connected") {
      return res.status(400).json({ success: false, error: "oauth_not_connected" });
    }
    console.error("cancel error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ---------- send message ----------
app.post("/vapi/send-message", async (req, res) => {
  try {
    const { channel, to, message, subject = "Echo Flow" } = req.body || {};
    if (channel === "sms") {
      if (!twilioClient || !process.env.TWILIO_FROM_NUMBER)
        return res.status(400).json({ success: false, error: "twilio_not_configured" });
      await twilioClient.messages.create({ to: e164(to), from: process.env.TWILIO_FROM_NUMBER, body: message });
      return res.json({ success: true });
    }
    if (channel === "email") {
      if (!process.env.SENDGRID_API_KEY || !process.env.CONFIRM_FROM_EMAIL)
        return res.status(400).json({ success: false, error: "sendgrid_not_configured" });
      await sgMail.send({
        to,
        from: { email: process.env.CONFIRM_FROM_EMAIL, name: process.env.CONFIRM_FROM_NAME || "Echo Flow" },
        replyTo: process.env.CONFIRM_REPLY_TO || process.env.CONFIRM_FROM_EMAIL,
        subject,
        text: message,
        html: `<p>${message}</p>`
      });
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: "invalid_channel" });
  } catch (err) {
    console.error("send-message error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ---------- handoff ----------
app.post("/vapi/handoff", (_req, res) => {
  res.json({ success: true, phone: process.env.OWNER_SMS || "+18139229004" });
});

// ---------- Twilio voice fallback: forward to Laith ----------
app.all("/twilio/voice-fallback", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const dial = vr.dial({ callerId: process.env.TWILIO_FROM_NUMBER, timeout: 30, record: "record-from-answer-dual" });
  dial.number(process.env.OWNER_SMS || "+18139229004");
  res.type("text/xml").send(vr.toString());
});

// ---------- Twilio inbound (STOP/HELP) ----------
app.post("/twilio/inbound", (req, res) => {
  const body = String(req.body?.Body || "").trim().toUpperCase();
  if (["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(body)) {
    return res.send("You’ve been opted out. Reply START to opt back in.");
  }
  if (body === "HELP") {
    return res.send("Echo Flow Support: laith@echoflw.com. Msg&Data rates may apply.");
  }
  return res.send("");
});

// ---------- start ----------
app.listen(PORT, () => console.log(`API up on :${PORT}`));

