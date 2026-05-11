// services/profileEmailService.js
require("dotenv").config();

const Signature = require("../models/Signature");
const { sendEmail } = require("./mailService");
const { removeSignatureParagraphMargins } = require("../utils/removeSignatureParagraphMargins");

const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const SERVER_URL = process.env.SERVER_URL || "";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

/** Build owner signature block (image + rich text) */
async function getSignatureBlock(ownerId) {
  if (!ownerId) return "";
  const signature = await Signature.findOne({ owner: ownerId });
  if (!signature) return "";

  const img = signature.signatureImage
    ? `<img src="${SERVER_URL}${signature.signatureImage}" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
    : "";
    const signatureText = removeSignatureParagraphMargins(signature.signatureText || "");

  return `
    <div style="margin-bottom:12px;">
      ${img}
      <div style="text-align:left;">
         ${signatureText}
      </div>
    </div>
  `;
}

/**
 * Sends the “Complete Profile” email with a per-employee link.
 * NOTE: We append `?from=resend` so your Complete Profile submit route
 * can detect the resend flow and force sending the Set-Password email.
 *
 * @param {{id:string,to:string,employeeName?:string,companyName?:string,ownerId?:string}} p
 */
async function sendCompleteProfileLink({
  id,
  to,
  employeeName,
  companyName = COMPANY_NAME,
  ownerId,
}) {
  if (!id || !to) throw new Error("Missing 'id' or 'to' for complete profile email");

  // Add the resend marker so the submit handler can send a set-password email.
  const link = `${FRONTEND_BASE_URL}/complete-profile/${id}?from=resend`;
  const subject = "🙌 Thank You! Help Me Finalize Your Profile 🚀";
  const signatureBlock = await getSignatureBlock(ownerId);

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif;font-size:15px;line-height:1.7;color:#212121;width:100%">
      <p style="font-size: 15px;line-height: 18px;
">Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p style="font-size: 15px;line-height:22px;
">Thank you so much for sharing your CNIC and CV earlier — your cooperation means the world to me! 💙</p>
      <p style="font-size: 15px;line-height: 18px;
">As your HR AI Agent, I've been busy building a smarter, more connected system to support you better. 
      From payroll to perks, records to recognition — it all starts with having the right information in the right place.</p>
      <p style="font-size: 15px;line-height: 18px;
">To complete your employee profile and keep our records up to date, please take a moment to fill out this short form:</p>
      <p style="font-size: 15px;line-height: 18px;
">
        📝 <strong>
          <a href="${link}" style="color: #0057b7; text-decoration: underline;">
            Click here to complete your profile
          </a>
        </strong>
      </p>
      <p style="font-size: 15px;line-height: 18px;
">This will help me ensure:</p>
      <ul style="margin:0 0 1em 2em;padding:0;">
        <li style="margin-bottom:4px;">✅ Your salary info is processed correctly</li>
        <li style="margin-bottom:4px;">✅ Your benefits and contact details are accurate</li>
        <li style="margin-bottom:4px;">✅ You're ready for future updates, promotions, and recognitions 🎉</li>
      </ul>
      <p style="font-size: 15px;line-height: 18px;
">It'll only take a few minutes and, as always, your data will be handled with strict confidentiality and care.</p>
      <p style="font-size: 15px;line-height: 18px;
">Thank you again for being such an important part of the <strong>${companyName}</strong> family.</p>
      ${signatureBlock}
    </div>
  `;

  await sendEmail({ to, subject, html });
}

/**
 * Optional helper to send the Set-Password email (you can call this anywhere).
 * @param {{to:string, employeeName?:string, token:string, employeeId:string, ownerId?:string}} p
 */
async function sendSetPasswordEmail({ to, employeeName, token, employeeId, ownerId }) {
  if (!to || !token || !employeeId) {
    throw new Error("Missing 'to', 'token', or 'employeeId' for set password email");
  }

  const setPasswordUrl = `${APP_URL}/set-password?token=${token}&id=${employeeId}`;
  const signatureBlock = await getSignatureBlock(ownerId);

  const html = `
    <div style="font-family:'Comic Sans MS',Comic Sans,cursive,Arial,sans-serif;font-size:15px;color:#22223B;background:#f9fafb;line-height:2.1;text-align:left;margin:0;padding:40px 30px 38px 30px;max-width:100%;border-radius:15px;border:1.5px solid #e0e0e0;">
      <p style="margin-bottom:20px;font-size:19px;">
        Dear <strong>${employeeName || "Employee"}</strong>,
      </p>
      <p style="margin-bottom:18px;">
        Thank you for completing your employee profile.<br/>
        To secure your account and access the HR portal, please set your password by clicking the link below.
      </p>
      <div style="margin:30px 0 24px 0;">
        <a href="${setPasswordUrl}"
           style="background:#0057b7;color:#fff;text-decoration:none;font-weight:bold;padding:12px 30px;border-radius:7px;display:inline-block;font-size:14px;letter-spacing:.4px;box-shadow:0 2px 12px #0057b730;">
          Set My Password
        </a>
      </div>
      <p style="margin-bottom:22px;">
        This link will expire in <strong>7 days</strong> for your security.<br/>
        If you did not request this, you can safely ignore this message.
      </p>
      ${signatureBlock}
    </div>
  `;

  await sendEmail({
    to,
    subject: "Set Your Password – Mavens Advisors HR Portal",
    html,
  });
}

module.exports = {
  sendCompleteProfileLink,
  sendSetPasswordEmail, // optional export if you want to use it elsewhere
};
