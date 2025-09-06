// Echo Flow API (Render-friendly) — saves Google tokens in /tmp
// ------------------------------------------------------------

const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

// ---------- config ----------
const PORT = process.env.PORT || 8080;
const TIMEZONE = process.env.TIMEZONE || "America/New_York"; // your local TZ
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID || "primary"; // or echoflw@gmail.com

// store Google tokens in /tmp (writable on Render; no Disk needed)
const TOKENS_PATH = path.join("/tmp", "echoflow-google-tokens.json");

// optional providers
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks use form-encoding

// health
app.get("/", (_req, res) => res.send("Echo Flow Booking API OK"));
app.get("/health", (_req, res) => res.send("ok"));

// simple gate for tool calls (optional)
app.use((req, res, next) => {
  if (req.path.startsWith("/oauth/") || req.path.startsWith("/twilio/") || req.path === "/" || req.path === "/health") {
    return next();
  }
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) return next(); // no secret set -> open
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

// ---------- booking endpoint ----------
app.post("/vapi/book", async (req, res) => {
  try {
    const {
      customer_name,
      customer_phone,
      customer_email,
      service = "Setup Demo",
      requested_start,
      duration_minutes = 30,
      notes = ""
    } = req.body || {};

    if (!customer_phone || !requested_start) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    // Google Calendar client
    const o = oauth();
    loadTokens(o);
    if (!o.credentials || !o.credentials.access_token) {
      return res.status(400).json({
        success: false,
        error: "oauth_not_connected",
        message: "Open /oauth/google/start and allow access first."
      });
    }
    const calendar = google.calendar({ version: "v3", auth: o });

    const startISO = new Date(requested_start).toISOString();
    const endISO = new Date(new Date(requested_start).getTime() + duration_minutes * 60000).toISOString();

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
        body: `✅ Echo Flow: You’re booked for ${whenText}\nService: ${service}\nReply STOP to opt out.`
      });
    }
    // SMS: owner
    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `📩 New booking\nWhen: ${whenText}\nService: ${service}\nName: ${customer_name || "Guest"}\nPhone: ${e164(
          customer_phone
        )}${customer_email ? `\nEmail: ${customer_email}` : ""}`
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
        text: `When: ${whenText}\nService: ${service}`,
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
    console.error(err);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
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
