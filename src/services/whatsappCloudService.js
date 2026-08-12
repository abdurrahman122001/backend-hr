// services/whatsappCloudService.js
// WhatsApp Business Cloud API (Meta Graph) — the real WhatsApp number.
//
// This is the WhatsApp twin of clientEmailService/emailReceiverService: inbound
// messages arrive on the Meta webhook instead of IMAP, and approved replies go
// out through the Graph API instead of SMTP. Client matching follows the same
// rule as email — client level first, then the businesses, then their contacts.
const crypto = require("crypto");
const axios = require("axios");
const ClientInfo = require("../models/ClientInfo");

const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

function getConfig() {
  return {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  };
}

// Sending needs credentials; receiving only needs the verify token, so the
// webhook can be wired up and tested before the access token exists.
function canSend() {
  const { accessToken, phoneNumberId } = getConfig();
  return Boolean(accessToken && phoneNumberId);
}

/**
 * Meta signs the RAW request body with the app secret and sends the digest in
 * `X-Hub-Signature-256`. The webhook router keeps the body as a Buffer for this
 * reason — re-serialising a parsed object changes the bytes and breaks the HMAC.
 */
function verifySignature(rawBody, signatureHeader) {
  const { appSecret } = getConfig();
  // No secret configured yet → skip verification rather than reject everything,
  // so the Meta dashboard handshake still works during setup.
  if (!appSecret) return { ok: true, skipped: true };
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "missing X-Hub-Signature-256 header" };
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/** "+92 300 123-4567" / "0092..." → "923001234567" */
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

/**
 * Numbers are typed by hand into ClientInfo, so the stored form rarely matches
 * the wa_id byte for byte ("0300-1234567" vs "923001234567"). Treat them as the
 * same number when the digits are equal or one ends with the other, with at
 * least 9 digits of overlap — enough to keep two different subscribers apart
 * while tolerating a missing country code or a leading national 0.
 */
const MIN_SUFFIX_MATCH = 9;

/**
 * A number written nationally ("0300-1234567") carries a trunk 0 exactly where
 * the wa_id carries its country code, so the suffix test only lines up once
 * that 0 is dropped. Compare both forms of each side.
 */
function phoneForms(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return [];
  const forms = [digits];
  const trunkless = digits.replace(/^0+/, "");
  if (trunkless && trunkless !== digits) forms.push(trunkless);
  return forms;
}

/**
 * @returns {"exact"|"suffix"|null} how strongly two numbers match.
 */
function matchStrength(a, b) {
  let best = null;
  for (const x of phoneForms(a)) {
    for (const y of phoneForms(b)) {
      if (x === y) return "exact";
      const [longer, shorter] = x.length >= y.length ? [x, y] : [y, x];
      if (shorter.length < MIN_SUFFIX_MATCH) continue;
      if (longer.endsWith(shorter)) best = "suffix";
    }
  }
  return best;
}

function phonesMatch(a, b) {
  return matchStrength(a, b) !== null;
}

const CLIENT_FIELDS =
  "_id owner clientName clientEmail clientPhone assignedTo companyEmployees businesses supervision";

/**
 * Resolve an inbound wa_id to a client, mirroring emailReceiverService's
 * findClientByEmail: the client's own number, then a business number, then a
 * contact under a business, then the legacy client-level contacts.
 *
 * Phone strings are free-form, so this compares in JS over a lean projection
 * rather than querying — an exact-match query would miss almost every record.
 *
 * @returns {{client, clientEmployee}|null}
 */
async function findClientByPhone(waId) {
  const incoming = normalizePhone(waId);
  if (!incoming) return null;

  // No populate: the callers only need the raw owner/assignedTo ids, and
  // populating from a webhook would couple inbound delivery to every referenced
  // model being registered first.
  const clients = await ClientInfo.find({}).select(CLIENT_FIELDS).exec();

  // Collect EVERY candidate rather than returning the first hit. Returning
  // early made the result depend on collection order, so a loose suffix match
  // on an unrelated client could win over the exact owner of the number — i.e.
  // deliver a client's message to the wrong team.
  const candidates = [];
  const consider = (client, strength, clientEmployee) => {
    if (strength) candidates.push({ client, strength, clientEmployee });
  };

  for (const client of clients) {
    consider(client, matchStrength(client.clientPhone, incoming), {
      name: client.clientName,
      phone: client.clientPhone,
      isPrimaryContact: true,
      clientId: client._id,
    });

    for (const business of client.businesses || []) {
      consider(client, matchStrength(business.phone, incoming), {
        name: business.businessName || client.clientName,
        phone: business.phone,
        isPrimaryContact: true,
        clientId: client._id,
        businessId: business._id,
      });

      for (const contact of business.companyEmployees || []) {
        consider(client, matchStrength(contact.phone, incoming), {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          designation: contact.designation,
          department: contact.department,
          isPrimaryContact: contact.isPrimaryContact || false,
          clientId: client._id,
          businessId: business._id,
        });
      }
    }

    for (const contact of client.companyEmployees || []) {
      consider(client, matchStrength(contact.phone, incoming), {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        designation: contact.designation,
        department: contact.department,
        isPrimaryContact: contact.isPrimaryContact || false,
        clientId: client._id,
      });
    }
  }

  if (candidates.length === 0) return null;

  // An exact match always beats a suffix match, however many suffix hits exist.
  const exact = candidates.filter((c) => c.strength === "exact");
  const pool = exact.length > 0 ? exact : candidates;

  // Still ambiguous across DIFFERENT clients → refuse. Mis-routing a client's
  // message to another client's team is worse than not routing it at all, and
  // the log names the numbers to clean up.
  const distinctClients = new Set(pool.map((c) => String(c.client._id)));
  if (distinctClients.size > 1) {
    console.error(
      `❌ [WhatsAppCloud] ${incoming} matches ${distinctClients.size} different clients (${pool
        .map((c) => `${c.client.clientName}:${c.clientEmployee.phone}`)
        .join(", ")}) — refusing to route. Fix the duplicate numbers.`,
    );
    return null;
  }

  return { client: pool[0].client, clientEmployee: pool[0].clientEmployee };
}

function graphUrl(path) {
  const { phoneNumberId } = getConfig();
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/${path}`;
}

function authHeaders() {
  const { accessToken } = getConfig();
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Send a free-form text message from the company number.
 *
 * NOTE: Meta only allows free-form messages inside the 24-hour customer service
 * window (24h from the client's last inbound message). Outside it the API
 * rejects the send and an approved message template must be used instead —
 * which matters here because hierarchy approval can outlast the window.
 */
async function sendText({ to, body, replyToWaMessageId }) {
  if (!canSend()) {
    return { sent: false, skipped: "WhatsApp Cloud API not configured" };
  }
  if (!to || !body) {
    return { sent: false, skipped: "missing recipient or body" };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    // `context` is what makes WhatsApp render the quoted bubble above the
    // message. Without it a reply arrives as an unrelated new message.
    ...(replyToWaMessageId ? { context: { message_id: replyToWaMessageId } } : {}),
    type: "text",
    text: { preview_url: false, body },
  };

  try {
    const { data } = await axios.post(graphUrl("messages"), payload, {
      headers: authHeaders(),
      timeout: 30000,
    });
    const waMessageId = data?.messages?.[0]?.id || null;
    console.log(`✅ [WhatsAppCloud] Sent to ${payload.to} (wamid: ${waMessageId})`);
    return { sent: true, to: payload.to, waMessageId };
  } catch (error) {
    const details = error.response?.data?.error;
    console.error(
      `❌ [WhatsAppCloud] Send to ${payload.to} failed:`,
      details || error.message,
    );
    return { sent: false, error: details?.message || error.message, details };
  }
}

// What the Cloud API will accept per message type. Anything absent here cannot
// be sent as that type — notably audio/webm, which is what browser MediaRecorder
// produces and WhatsApp refuses.
// Verified against the API's own rejection message, not just the docs.
const SENDABLE_TYPES = {
  audio: [
    "audio/aac",
    "audio/amr",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/opus",
  ],
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/3gpp"],
  sticker: ["image/webp"],
};

/**
 * Pick the WhatsApp message type for a file. Documents are the catch-all: the
 * API takes any mime type there, so a file we cannot send as rich media still
 * reaches the client as an attachment.
 */
function whatsappTypeFor(mimeType) {
  const mime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  for (const [type, accepted] of Object.entries(SENDABLE_TYPES)) {
    if (accepted.includes(mime)) return type;
  }
  return "document";
}

/**
 * Upload a file to Meta and get back a media id, which is what the send
 * endpoint takes (there is no "send this URL" option for outbound media).
 */
async function uploadMedia({ buffer, mimeType, filename }) {
  if (!canSend()) {
    return { ok: false, error: "WhatsApp Cloud API not configured" };
  }
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([buffer], { type: mimeType }), filename);

    const res = await fetch(graphUrl("media"), {
      method: "POST",
      headers: { Authorization: `Bearer ${getConfig().accessToken}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok || !data.id) {
      return { ok: false, error: data?.error?.message || `upload failed (${res.status})` };
    }
    return { ok: true, mediaId: data.id };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Send an already-uploaded media file to the client. */
async function sendMedia({ to, type, mediaId, caption, filename, replyToWaMessageId }) {
  if (!canSend()) {
    return { sent: false, skipped: "WhatsApp Cloud API not configured" };
  }
  const media = { id: mediaId };
  // Only documents carry a filename, and only document/image/video take captions
  // — sending a caption on audio is rejected.
  if (type === "document" && filename) media.filename = filename;
  if (caption && type !== "audio") media.caption = caption;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    ...(replyToWaMessageId ? { context: { message_id: replyToWaMessageId } } : {}),
    type,
    [type]: media,
  };

  try {
    const { data } = await axios.post(graphUrl("messages"), payload, {
      headers: authHeaders(),
      timeout: 60000,
    });
    const waMessageId = data?.messages?.[0]?.id || null;
    console.log(`✅ [WhatsAppCloud] Sent ${type} to ${payload.to} (wamid: ${waMessageId})`);
    return { sent: true, to: payload.to, waMessageId };
  } catch (error) {
    const details = error.response?.data?.error;
    console.error(
      `❌ [WhatsAppCloud] Send ${type} to ${payload.to} failed:`,
      details || error.message,
    );
    return { sent: false, error: details?.message || error.message };
  }
}

/**
 * Fetch an inbound media file (voice note, photo, document…).
 *
 * Two hops, and the second one still needs the bearer token: Meta hands back a
 * lookaside URL that returns 401 without it, which is the usual reason a
 * downloaded WhatsApp file turns out to be an error page.
 *
 * @returns {{ok: boolean, buffer?: Buffer, mimeType?: string, error?: string}}
 */
async function downloadMedia(mediaId) {
  if (!canSend()) return { ok: false, error: "WhatsApp Cloud API not configured" };
  if (!mediaId) return { ok: false, error: "no media id" };

  try {
    const meta = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${getConfig().accessToken}` }, timeout: 30000 },
    );
    const { url, mime_type: mimeType } = meta.data || {};
    if (!url) return { ok: false, error: "media URL missing from Graph response" };

    const file = await axios.get(url, {
      headers: { Authorization: `Bearer ${getConfig().accessToken}` },
      responseType: "arraybuffer",
      timeout: 60000,
    });

    return {
      ok: true,
      buffer: Buffer.from(file.data),
      // WhatsApp sends "audio/ogg; codecs=opus"; the parameter has to go or the
      // player never matches it against its accepted-type list.
      mimeType: String(mimeType || "application/octet-stream").split(";")[0].trim(),
    };
  } catch (error) {
    const details = error.response?.data?.error;
    return { ok: false, error: details?.message || error.message };
  }
}

/** Blue ticks on the client's side — best effort, never blocks processing. */
async function markAsRead(waMessageId) {
  if (!canSend() || !waMessageId) return { ok: false };
  try {
    await axios.post(
      graphUrl("messages"),
      { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
      { headers: authHeaders(), timeout: 15000 },
    );
    return { ok: true };
  } catch (error) {
    console.warn(
      "⚠️ [WhatsAppCloud] markAsRead failed:",
      error.response?.data?.error?.message || error.message,
    );
    return { ok: false };
  }
}

module.exports = {
  getConfig,
  canSend,
  verifySignature,
  normalizePhone,
  phonesMatch,
  findClientByPhone,
  sendText,
  markAsRead,
  downloadMedia,
  uploadMedia,
  sendMedia,
  whatsappTypeFor,
  SENDABLE_TYPES,
};
