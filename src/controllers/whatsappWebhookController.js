// controllers/whatsappWebhookController.js
// Meta's webhook for the company WhatsApp number: the GET handshake that the
// App Dashboard uses to validate the callback URL, and the POST endpoint that
// receives inbound client messages and delivery statuses.
const whatsappCloud = require("../services/whatsappCloudService");
const whatsappClient = require("../services/whatsappClientService");
const WhatsAppMessage = require("../models/WhatsAppMessage");

/**
 * GET /api/whatsapp/webhook
 * Meta calls this once when you press "Verify and save", and again whenever the
 * subscription is re-validated. Echo hub.challenge back as PLAIN TEXT when the
 * token matches — a JSON-wrapped challenge fails the check.
 */
exports.verifyWebhook = function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const { verifyToken } = whatsappCloud.getConfig();

  if (!verifyToken) {
    console.error("❌ [WhatsAppWebhook] WHATSAPP_VERIFY_TOKEN is not set");
    return res.sendStatus(500);
  }

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ [WhatsAppWebhook] Verification handshake succeeded");
    return res.status(200).type("text/plain").send(challenge);
  }

  console.warn(
    `❌ [WhatsAppWebhook] Verification failed (mode=${mode}, token matched=${token === verifyToken})`,
  );
  return res.sendStatus(403);
};

/**
 * POST /api/whatsapp/webhook
 * Meta retries anything that is not answered with a 200 within a few seconds,
 * so acknowledge first and do the work afterwards.
 */
exports.receiveWebhook = function receiveWebhook(req, res) {
  // The router hands over the raw Buffer so the signature covers the exact bytes
  // Meta signed.
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body || {}));

  const signature = whatsappCloud.verifySignature(
    rawBody,
    req.get("x-hub-signature-256"),
  );
  if (!signature.ok) {
    console.warn(`❌ [WhatsAppWebhook] Rejected payload: ${signature.reason}`);
    return res.sendStatus(401);
  }
  if (signature.skipped) {
    console.warn(
      "⚠️ [WhatsAppWebhook] WHATSAPP_APP_SECRET not set — payload signature NOT verified",
    );
  }

  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    console.error("❌ [WhatsAppWebhook] Body is not valid JSON:", error.message);
    return;
  }

  processPayload(payload, req.app.get("io")).catch((error) => {
    console.error("❌ [WhatsAppWebhook] Processing failed:", error);
  });
};

async function processPayload(payload, io) {
  if (payload?.object !== "whatsapp_business_account") {
    console.log(`ℹ️ [WhatsAppWebhook] Ignoring object: ${payload?.object}`);
    return;
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};

      for (const message of value.messages || []) {
        await handleInboundMessage(message, value, io);
      }
      for (const status of value.statuses || []) {
        handleStatusUpdate(status);
      }
    }
  }
}

/** Flatten the per-type payload into the text we store and show. */
function extractBody(message) {
  switch (message.type) {
    case "text":
      return message.text?.body || "";
    case "button":
      return message.button?.text || "";
    case "interactive":
      return (
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        ""
      );
    // Media carries no text of its own — the caption (often empty) is the body,
    // and the file itself is downloaded and attached during save.
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker":
      return message[message.type]?.caption || "";
    case "location":
      return "[location]";
    case "contacts":
      return "[contact card]";
    default:
      return `[${message.type}]`;
  }
}

async function handleInboundMessage(message, value, io) {
  const waId = message.from;
  const profileName =
    (value.contacts || []).find((c) => c.wa_id === waId)?.profile?.name || null;
  const body = extractBody(message);

  console.log(
    `📩 [WhatsAppWebhook] ${message.type} from ${waId}${profileName ? ` (${profileName})` : ""}: ${body.slice(0, 120)}`,
  );

  const match = await whatsappCloud.findClientByPhone(waId);
  if (!match) {
    // Unknown numbers are logged and dropped: routing is driven by the client
    // record, exactly as inbound email is.
    console.warn(
      `⚠️ [WhatsAppWebhook] No ClientInfo matches ${waId} — message not routed`,
    );
    return;
  }

  const { client, clientEmployee } = match;
  const assignedEmployees = (client.assignedTo || []).map((e) => e._id || e);

  console.log(
    `✅ [WhatsAppWebhook] Matched client "${client.clientName}" (contact: ${clientEmployee.name}) → ${assignedEmployees.length} assigned employee(s)`,
  );

  whatsappCloud.markAsRead(message.id);

  const saved = await whatsappClient.saveInboundClientMessage({
    client,
    clientEmployee,
    message: { ...message, body, profileName },
    value,
  });
  if (!saved.saved) return;

  // Same event and shape the in-app send path emits, so the open chat appends
  // the client's message with no frontend change — ChatMessage already renders
  // senderType "client" as a left-hand bubble.
  if (io) {
    const payload = {
      ...saved.message.toObject(),
      // The UI checks either spelling depending on where the message came from.
      fromClient: true,
      clientName: client.clientName,
      conversationType: "client",
      parentClientId: String(client._id),
    };
    for (const employeeId of saved.recipients) {
      io.to(`employee_${employeeId}`).emit("new_message", {
        message: payload,
        type: "new_message",
        action: "client_whatsapp_inbound",
        timestamp: new Date(),
      });
    }
  }
}

function handleStatusUpdate(status) {
  // sent → delivered → read for messages we sent out, plus failures. Recorded
  // on the originating message so the chat can show what actually happened to
  // an approved reply.
  const failed = status.status === "failed";
  const reason = failed
    ? (status.errors || []).map((e) => e.title || e.message).join("; ")
    : null;

  if (failed) {
    console.error(
      `❌ [WhatsAppWebhook] Delivery failed for ${status.id} → ${status.recipient_id}: ${reason}`,
    );
  } else {
    console.log(
      `📬 [WhatsAppWebhook] ${status.id} → ${status.recipient_id}: ${status.status}`,
    );
  }

  WhatsAppMessage.updateOne(
    { "waMetadata.outboundWaMessageId": status.id },
    {
      $set: {
        "waMetadata.deliveryStatus": status.status,
        ...(failed ? { "waMetadata.failureReason": reason } : {}),
      },
    },
    { timestamps: false },
  ).catch((error) =>
    console.warn(
      "⚠️ [WhatsAppWebhook] Could not record delivery status:",
      error.message,
    ),
  );
}
