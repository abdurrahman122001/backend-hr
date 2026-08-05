// services/clientEmailService.js
// Sends a fully-approved assignment reply to the client's real mailbox via SMTP
// (info@brannovate.com). Only fires for threads that originated from an inbound
// client email, so internal client-tagged conversations never leak out.
const nodemailer = require("nodemailer");
const AssignmentMessage = require("../models/AssignmentMessage");
const ClientInfo = require("../models/ClientInfo");

let transporter = null;

function getTransporter() {
  if (!transporter) {
    const port =
      parseInt(process.env.CLIENT_MAIL_PORT || process.env.MAIL_PORT) || 465;
    transporter = nodemailer.createTransport({
      host:
        process.env.CLIENT_MAIL_HOST ||
        process.env.MAIL_HOST ||
        "smtp.titan.email",
      port,
      secure: port === 465,
      auth: {
        user: process.env.CLIENT_MAIL_USERNAME || process.env.MAIL_USERNAME,
        pass: process.env.CLIENT_MAIL_PASSWORD || process.env.MAIL_PASSWORD,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }
  return transporter;
}

function getFromAddress() {
  const address =
    process.env.CLIENT_MAIL_FROM_ADDRESS ||
    process.env.CLIENT_MAIL_USERNAME ||
    process.env.MAIL_FROM_ADDRESS ||
    process.env.MAIL_USERNAME;
  const name =
    process.env.CLIENT_MAIL_FROM_NAME || process.env.MAIL_FROM_NAME || "";
  return name ? `"${name.replace(/^"|"$/g, "")}" <${address}>` : address;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAttachments(attachments) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments
    .map((att) => {
      if (att.url && att.url.startsWith("data:")) {
        const matches = att.url.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
          return {
            filename: att.originalName || att.filename || "attachment",
            content: Buffer.from(matches[2], "base64"),
            contentType:
              matches[1] || att.mimetype || "application/octet-stream",
          };
        }
        return null;
      }
      if (att.url) {
        return {
          filename: att.originalName || att.filename || "attachment",
          path: att.url,
          contentType: att.mimetype || "application/octet-stream",
        };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Email a fully-approved reply to the client who started the thread by email.
 *
 * @param {Object} message AssignmentMessage (doc or populated) that was approved.
 * @returns {{sent: boolean, skipped?: string, to?: string}}
 */
async function sendApprovedReplyToClient(message) {
  if (!message || !message.client || !message.threadId) {
    return { sent: false, skipped: "not a client thread" };
  }
  // Never email the client's own inbound message back to them
  if (message.isFromClient || message.senderType === "client" || message.source === "email") {
    return { sent: false, skipped: "message originated from the client" };
  }
  if (!message.note && (!message.attachments || message.attachments.length === 0)) {
    return { sent: false, skipped: "empty message" };
  }

  const clientId = message.client._id || message.client;

  // The thread must have started from (or contain) an inbound client email —
  // that's what makes this an email conversation rather than an internal note.
  const inboundEmails = await AssignmentMessage.find({
    threadId: message.threadId,
    source: "email",
    isFromClient: true,
    "emailMetadata.messageId": { $exists: true, $ne: "" },
  })
    .sort({ createdAt: 1 })
    .select("subject emailMetadata")
    .lean();

  if (inboundEmails.length === 0) {
    return { sent: false, skipped: "thread did not originate from a client email" };
  }

  const latestInbound = inboundEmails[inboundEmails.length - 1];

  // Reply to the address that actually emailed us; fall back to the client record
  let to =
    latestInbound.emailMetadata?.from || message.clientEmployeeEmail || null;
  if (!to) {
    const clientDoc = await ClientInfo.findById(clientId)
      .select("clientEmail")
      .lean();
    to = clientDoc?.clientEmail || null;
  }
  if (!to) {
    return { sent: false, skipped: "no client email address found" };
  }

  const inReplyTo = latestInbound.emailMetadata.messageId;
  const references = inboundEmails
    .map((m) => m.emailMetadata.messageId)
    .filter(Boolean)
    .join(" ");

  const baseSubject = (message.subject || latestInbound.subject || "").trim();
  const subject = /^re:/i.test(baseSubject)
    ? baseSubject
    : `Re: ${baseSubject || "Your email"}`;

  // Bcc recipients on the compose must actually receive the real outbound
  // email (not just an in-app copy) — nodemailer strips the Bcc header for
  // delivery the same way a real mail server does, so this stays blind to
  // the "to" recipient without any extra work here.
  const bccAddresses = (message.bcc || [])
    .map((entry) => entry?.email)
    .filter(Boolean);

  const mailOptions = {
    from: getFromAddress(),
    to,
    ...(bccAddresses.length > 0 ? { bcc: bccAddresses } : {}),
    subject,
    html: message.note || "",
    text: stripHtml(message.note),
    inReplyTo,
    references: references || inReplyTo,
    headers: {
      "In-Reply-To": inReplyTo,
      References: references || inReplyTo,
    },
    attachments: buildAttachments(message.attachments),
  };

  const info = await getTransporter().sendMail(mailOptions);
  console.log(
    `✅ [ClientEmail] Approved reply sent to ${to} (messageId: ${info.messageId})`
  );

  // Record the outbound messageId so the client's next reply (In-Reply-To this
  // id) is matched back into the same thread by the email receiver.
  await AssignmentMessage.updateOne(
    { _id: message._id },
    {
      $set: {
        emailMetadata: {
          messageId: info.messageId,
          from: process.env.CLIENT_MAIL_FROM_ADDRESS ||
            process.env.CLIENT_MAIL_USERNAME ||
            process.env.MAIL_USERNAME,
          to,
          date: new Date(),
          inReplyTo,
          references: references || inReplyTo,
        },
      },
    }
  );

  return { sent: true, to };
}

module.exports = { sendApprovedReplyToClient };
