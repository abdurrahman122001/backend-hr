// services/whatsappClientService.js
// The client-facing half of the real WhatsApp number: turns an inbound Cloud API
// message into a WhatsAppMessage addressed to the assigned employees, and pushes
// a fully-approved reply back out to the client.
//
// This is the WhatsApp twin of clientEmailService — same rules, different wire.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const ffmpegPath = require("ffmpeg-static");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const ClientInfo = require("../models/ClientInfo");
const whatsappCloud = require("./whatsappCloudService");

// Same directory multer writes to, served at /uploads by index.js.
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const MIME_EXTENSIONS = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "application/pdf": ".pdf",
};

/**
 * Absolute /uploads URL, matching what buildPublicUrl produces for uploaded
 * attachments. It has to be absolute: the frontend prefixes a relative path with
 * VITE_API_URL, which ends in /api, producing /api/uploads/… and a 404.
 *
 * The base cannot come from the webhook request either — that host is Meta's
 * tunnel/domain, which would bake an ngrok URL into stored data. Set
 * PUBLIC_BASE_URL in production; the localhost fallback matches what uploads
 * already resolve to in development.
 */
function publicUploadUrl(filename) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.HTTP_PORT || 4000}`;
  return `${base.replace(/\/+$/, "")}/uploads/${filename}`;
}

function extensionFor(mimeType, fallbackName) {
  const fromName = path.extname(fallbackName || "");
  if (fromName) return fromName;
  if (MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
  const subtype = String(mimeType || "").split("/")[1];
  return subtype ? `.${subtype.replace(/[^\w]/g, "")}` : "";
}

/**
 * Sidebar preview for a message whose body is empty because it IS the file.
 * Mirrors attachmentPreviewLabel in whatsAppMessageController — duplicated
 * rather than imported, since that controller requires this service back.
 */
function attachmentPreviewLabel(attachments) {
  const a = Array.isArray(attachments) ? attachments[0] : null;
  if (!a) return "";
  const type = String(a.mimetype || "").toLowerCase();
  if (type.startsWith("audio")) return "🎤 Voice message";
  if (type.startsWith("image")) return "📷 Image";
  if (type.startsWith("video")) return "🎥 Video";
  return "📎 Attachment";
}

/** The media payload sits under a key named after the message type. */
function mediaPartOf(message) {
  const part = message[message.type];
  if (!part || !part.id) return null;
  return {
    mediaId: part.id,
    filename: part.filename || null,
    caption: part.caption || "",
    isVoiceNote: message.type === "audio" && part.voice === true,
  };
}

/**
 * Download an inbound media file and store it the way an uploaded attachment is
 * stored, so the existing chat UI plays/renders it with no special-casing.
 *
 */
async function fetchAttachment(message) {
  const media = mediaPartOf(message);
  if (!media) return null;

  const result = await whatsappCloud.downloadMedia(media.mediaId);
  if (!result.ok) {
    console.error(
      `❌ [WhatsAppInbound] Could not download ${message.type} ${media.mediaId}: ${result.error}`,
    );
    return null;
  }

  const ext = extensionFor(result.mimeType, media.filename);
  const base = media.isVoiceNote
    ? "voice-note"
    : path
        .basename(media.filename || message.type, path.extname(media.filename || ""))
        .replace(/[^\w\-]+/g, "_")
        .slice(0, 60) || message.type;
  const filename = `${base}_${Date.now()}_${randomUUID()}${ext}`;

  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), result.buffer);

  console.log(
    `📎 [WhatsAppInbound] Saved ${message.type} as ${filename} (${result.buffer.length} bytes, ${result.mimeType})`,
  );

  return {
    attachment: {
      filename,
      originalName: media.filename || filename,
      mimetype: result.mimeType,
      size: result.buffer.length,
      url: publicUploadUrl(filename),
      uploadedAt: new Date(),
    },
    caption: media.caption,
  };
}

function stripHtml(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * An inbound message quoting one of ours arrives with `context.id` — the wamid
 * of the quoted message. Map it back to our record so the app can render the
 * reply exactly as it renders an internal one.
 */
async function resolveInboundQuote(message) {
  const quotedWamid = message.context?.id;
  if (!quotedWamid) return null;

  const original = await WhatsAppMessage.findOne({
    $or: [
      { "waMetadata.waMessageId": quotedWamid },
      { "waMetadata.outboundWaMessageId": quotedWamid },
    ],
  })
    .select("_id note sender attachments")
    .lean();

  // Quoting something older than this integration is normal — treat it as a
  // plain message rather than inventing a reference we cannot resolve.
  if (!original) return null;

  return {
    repliedTo: original._id,
    replyContent: {
      originalMessage: stripHtml(original.note),
      // Null for a message the client sent themselves; the schema allows it.
      originalSender: original.sender || null,
      originalAttachments: original.attachments || [],
      preview: stripHtml(original.note).slice(0, 200),
    },
  };
}

/**
 * Persist an inbound client WhatsApp message and address it to the employees
 * assigned to that client.
 *
 * approvalStatus stays null: approval governs what WE send out, never what the
 * client sends in — exactly as inbound email works.
 *
 * @returns {{saved: boolean, duplicate?: boolean, message?, recipients?: string[]}}
 */
async function saveInboundClientMessage({ client, clientEmployee, message, value }) {
  const waMessageId = message.id;

  // Meta retries until it sees a 200, so the same wamid can arrive twice.
  const existing = await WhatsAppMessage.findOne({
    "waMetadata.waMessageId": waMessageId,
  })
    .select("_id")
    .lean();
  if (existing) {
    console.log(`↩️ [WhatsAppInbound] Duplicate ${waMessageId} ignored`);
    return { saved: false, duplicate: true };
  }

  const recipients = (client.assignedTo || [])
    .map((e) => String(e._id || e))
    .filter(Boolean);

  if (recipients.length === 0) {
    console.warn(
      `⚠️ [WhatsAppInbound] Client "${client.clientName}" has no assignedTo — message stored with no recipients`,
    );
  }

  const sentAt = message.timestamp
    ? new Date(Number(message.timestamp) * 1000)
    : new Date();

  // Voice notes, photos and documents arrive as a media id, not content — fetch
  // the file so the chat has something to actually play or open.
  // The client quoted one of our messages on their phone — mirror that into the
  // app's own reply fields so the chat shows the same quoted bubble we do.
  const quoted = await resolveInboundQuote(message);

  const media = await fetchAttachment(message);
  const attachments = media ? [media.attachment] : [];
  // With an attachment present the body is the caption, and an empty one is
  // correct: the UI keys "this is a voice message" off having audio and no text.
  const noteText = media ? media.caption : message.body;
  const previewText =
    (noteText || "").trim() || attachmentPreviewLabel(attachments);

  const doc = await WhatsAppMessage.create({
    owner: client.owner?._id || client.owner,
    client: client._id,
    sender: null,
    senderType: "client",
    isFromClient: true,
    source: "whatsapp",
    receiver: recipients,
    intendedReceivers: recipients,
    note: noteText,
    attachments,
    // Inbound needs no approval — it is already delivered to us. "sent" is the
    // schema's terminal state (draft/scheduled/sent/cancelled).
    approvalStatus: null,
    status: "sent",
    sentAt,
    originalSentAt: sentAt,
    isReply: Boolean(quoted),
    repliedTo: quoted ? quoted.repliedTo : null,
    replyContent: quoted ? quoted.replyContent : null,
    clientSenderName: clientEmployee.name || client.clientName,
    clientSenderPhone: clientEmployee.phone || message.from,
    waMetadata: {
      waMessageId,
      from: message.from,
      profileName: message.profileName || null,
      phoneNumberId: value?.metadata?.phone_number_id || null,
      type: message.type,
      timestamp: sentAt,
    },
  });

  // Same denormalization the send/approve paths do, so the chat rises to the
  // top of the WhatsApp sidebar with the client's text as the preview.
  await ClientInfo.findByIdAndUpdate(
    client._id,
    {
      $set: {
        "lastWhatsAppMessage.text": previewText.slice(0, 200),
        "lastWhatsAppMessage.at": sentAt,
        "lastWhatsAppMessage.senderId": null,
        "lastWhatsAppMessage.hasAttachments": attachments.length > 0,
        "lastWhatsAppMessage.deleted": false,
        "lastWhatsAppMessage.isReaction": false,
        "lastWhatsAppMessage.reactionEmoji": null,
        "lastWhatsAppMessage.reactorId": null,
        "lastWhatsAppMessage.reactorName": null,
      },
    },
    { timestamps: false },
  ).catch(() => {});

  const populated = await doc.populate([
    { path: "client", select: "_id clientName assignedTo" },
    { path: "receiver", select: "_id name companyEmail role designation" },
  ]);

  return { saved: true, message: populated, recipients };
}

/**
 * Repackage a browser voice note so WhatsApp will take it.
 *
 * MediaRecorder gives us Opus audio inside a WebM container; WhatsApp accepts
 * Opus, but only inside Ogg. That makes this a container swap, not a re-encode:
 * `-c:a copy` moves the same encoded stream across, so it is fast and lossless.
 *
 * @returns {{ok: boolean, buffer?: Buffer, mimeType?: string, error?: string}}
 */
async function remuxToOgg(buffer) {
  const stamp = `${Date.now()}_${randomUUID()}`;
  const input = path.join(os.tmpdir(), `wa-in-${stamp}.webm`);
  const output = path.join(os.tmpdir(), `wa-out-${stamp}.ogg`);
  try {
    await fs.promises.writeFile(input, buffer);
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c:a", "copy", output],
        (error, _stdout, stderr) =>
          error ? reject(new Error(stderr || error.message)) : resolve(),
      );
    });
    return {
      ok: true,
      buffer: await fs.promises.readFile(output),
      mimeType: "audio/ogg",
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.promises.unlink(input).catch(() => {});
    fs.promises.unlink(output).catch(() => {});
  }
}

/**
 * The wamid of whatever this message is replying to, so WhatsApp can render the
 * quoted bubble on the client's phone.
 *
 * Either side may be quoted: a message the client sent us carries
 * `waMessageId`, one we sent them carries `outboundWaMessageId`. A reply to an
 * internal-only message has neither, and simply goes out unquoted.
 */
async function resolveReplyContext(message) {
  if (!message.isReply || !message.repliedTo) return null;
  const originalId = message.repliedTo._id || message.repliedTo;
  const original = await WhatsAppMessage.findById(originalId)
    .select("waMetadata")
    .lean();
  return (
    original?.waMetadata?.waMessageId ||
    original?.waMetadata?.outboundWaMessageId ||
    null
  );
}

/** UI placeholders the app writes next to a recording, never typed by a human. */
function isPlaceholderBody(text) {
  return /^(🎤\s*)?(voice|audio)\s*message$/i.test((text || "").trim());
}

/**
 * Read a stored attachment back off disk. The URL is absolute (PUBLIC_BASE_URL),
 * so go by filename rather than trying to fetch our own URL.
 */
async function readStoredAttachment(attachment) {
  const filename =
    attachment.filename ||
    (attachment.url ? path.basename(new URL(attachment.url, "http://x").pathname) : null);
  if (!filename) return null;
  try {
    return { buffer: await fs.promises.readFile(path.join(UPLOAD_DIR, filename)), filename };
  } catch (error) {
    console.error(`❌ [WhatsAppOutbound] Cannot read ${filename}: ${error.message}`);
    return null;
  }
}

/**
 * Upload one attachment to Meta and send it to the client.
 *
 * WhatsApp accepts a fixed set of formats per media type. Browser voice notes
 * are audio/webm, which is NOT among them — the Opus stream inside is fine, but
 * the container is wrong, so it needs a remux before it can go out as audio.
 */
async function sendAttachment({ to, attachment, caption, replyToWaMessageId }) {
  const file = await readStoredAttachment(attachment);
  if (!file) return { sent: false, error: "attachment file missing on disk" };

  let buffer = file.buffer;
  let mimeType = String(attachment.mimetype || "application/octet-stream")
    .split(";")[0]
    .trim();
  let filename = attachment.originalName || file.filename;

  // Browser voice notes arrive as webm, which WhatsApp rejects outright. Swap
  // the container before uploading rather than failing the send.
  if (mimeType.startsWith("audio/") && whatsappCloud.whatsappTypeFor(mimeType) !== "audio") {
    const remuxed = await remuxToOgg(buffer);
    if (!remuxed.ok) {
      const reason = `Could not convert ${mimeType} to ogg/opus: ${remuxed.error}`;
      console.error(`❌ [WhatsAppOutbound] ${reason}`);
      return { sent: false, error: reason };
    }
    console.log(
      `🔄 [WhatsAppOutbound] Remuxed ${mimeType} → audio/ogg (${buffer.length} → ${remuxed.buffer.length} bytes)`,
    );
    buffer = remuxed.buffer;
    mimeType = remuxed.mimeType;
    filename = filename.replace(/\.[^.]+$/, "") + ".ogg";
  }

  const type = whatsappCloud.whatsappTypeFor(mimeType);

  const upload = await whatsappCloud.uploadMedia({
    buffer,
    mimeType,
    filename,
  });
  if (!upload.ok) return { sent: false, error: upload.error };

  return whatsappCloud.sendMedia({
    to,
    type,
    mediaId: upload.mediaId,
    caption,
    filename,
    replyToWaMessageId,
  });
}

/**
 * Send a fully-approved employee reply to the client over WhatsApp.
 *
 * Guarded the same way clientEmailService is: only threads that actually contain
 * an inbound WhatsApp message from this client go out, so internal client chats
 * never leak to a real phone.
 *
 * @param {Object} message an approved WhatsAppMessage (doc or populated)
 * @returns {{sent: boolean, skipped?: string, to?: string, error?: string}}
 */
async function sendApprovedReplyToClient(message) {
  if (!message || !message.client) {
    return { sent: false, skipped: "not a client message" };
  }
  // Never echo the client's own message back at them.
  if (message.isFromClient || message.senderType === "client") {
    return { sent: false, skipped: "message originated from the client" };
  }
  // Group chats and client-employee sub-chats are internal conversations.
  if (message.isGroupMessage || message.groupId || message.isClientEmployeeMessage) {
    return { sent: false, skipped: "not a direct client chat" };
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  // "🎤 Voice message" is a UI placeholder the app writes alongside a voice
  // recording, not something the sender typed. Sending it verbatim is how the
  // client ended up receiving that literal string instead of the audio.
  const rawBody = stripHtml(message.note);
  const body = attachments.length > 0 && isPlaceholderBody(rawBody) ? "" : rawBody;

  if (!body && attachments.length === 0) {
    return { sent: false, skipped: "empty message" };
  }

  const clientId = message.client._id || message.client;

  // The conversation must have started on the real WhatsApp number.
  const lastInbound = await WhatsAppMessage.findOne({
    client: clientId,
    source: "whatsapp",
    isFromClient: true,
  })
    .sort({ createdAt: -1 })
    .select("clientSenderPhone waMetadata sentAt createdAt")
    .lean();

  if (!lastInbound) {
    return {
      sent: false,
      skipped: "no inbound WhatsApp message from this client — internal chat only",
    };
  }

  const to = lastInbound.clientSenderPhone || lastInbound.waMetadata?.from;
  if (!to) {
    return { sent: false, skipped: "no WhatsApp number recorded for this client" };
  }

  // Meta rejects free-form messages more than 24h after the client's last
  // message. Catch it here so the failure names the real cause instead of
  // surfacing as an opaque Graph API error.
  // Measured from when the CLIENT sent, not when we stored it: Meta counts from
  // their timestamp, so a webhook we processed late (outage, retry backlog)
  // would otherwise look like it had more time left than it really has.
  const windowMs = 24 * 60 * 60 * 1000;
  const lastInboundAt =
    lastInbound.waMetadata?.timestamp ||
    lastInbound.sentAt ||
    lastInbound.createdAt;
  const age = Date.now() - new Date(lastInboundAt).getTime();
  if (age > windowMs) {
    const hours = Math.floor(age / (60 * 60 * 1000));
    console.warn(
      `⚠️ [WhatsAppOutbound] 24h window closed for client ${clientId} (last inbound ${hours}h ago) — approved reply NOT delivered`,
    );
    await WhatsAppMessage.updateOne(
      { _id: message._id },
      {
        $set: {
          "waMetadata.deliveryStatus": "window_expired",
          "waMetadata.failureReason": `Client's last message was ${hours}h ago; WhatsApp only allows free-form replies within 24h. An approved template is required.`,
        },
      },
      { timestamps: false },
    ).catch(() => {});
    return { sent: false, skipped: "24h customer service window expired", to };
  }

  // Attachments first, each as its own WhatsApp message, then any real text the
  // employee typed alongside them.
  const replyToWaMessageId = await resolveReplyContext(message);

  let result = { sent: false, skipped: "nothing to send" };
  for (const attachment of attachments) {
    result = await sendAttachment({ to, attachment, caption: "", replyToWaMessageId });
    if (!result.sent) break;
  }
  if (result.sent || attachments.length === 0) {
    if (body) result = await whatsappCloud.sendText({ to, body, replyToWaMessageId });
  }

  await WhatsAppMessage.updateOne(
    { _id: message._id },
    {
      $set: {
        "waMetadata.outboundWaMessageId": result.waMessageId || null,
        "waMetadata.deliveryStatus": result.sent ? "sent" : "failed",
        "waMetadata.failureReason": result.sent ? null : result.error || null,
      },
    },
    { timestamps: false },
  ).catch(() => {});

  // Propagate `skipped` too — an unconfigured transport reports that rather
  // than an error, and swallowing it makes a missing token look like a silent
  // success path.
  return result.sent
    ? { sent: true, to, waMessageId: result.waMessageId }
    : { sent: false, to, error: result.error, skipped: result.skipped };
}

/**
 * Fire-and-forget wrapper for the approval paths: delivery to WhatsApp must
 * never turn a successful in-app approval into a 500.
 */
function sendApprovedReplySafely(message) {
  sendApprovedReplyToClient(message)
    .then((result) => {
      if (result.sent) {
        console.log(`✅ [WhatsAppOutbound] Approved reply delivered to ${result.to}`);
      } else if (result.error) {
        console.error(`❌ [WhatsAppOutbound] Delivery failed: ${result.error}`);
      } else {
        console.log(`ℹ️ [WhatsAppOutbound] Skipped: ${result.skipped}`);
      }
    })
    .catch((error) => {
      console.error("❌ [WhatsAppOutbound] Unexpected failure:", error);
    });
}

module.exports = {
  saveInboundClientMessage,
  sendApprovedReplyToClient,
  sendApprovedReplySafely,
};
