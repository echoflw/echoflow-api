// server.js (CommonJS, super simple)
const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const PORT = process.env.PORT || 8080;

// --- SendGrid (optional) ---
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// --- Twilio (optional) ---
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// --- Google OAuth (Calendar) ---
const TOKENS_PATH = "/data/tokens.google.json"; // Render writable path
const oAuth2Client = new google.auth.OAuth2(
  process.env.GCAL_CLIENT_ID,
  process.env.GCAL_CLIENT_SECRET,
  process.env.GCAL_REDIRECT_URI
);
function loadTokens() {
  try { oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"))); } catch {}
}
function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}
loadTokens();
const gcal = () => google.calendar({ version: "v3", auth: oAuth2Client });

// --- App ---
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Simple gate for Vapi tool calls (optional)
app.use((req, res, next) => {
  if (req.path.startsWith("/twilio/") || req.path.startsWith("/oauth/")) return next();
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) return next();
  if (req.get("x-app-secret") === secret) return next();
  return res.status(401).json({ error: "unauthorized" });
});

app.get("/", (_req, res) => res.send("Echo Flow Booking API OK"));

// --- Google OAuth routes ---
app.get("/oauth/google/start", (_req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const { tokens } = await oAuth2Client.getToken(code);
    saveTokens(tokens);
    res.send("Google Calendar connected. You can close this tab.");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error. Check server logs.");
  }
});

// --- Twilio inbound (STOP/HELP) ---
app.post("/twilio/inbound", (req, res) => {
  const keyword = String((req.body?.Body || "").trim()).toUpperCase();
  if (["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
    return res.send("You’ve been opted out. Reply START to opt back in.");
  }
  if (keyword === "HELP") {
    return res.send("Echo Flow Support: laith@echoflw.com. Msg&Data rates may apply.");
  }
  return res.send("");
});

// --- Booking endpoint (used by Vapi tool) ---
app.post("/vapi/book", async (req, res) => {
  try {
    const {
      tenant_id = "echoflw",
      customer_name,
      customer_phone,
      customer_email,
      service = "Setup Demo",
      requested_start,
      duration_minutes = 30,
      notes = ""
    } = req.body || {};

    if (!customer_phone || !requested_start || !duration_minutes) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    // Ensure Google tokens exist
    if (!oAuth2Client.credentials || !oAuth2Client.credentials.access_token) {
      return res.status(400).json({ success: false, error: "oauth_not_connected", message: "Open /oauth/google/start and allow access first." });
    }

    const startISO = new Date(requested_start).toISOString();
    const endISO = new Date(new Date(requested_start).getTime() + duration_minutes * 60000).toISOString();

    // Create Calendar event on echoflw@gmail.com
    const calendarId = "echoflw@gmail.com"; // your calendar
    const summary = `${service}${customer_name ? ` - ${customer_name}` : ""}`;
    const description = [
      `Booked by Echo (Echo Flow).`,
      customer_name ? `Customer: ${customer_name}` : null,
      `Phone: ${customer_phone}`,
      customer_email ? `Email: ${customer_email}` : null,
      notes ? `Notes: ${notes}` : null
    ].filter(Boolean).join("\n");

    const cal = gcal();
    const { data: event } = await cal.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO, timeZone: "America/New_York" },
        end:   { dateTime: endISO,   timeZone: "America/New_York" },
        attendees: customer_email ? [{ email: customer_email }] : undefined,
        location: "(online demo)"
      }
    });

    const whenText = new Date(startISO).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

    // SMS to customer
    if (twilioClient && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: customer_phone.startsWith("+") ? customer_phone : `+1${customer_phone.replace(/\D/g,"")}`,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `✅ Echo Flow: You’re booked for ${whenText}\nService: ${service}\nReply STOP to opt out.`
      });
    }

    // SMS to owner
    if (twilioClient && process.env.OWNER_SMS && process.env.TWILIO_FROM_NUMBER) {
      await twilioClient.messages.create({
        to: process.env.OWNER_SMS,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `📩 New booking\nWhen: ${whenText} (ET)\nService: ${service}\nName: ${customer_name || "Guest"}\nPhone: ${customer_phone}${customer_email ? `\nEmail: ${customer_email}` : ""}`
      });
    }

    // Email to customer (optional)
    if (process.env.SENDGRID_API_KEY && customer_email) {
      const uid = event.id;
      const toIcs = (d) => {
        const pad = (n)=> String(n).padStart(2,"0");
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
      };
      const ics =
