// services/mailService.js
require("dotenv").config();
const nodemailer = require("nodemailer");

// Create a single shared transporter instance
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.titan.email',
      port: Number(process.env.MAIL_PORT) || 465,
      secure: (Number(process.env.MAIL_PORT) || 465) === 465,
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
      tls: {
        rejectUnauthorized: false
      },
      // Reuse connections instead of opening a fresh one per email — Titan
      // tarpits (delays the greeting for) IPs that reconnect frequently.
      pool: true,
      maxConnections: 3,
      // Titan's greet delay has been observed at 12s+; keep well above it.
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    });
  }
  return transporter;
}

/* ------------------------------- HR mailbox ------------------------------- */
//
// The recruiting conversation (offer letter → acceptance → documents → profile
// link) must be sent FROM the mailbox the HR watcher reads, because every step
// is driven by the candidate's REPLY. Sending as one address while watching
// another silently breaks the flow.
//
// HR_MAIL_* selects that account; it falls back to MAIL_* so deployments that
// use a single mailbox need no extra config.
let hrTransporter = null;

const hrMailConfig = () => ({
  host: process.env.HR_MAIL_HOST || process.env.MAIL_HOST || "smtp.titan.email",
  port: Number(process.env.HR_MAIL_PORT || process.env.MAIL_PORT) || 465,
  user: process.env.HR_MAIL_USERNAME || process.env.MAIL_USERNAME,
  pass: process.env.HR_MAIL_PASSWORD || process.env.MAIL_PASSWORD,
  fromAddress:
    process.env.HR_MAIL_FROM_ADDRESS ||
    process.env.HR_MAIL_USERNAME ||
    process.env.MAIL_FROM_ADDRESS,
  fromName:
    process.env.HR_MAIL_FROM_NAME ||
    process.env.MAIL_FROM_NAME ||
    "HR",
});

function getHrTransporter() {
  if (!hrTransporter) {
    const cfg = hrMailConfig();
    hrTransporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
      tls: { rejectUnauthorized: false },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
    });
  }
  return hrTransporter;
}

/** The address recruiting mail is sent from — the one candidates reply to. */
function getHrFromAddress() {
  return hrMailConfig().fromAddress;
}

/**
 * Send a recruiting/HR email from the HR mailbox. Same options as sendEmail.
 * The envelope sender must match the authenticating account or Titan rejects
 * it, so `from` is derived from the HR config rather than accepted verbatim.
 */
async function sendHrMail({ to, cc, subject, text, html, attachments, replyTo }) {
  if (!to) throw new Error("No recipients defined");

  const cfg = hrMailConfig();
  const mailOptions = {
    from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
    to,
    cc: Array.isArray(cc) ? cc.join(",") : cc,
    subject,
    text,
    html,
    attachments,
    replyTo: replyTo || cfg.fromAddress,
  };

  console.log(`[mailService] Sending HR email from ${cfg.fromAddress} to: ${to}`);

  try {
    const result = await getHrTransporter().sendMail(mailOptions);
    console.log(`[mailService] HR email sent: ${result.messageId}`);
    return result;
  } catch (error) {
    console.error(`[mailService] Error sending HR email to ${to}:`, error.message);
    throw error;
  }
}

async function sendEmail({ from, to, cc, subject, text, html, attachments, isSystem = false }) {
  if (!to) {
    throw new Error("No recipients defined");
  }

  // Build proper "From" header
  const fromAddress = from || 
    (isSystem 
      ? `"Mavens Advisor System" <${process.env.MAIL_FROM_ADDRESS}>`
      : `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`);

  const mailOptions = {
    from: fromAddress,
    to,
    cc: Array.isArray(cc) ? cc.join(",") : cc,
    subject,
    text,
    html,
    attachments,
  };

  console.log(`[mailService] Sending ${isSystem ? 'system ' : ''}email to: ${to}`);

  try {
    const result = await getTransporter().sendMail(mailOptions);
    console.log(`[mailService] Email sent successfully: ${result.messageId}`);
    return result;
  } catch (error) {
    console.error(`[mailService] Error sending email to ${to}:`, error.message);
    throw error;
  }
}

// For HR/other automated emails - this should only be called manually, not automatically
async function sendHREmail(to, subject, body) {
  console.log(`[mailService] Sending HR email to ${to} - MANUAL TRIGGER ONLY`);
  
  // Check if this is from a client email (should not send HR emails to clients)
  // You need to add logic here to prevent sending HR emails to client addresses
  return sendEmail({
    to,
    subject: `[HR] ${subject}`,
    text: body,
    html: `<div>${body.replace(/\n/g, '<br>')}</div>`,
    isSystem: true
  });
}

module.exports = {
  sendEmail,
  sendHREmail,
  getTransporter,
  sendHrMail,
  getHrTransporter,
  getHrFromAddress
};