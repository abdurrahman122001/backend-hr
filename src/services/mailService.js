// services/mailService.js
require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: process.env.MAIL_PORT === '465',
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

async function sendEmail({ to, subject, text, html, attachments }) {
  if (!to) {
    throw new Error('No recipients defined');
  }
  const mailOptions = {
    from: process.env.MAIL_FROM || transporter.options.auth.user,
    to,
    subject,
    text,
    html,
    attachments,
  };
  return transporter.sendMail(mailOptions);
}

module.exports = { sendEmail };