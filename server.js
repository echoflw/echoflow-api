// server.js — Echo Flow (CommonJS, minimal & stable)
const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// --- SendGrid (email) ---
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// --- Twilio (sms) ---
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const path = require("path");      
const TOKENS_PATH = path.join("/tmp", "echoflow-google-tokens.json");

function getOAuth() {
  return new google.auth.OAuth2(
    process.env.GCAL_CLIENT_ID,
    process.env.GCAL_CLIENT_SECRET,
    process.env.GCAL_REDIRECT_URI
  );
}
function loadTokens(o) {
  try {
    o.setCredentials(JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")));
  } catch {}
}
function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

// --- Helpers ---
const e164 = (p) =>
  String(p).startsWith("+") ? String(p) : `+1${String(p).replace(/\\D/g, "")}`;

function buildICS({ uid, start, end, title, location, description }) {
  const pad = (n) => String(n).padStart(2, "0");
  const toIcs = (d) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(
      d.getUTCDate()
    )}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(
      d.getUTCSeconds()
    )}Z`;
  const esc = (s) =>
    String(s).replace(/([,;])/g, "\\$1").replace(/\\n/g, "\\n");

  return (
    "BEGIN:VCALENDAR\\n" +
    "VERSION:2.0\\n" +
    "PRODID:-//Echo Flow//EN\\n" +
    "METHOD:REQUEST\\n" +
    "BEGIN:VEVENT\\n" +
    `UID:${uid}\\n` +
    `DTSTAMP:${toIcs(new Date())}\\n` +
    `DTSTART:${toIcs(start)}\\n` +
    `DTEND:${toIcs(end)}\\n` +
    `SUMMARY:${esc(title)}\\n` +
    `LOCATION:${esc(location)}\\n` +
    `DESCRIPTION:${esc(description)}\\n` +
    "END:VEVENT\\n" +
    "END:VCALENDAR"
  );
}

// --- Healthcheck ---
app.get("/", (_req, res) => res.send("Echo Flow Booking API OK"));

// --- Require header for tool calls (keeps OAuth/Twilio routes open) ---
app.use((req, res, next) => {
  if (req.path.startsWith("/oauth/") || req.path.startsWith("/twilio/")) {
    return next();
  }
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) return next();
  if (req.get("x-app-secret") === secret) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// --- Google OAuth routes ---
app.get("/oauth/google/start", (_req, res) => {
  const o = getOAuth();
  const url = o.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const o = getOAuth();
    const code = String(req.query.code || "");
    const { tokens } = await o.getToken(code);
    saveTokens(tokens);
    res.send("Google Calendar connected. You can close this tab.");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error. Check server logs.");
  }
});

// --- Twilio inbound webhook (STOP/HELP) ---
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

// --- Booking endpoint (used by your Vapi tool) ---
app.post("/vapi/book", async (req, res) => {
  try {
    const {
      customer_name,
      customer_phone,
      customer_email,
      service = "Setup Demo",
      requested_start,
      duration_minutes = 30,
      notes = "",
    } = req.body || {};

    if (!customer_phone || !requested_start) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    // Google Calendar client
    const o = getOAuth();
    loadTokens(o);
    if (!o.credentials || !o.credentials.access_token) {
      return res.status(400).json({
        success: false,
        error: "oauth_not_connected",
        message: "Open /oauth/google/start and allow access first.",
      });
    }
    const calendar = google.calendar({ version: "v3", auth: o });

    const startISO = new Date(requested_start).toISOString();
    const endISO = new Date(
      new Date(requested_start).getTime() + duration_minutes * 60000
    ).toISOString();

    const summary = `${service}${customer_name ? ` - ${customer_name}` : ""}`;
    const description = [
      `Booked by Echo (Echo Flow).`,
      customer_name ? `Customer: ${customer_name}` : null,
      `Phone: ${customer_phone}`,
      customer_email ? `Email: ${customer_email}` : null,
      notes ? `Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join("\\n");

    const { data: event } = await calendar.events.insert({
      calendarId: "echoflw@gmail.com",
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO, timeZone: "America/New_York" },
        end: { dateTime: endISO, timeZone: "America/New_York" },
        attendees: customer_email ? [{ email: customer_email }] : undefined,
        location: "(online demo)",
      },
    });

    const whenText = new Date(startISO).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    // SMS: customer
    if (twilioClient && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: e164(customer_phone),
        from: process.env.TWILIO_FROM_NUMBER,
        body: `✅ Echo Flow: You’re booked for ${whenText}\\nService: ${service}\\nReply STOP to opt out.`,
      });
    }
    // SMS: owner
    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `📩 New booking\\nWhen: ${whenText} (ET)\\nService: ${service}\\nName: ${customer_name || "Guest"}\\nPhone: ${e164(customer_phone)}${customer_email ? `\\nEmail: ${customer_email}` : ""}`,
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
        description: `Appointment for ${customer_name || "Guest"} (${service}).`,
      });

      await sgMail.send({
        to: customer_email,
        from: {
          email: process.env.CONFIRM_FROM_EMAIL || "laith@echoflw.com",
          name: process.env.CONFIRM_FROM_NAME || "Echo Flow",
        },
        replyTo: process.env.CONFIRM_REPLY_TO || "laith@echoflw.com",
        subject: "✅ You’re booked at Echo Flow",
        text: `When: ${whenText} (ET)\\nService: ${service}`,
        html: `<p><b>You’re booked.</b></p><p>When: ${whenText} (ET)<br/>Service: ${service}</p>`,
        attachments: [
          {
            content: Buffer.from(ics, "utf8").toString("base64"),
            filename: "appointment.ics",
            type: "text/calendar",
            disposition: "attachment",
          },
        ],
      });
    }

    return res.json({
      success: true,
      event_id: event.id,
      start_time: startISO,
      end_time: endISO,
      timezone: "America/New_York",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
});

app.listen(PORT, () => console.log(`API up on :${PORT}`));
