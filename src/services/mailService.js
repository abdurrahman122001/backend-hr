// services/mailService.js
require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: process.env.MAIL_PORT === "465", // true for 465, false for 587
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

async function sendEmail({ from, to, subject, text, html, attachments }) {
  if (!to) {
    throw new Error("No recipients defined");
  }

  // ✅ Build proper "From" header
  const fromAddress =
    from ||
    `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`;

  const mailOptions = {
    from: fromAddress,
    to,
    subject,
    text,
    html,
    attachments,
  };

  console.log("[mailService] Sending email with From:", fromAddress);

  return transporter.sendMail(mailOptions);
}

module.exports = { sendEmail };
