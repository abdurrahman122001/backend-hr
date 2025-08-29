// services/profileEmailService.js
require("dotenv").config();

const Signature = require("../models/Signature");
const { sendEmail } = require("./mailService");

const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";

async function getSignatureBlock(ownerId) {
  const signature = await Signature.findOne({ owner: ownerId });
  if (!signature) return "";

  return `
    <div style="margin-top:32px;margin-bottom:12px;">
      ${
        signature.signatureImage
          ? `<img src="${process.env.SERVER_URL || ""}${
              signature.signatureImage
            }" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
          : ""
      }
      <div style="text-align:left;">
        ${signature.signatureText || ""}
      </div>
    </div>
  `;
}

/**
 * Sends the “Complete Profile” email with the per-employee link.
 * @param {{id:string,to:string,employeeName?:string,companyName?:string,ownerId?:string}} p
 */
async function sendCompleteProfileLink({ id, to, employeeName, companyName = COMPANY_NAME, ownerId }) {
  if (!id || !to) throw new Error("Missing 'id' or 'to' for complete profile email");

  const link = `${process.env.FRONTEND_BASE_URL}/complete-profile/${id}`;
  const subject = "🙌 Thank You! Help Me Finalize Your Profile 🚀";
  const signatureBlock = await getSignatureBlock(ownerId);

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
      <p>Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p>Thank you so much for sharing your CNIC and CV earlier — your cooperation means the world to me! 💙</p>
      <p>As your HR AI Agent, I've been busy building a smarter, more connected system to support you better. 
      From payroll to perks, records to recognition — it all starts with having the right information in the right place.</p>
      <p>To complete your employee profile and keep our records up to date, please take a moment to fill out this short form:</p>
      <p>
        📝 <strong>
          <a href="${link}" style="color: #0057b7; text-decoration: underline;">
            Click here to complete your profile
          </a>
        </strong>
      </p>
      <p>This will help me ensure:</p>
      <ul style="margin:0 0 1em 2em;padding:0;">
        <li style="margin-bottom:4px;">✅ Your salary info is processed correctly</li>
        <li style="margin-bottom:4px;">✅ Your benefits and contact details are accurate</li>
        <li style="margin-bottom:4px;">✅ You're ready for future updates, promotions, and recognitions 🎉</li>
      </ul>
      <p>It'll only take a few minutes and, as always, your data will be handled with strict confidentiality and care.</p>
      <p>Thank you again for being such an important part of the <strong>${companyName}</strong> family.</p>
      ${signatureBlock}
    </div>
  `;

  await sendEmail({ to, subject, html });
}

module.exports = { sendCompleteProfileLink };
