// services/profileEmailService.js
require("dotenv").config();

const Signature = require("../models/Signature");
const CompanyProfile = require("../models/CompanyProfile");
const { sendEmail } = require("./mailService");
const { removeSignatureParagraphMargins } = require("../utils/removeSignatureParagraphMargins");
const { signProfileToken } = require("../utils/profileAccessToken");

const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const SERVER_URL = process.env.SERVER_URL || "";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

/**
 * Company details for signature tokens — prefers the documentation branch.
 * No hardcoded fallbacks: anything missing from the company profile resolves
 * to an empty string so the email never shows another company's details.
 */
async function getCompanyContext(ownerId) {
  const empty = { name: "", email: "", phone: "", website: "", address: "" };
  if (!ownerId) return empty;

  let companyDoc = null;
  try {
    companyDoc = await CompanyProfile.findOne(
      { owner: ownerId },
      { name: 1, email: 1, website: 1, branches: 1 }
    ).lean();
  } catch (err) {
    console.error("Error fetching company profile:", err);
  }
  if (!companyDoc) return empty;

  let branch = null;
  if (Array.isArray(companyDoc.branches) && companyDoc.branches.length > 0) {
    branch =
      companyDoc.branches.find(
        (b) => b.useForDocumentation === true || b.useForDocumentation === "true"
      ) || companyDoc.branches[0];
  }

  return {
    name: companyDoc.name || "",
    email: branch?.email || companyDoc.email || "",
    phone: branch?.phone || "",
    website: companyDoc.website || "",
    address: branch?.address || "",
  };
}

/**
 * Resolve {{companyName}}/{{companyPhone}}/… placeholders the signature
 * builder embeds in the rich text. Editors can split a token across spans or
 * inject &nbsp; inside the braces, so the inner text is normalized first.
 */
function applyCompanyTokens(html, ctx) {
  const map = {
    companyName: ctx.name,
    companyEmail: ctx.email,
    companyPhone: ctx.phone,
    companyWebsite: ctx.website,
    companyAddress: ctx.address,
  };
  return String(html || "").replace(/\{\{([\s\S]*?)\}\}/g, (match, inner) => {
    const key = inner
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .trim();
    return key in map ? String(map[key] ?? "") : match;
  });
}

/** Build owner signature block (image + rich text) */
async function getSignatureBlock(ownerId) {
  if (!ownerId) return "";
  const signature = await Signature.findOne({ owner: ownerId });
  if (!signature) return "";

  const img = signature.signatureImage
    ? `<img src="${SERVER_URL}${signature.signatureImage}" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
    : "";
  const signatureText = applyCompanyTokens(
    removeSignatureParagraphMargins(signature.signatureText || ""),
    await getCompanyContext(ownerId)
  );

  return `
    <div style="margin-bottom:12px;">
      ${img}
      <div style="text-align:left;">
         ${signatureText}
      </div>
    </div>
  `;
}


async function getCompanyName(ownerId, providedCompanyName) {
  const explicitName = (providedCompanyName || "").trim();
  if (explicitName) return explicitName;

  if (!ownerId) return COMPANY_NAME;

  const companyDoc = await CompanyProfile.findOne(
    { owner: ownerId },
    { name: 1 }
  ).lean();

  return (companyDoc?.name || "").trim() || COMPANY_NAME;
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
  companyName,
  ownerId,
}) {
  if (!id || !to) throw new Error("Missing 'id' or 'to' for complete profile email");

  // Add the resend marker so the submit handler can send a set-password email.
  // The profileToken is what actually authorises the document endpoints — the
  // employee id alone is not a credential, and these links reach people who do
  // not have a login yet. It expires, so a forwarded or leaked link goes stale.
  const link = `${FRONTEND_BASE_URL}/complete-profile/${id}?from=resend&profileToken=${signProfileToken(id)}`;
  const subject = "🙌 Thank You! Help Me Finalize Your Profile 🚀";
  const signatureBlock = await getSignatureBlock(ownerId);
  const resolvedCompanyName = await getCompanyName(ownerId, companyName);

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
">Thank you again for being such an important part of the <strong>${resolvedCompanyName}</strong> family.</p>
      ${signatureBlock}
    </div>
  `;

  await sendEmail({ to, subject, html });
}

/** Documents an admin can request via the complete-profile form. */
const REQUESTABLE_DOC_LABELS = {
  cnicFront: "CNIC (Front)",
  cnicBack: "CNIC (Back)",
  resume: "CV / Resume",
  matric: "Matric Certificate",
  inter: "Inter Certificate",
  graduate: "Graduate/Bachelor's Certificate",
  masters: "Master's Certificate",
};

/**
 * Sends a "missing documents" request email with the complete-profile link.
 * @param {{id:string,to:string,employeeName?:string,companyName?:string,ownerId?:string,missingDocs:string[]}} p
 */
async function sendMissingDocumentsRequest({
  id,
  to,
  employeeName,
  companyName,
  ownerId,
  missingDocs = [],
}) {
  if (!id || !to) throw new Error("Missing 'id' or 'to' for missing documents email");

  const labels = missingDocs
    .map((key) => REQUESTABLE_DOC_LABELS[key])
    .filter(Boolean);
  if (!labels.length) throw new Error("No valid documents requested");

  const link = `${FRONTEND_BASE_URL}/complete-profile/${id}?profileToken=${signProfileToken(id)}`;
  const subject = "📄 Action Required: Missing Documents for Your Employee Profile";
  const signatureBlock = await getSignatureBlock(ownerId);
  const resolvedCompanyName = await getCompanyName(ownerId, companyName);

  const docListItems = labels
    .map(
      (label) =>
        `<li style="margin-bottom:4px;">📎 <strong>${label}</strong></li>`
    )
    .join("\n");

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif;font-size:15px;line-height:1.7;color:#212121;width:100%">
      <p style="font-size: 15px;line-height: 18px;">Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p style="font-size: 15px;line-height: 22px;">While reviewing your employee profile, our HR team noticed that the following document${labels.length > 1 ? "s are" : " is"} missing from our records:</p>
      <ul style="margin:0 0 1em 2em;padding:0;">
        ${docListItems}
      </ul>
      <p style="font-size: 15px;line-height: 18px;">To keep your records complete and up to date, please upload ${labels.length > 1 ? "them" : "it"} using your profile form:</p>
      <p style="font-size: 15px;line-height: 18px;">
        📝 <strong>
          <a href="${link}" style="color: #0057b7; text-decoration: underline;">
            Click here to upload your missing document${labels.length > 1 ? "s" : ""}
          </a>
        </strong>
      </p>
      <p style="font-size: 15px;line-height: 18px;">It'll only take a few minutes and, as always, your data will be handled with strict confidentiality and care.</p>
      <p style="font-size: 15px;line-height: 18px;">Thank you for being such an important part of the <strong>${resolvedCompanyName}</strong> family.</p>
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
  sendMissingDocumentsRequest,
  REQUESTABLE_DOC_LABELS,
  sendSetPasswordEmail, // optional export if you want to use it elsewhere
};
