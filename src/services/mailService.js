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
      secure: process.env.MAIL_PORT === "465" || true,
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
      tls: { 
        rejectUnauthorized: false 
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000
    });
  }
  return transporter;
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
  getTransporter
};