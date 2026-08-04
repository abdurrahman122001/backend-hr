/**
 * HR policy delivery
 * ------------------
 * Delivers the company's HR policy to an employee as an INTERNAL message in the
 * in-app mail module (Email.tsx / AssignmentMessage) — the employee's id is the
 * receiver — with the policy rendered inline and attached as a PDF.
 *
 * This deliberately does NOT go out over SMTP: the policy stays inside the app's
 * own mailbox, it is not sent to the employee's external (Gmail) address.
 *
 * Triggered automatically when a candidate accepts their offer letter
 * (see watcher.js → offer_acceptance) and manually from HR
 * (POST /api/hr-policies/send/:employeeId).
 */
const PDFDocument = require("pdfkit");
const HrPolicy = require("../models/HrPolicy");
const Employee = require("../models/Employees");
const CompanyProfile = require("../models/CompanyProfile");
const AssignmentMessage = require("../models/AssignmentMessage");
const OrgHierarchy = require("../models/OrgHierarchy");

/* --------------------------------- HTML ---------------------------------- */

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(str = "") {
  return String(str)
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

/**
 * Flatten the ReactQuill HTML the policy editor produces into ordered blocks the
 * PDF writer can lay out. Inline markup is dropped — this is a readable archive
 * copy of the policy, the email body keeps the original HTML.
 */
function htmlToBlocks(html = "") {
  const cleaned = String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n");

  const blocks = [];
  const blockRe =
    /<\s*(h[1-6]|p|li|blockquote|div)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;

  let match;
  while ((match = blockRe.exec(cleaned)) !== null) {
    const tag = match[1].toLowerCase();
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, "")).trim();
    if (!text) continue;
    blocks.push({ tag, text });
  }

  // No recognisable block markup (plain text policy) — keep it as paragraphs.
  if (!blocks.length) {
    const text = decodeEntities(cleaned.replace(/<[^>]+>/g, "")).trim();
    if (text) {
      text
        .split(/\n{2,}/)
        .map((t) => t.trim())
        .filter(Boolean)
        .forEach((t) => blocks.push({ tag: "p", text: t }));
    }
  }

  return blocks;
}

/* ---------------------------------- PDF ---------------------------------- */

const HEADING_SIZES = { h1: 18, h2: 16, h3: 14, h4: 13, h5: 12, h6: 12 };

function buildPolicyPdf({ title, companyName, blocks }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (companyName) {
      doc.font("Helvetica").fontSize(10).fillColor("#666666").text(companyName);
      doc.moveDown(0.5);
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#000000")
      .text(title || "HR Policy");
    doc.moveDown(1);

    for (const block of blocks) {
      if (block.tag.startsWith("h")) {
        doc
          .font("Helvetica-Bold")
          .fontSize(HEADING_SIZES[block.tag] || 14)
          .fillColor("#000000")
          .text(block.text);
        doc.moveDown(0.4);
      } else if (block.tag === "li") {
        doc
          .font("Helvetica")
          .fontSize(11)
          .fillColor("#000000")
          .text(`•  ${block.text}`, { indent: 12 });
        doc.moveDown(0.2);
      } else if (block.tag === "blockquote") {
        doc
          .font("Helvetica-Oblique")
          .fontSize(11)
          .fillColor("#333333")
          .text(block.text, { indent: 18 });
        doc.moveDown(0.4);
      } else {
        doc
          .font("Helvetica")
          .fontSize(11)
          .fillColor("#000000")
          .text(block.text, { align: "left" });
        doc.moveDown(0.5);
      }
    }

    doc.end();
  });
}

/* ------------------------------ Message body ----------------------------- */

function buildMessageHtml({ employeeName, companyName, title, policyHtml }) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif;font-size:15px;line-height:1.7;color:#212121;width:100%">
      <p style="font-size:15px;line-height:1.7;">Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p style="font-size:15px;line-height:1.7;">Welcome aboard! As part of your onboarding, please find the
      <strong>${title}</strong> of ${companyName} below. A PDF copy is attached for your records.</p>
      <p style="font-size:15px;line-height:1.7;">Kindly read it carefully — it covers the working policies,
      conduct and benefits that apply to you from your joining date.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;" />
      <div style="font-size:14px;line-height:1.7;color:#212121;">
        ${policyHtml}
      </div>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;" />
      <p style="font-size:15px;line-height:1.7;">If anything is unclear, just reply to this message and HR will help you out.</p>
      <p style="font-size:15px;line-height:1.7;">Warm regards,<br/>${companyName} HR</p>
    </div>
  `.trim();
}

/* --------------------------------- Sender -------------------------------- */

/**
 * Internal messages need an Employee as `sender`. Use the company's admin
 * employee (the top senior in the hierarchy is flagged isAdmin), else the
 * hierarchy's root manager. Only if the company has neither do we fall back to
 * the recipient — the policy still lands in their mailbox (as a self-message in
 * Sent) rather than being dropped.
 */
async function resolvePolicySender(ownerId, employee) {
  const admin = await Employee.findOne({
    owner: ownerId,
    isAdmin: true,
    status: { $nin: ["offboarded", "terminated"] },
    _id: { $ne: employee._id },
  })
    .select("_id")
    .lean();

  if (admin?._id) return admin._id;

  const rootLink = await OrgHierarchy.findOne({ owner: ownerId })
    .select("rootManager")
    .sort({ hierarchyLevel: 1 })
    .lean();

  if (rootLink?.rootManager && String(rootLink.rootManager) !== String(employee._id)) {
    return rootLink.rootManager;
  }

  return employee._id;
}

/* --------------------------------- Public -------------------------------- */

/**
 * Deliver the HR policy to one employee's in-app mailbox.
 *
 * @param {Object}  opts
 * @param {Object|string} opts.employee   Employee document or id
 * @param {string} [opts.ownerId]         Company owner; defaults to employee.owner
 * @param {boolean}[opts.force=false]     Re-send even if already sent
 * @returns {Promise<{success:boolean, reason?:string, messageId?:string}>}
 */
async function sendHrPolicyToEmployee({ employee, ownerId, force = false }) {
  try {
    const emp =
      employee && employee._id
        ? employee
        : await Employee.findById(employee);

    if (!emp) return { success: false, reason: "employee_not_found" };

    const owner = ownerId || (Array.isArray(emp.owner) ? emp.owner[0] : emp.owner);
    if (!owner) return { success: false, reason: "owner_not_found" };

    if (emp.hrPolicySentAt && !force) {
      return { success: false, reason: "already_sent" };
    }

    const policy = await HrPolicy.findOne({ owner }).lean();
    if (!policy || !policy.content) {
      console.warn(`⚠️ [HrPolicy] No HR policy configured for owner ${owner}`);
      return { success: false, reason: "no_policy_configured" };
    }

    const company = await CompanyProfile.findOne({ owner }).select("name").lean();
    const companyName =
      company?.name || process.env.COMPANY_NAME || "the company";
    const title = policy.title || "HR Policy";

    const pdfBuffer = await buildPolicyPdf({
      title,
      companyName,
      blocks: htmlToBlocks(policy.content),
    });

    const filename = `${title.replace(/[^a-z0-9]+/gi, "-")}.pdf`;
    const html = buildMessageHtml({
      employeeName: emp.name,
      companyName,
      title,
      policyHtml: policy.content,
    });

    // In-app mail only — the employee's id is the receiver.
    const sender = await resolvePolicySender(owner, emp);

    const message = await AssignmentMessage.create({
      owner,
      sender,
      senderType: "employee",
      receiver: [emp._id],
      subject: `${title} – ${companyName}`,
      note: html,
      // Internal mail is outside the client approval flow, so it stores null —
      // the same as any employee-to-employee compose. "approved" would render a
      // green "✓ Approved" badge for an approval that never happened.
      approvalStatus: null,
      status: "sent",
      sentAt: new Date(),
      source: "system",
      isHrPolicy: true,
      isSystemMessage: true,
      attachments: [
        {
          filename,
          originalName: filename,
          mimetype: "application/pdf",
          size: pdfBuffer.length,
          url: `data:application/pdf;base64,${pdfBuffer.toString("base64")}`,
          uploadedAt: new Date(),
          uploadedBy: sender,
        },
      ],
    });

    await Employee.updateOne(
      { _id: emp._id },
      { $set: { hrPolicySentAt: new Date() } }
    );

    console.log(
      `✅ [HrPolicy] Policy delivered in-app to ${emp.name || emp._id} (message: ${message._id})`
    );

    return { success: true, messageId: String(message._id) };
  } catch (err) {
    console.error("❌ [HrPolicy] Failed to deliver HR policy:", err);
    return { success: false, reason: err.message };
  }
}

module.exports = {
  sendHrPolicyToEmployee,
  // exported for tests / reuse
  htmlToBlocks,
  buildPolicyPdf,
};
