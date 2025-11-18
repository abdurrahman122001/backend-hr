const mongoose = require("mongoose");
const OfferEmailTemplate = require("../models/OfferEmailTemplate");
const OfferEmailGenerated = require("../models/OfferEmailGenerated");
const CompanyProfile = require("../models/CompanyProfile");
const Signature = require("../models/Signature");

/* ----------------------------- Env Fallbacks ------------------------------ */
const FALLBACKS = {
  name: "Mavens",
  email: "HR@mavensadvisor.com",
  phone: "+92 312 3850846",
  website: "www.mavensadvisor.com",
  address: "GULSHAN-E-MAYMAR, KARACHI",
};

/* ----------------------------- Helper: Company ---------------------------- */
async function getCompanyContext(ownerId) {
  let companyDoc = null;
  try {
    companyDoc = await CompanyProfile.findOne(
      { owner: ownerId },
      { name: 1, email: 1, website: 1, branches: 1 }
    ).lean();
    
    console.log("🔍 DEBUG Company Profile Found:", companyDoc);
    
  } catch (err) {
    console.error("Error fetching company profile:", err);
  }
  
  // If no company profile found, return fallbacks immediately
  if (!companyDoc) {
    console.log("❌ No company profile found for owner:", ownerId);
    return FALLBACKS;
  }
  
  // Get primary branch address and phone if available
  let address = FALLBACKS.address;
  let phone = FALLBACKS.phone;
  
  if (companyDoc.branches && companyDoc.branches.length > 0) {
    address = companyDoc.branches[0].address || FALLBACKS.address;
    phone = companyDoc.branches[0].phone || FALLBACKS.phone;
  }

  return {
    name: companyDoc.name || FALLBACKS.name,
    email: companyDoc.email || FALLBACKS.email,
    phone: phone,
    website: companyDoc.website || FALLBACKS.website,
    address: address
  };
}

/* --------------------------- Helper: Formatting --------------------------- */
function formatDateDMY(dateInput) {
  if (!dateInput) return "";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "";
  return `${d.getDate()} ${d.toLocaleString("default", {
    month: "long",
  })} ${d.getFullYear()}`;
}

function formatTime12hr(timeStr) {
  if (!timeStr) return "";
  let [h, m] = timeStr.includes(":")
    ? [+timeStr.split(":")[0], timeStr.split(":")[1]]
    : [+timeStr, "00"];
  let suf = "AM";
  if (h >= 12) {
    suf = "PM";
    if (h > 12) h -= 12;
  }
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${suf}`;
}

function formatNumberWithCommas(x) {
  return Number(x).toLocaleString("en-PK");
}

// simple {{placeholder}} -> value renderer (no extra deps)
function render(tpl = "", ctx = {}) {
  let out = String(tpl);
  Object.entries(ctx).forEach(([k, v]) => {
    const re = new RegExp(`{{\\s*${k}\\s*}}`, "g");
    out = out.replace(re, String(v ?? ""));
  });
  return out;
}

/* -------------------- GET current template by key -------------------- */
// GET /api/offer-email?key=offer_letter
exports.getTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");
    const tpl = await OfferEmailTemplate.findOne({ owner, key }).lean();
    
    // Get company context for default template
    const companyCtx = await getCompanyContext(owner);
    
    // Get signature for default template
    const signature = await Signature.findOne({ owner });
    const signatureBlock = signature
      ? `
      <div>
        <br>
        ${
          signature.signatureImage
            ? `<img src="${process.env.SERVER_URL || ""}${
                signature.signatureImage
              }" 
                     alt="Signature" 
                     style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
            : ""
        }
        <div style="text-align:left;">${signature.signatureText || ""}</div>
      </div>
    `
      : "";

    if (!tpl) {
      return res.json({
        owner,
        key,
        subject: "Offer of Employment – {{position}} at {{companyName}}",
        html: `<div style="font-family: Arial, sans-serif; line-height:1.7;">
          <p>Dear <b>{{candidateName}}</b>,</p>
          <p>We're thrilled to have you on board!</p>
          <p>It gives us great pleasure to officially offer you the position of <b>{{position}}</b> at <b>{{companyName}}</b>.</p>
          <p><strong>Company:</strong> ${companyCtx.name}</p>
          <p><strong>Address:</strong> ${companyCtx.address}</p>
          <p><strong>Email:</strong> ${companyCtx.email}</p>
          <p><strong>Phone:</strong> ${companyCtx.phone}</p>
          <p><strong>Website:</strong> ${companyCtx.website}</p>
          <br>
          <p><strong>Start Date:</strong> {{formattedStartDate}}</p>
          <p><strong>Reporting Time:</strong> {{formattedTime}}</p>
          <p><strong>Position:</strong> {{position}}</p>
          <p><strong>Gross Salary:</strong> Rs. {{grossSalary}}</p>
          <p><strong>Probation Period:</strong> {{probationDays}} days</p>
          <p><strong>Confirmation Deadline:</strong> {{formattedDeadline}}</p>
          <br>
          <p>We look forward to welcoming you to our team!</p>
          ${signatureBlock}
        </div>`,
      });
    }
    res.json(tpl);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch template" });
  }
};

/* -------------------- UPSERT template by key -------------------- */
// POST /api/offer-email  body: { key, subject, html }
exports.saveTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const { key = "offer_letter", subject, html } = req.body;
    if (!subject || !html) return res.status(400).json({ error: "subject and html are required" });

    const doc = await OfferEmailTemplate.findOneAndUpdate(
      { owner, key },
      { $set: { subject, html } },
      { new: true, upsert: true }
    );
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save template" });
  }
};

/* ---------- Preview template with sample data ---------- */
// POST /api/offer-email/preview body: { key, subject, html, sampleData }
exports.previewTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const { key = "offer_letter", subject, html, sampleData = {} } = req.body;
    
    if (!subject || !html) {
      return res.status(400).json({ error: "subject and html are required" });
    }

    // Get company context
    const companyCtx = await getCompanyContext(owner);
    
    // Get signature
    const signature = await Signature.findOne({ owner });
    const signatureBlock = signature
      ? `
      <div>
        <br>
        ${
          signature.signatureImage
            ? `<img src="${process.env.SERVER_URL || ""}${
                signature.signatureImage
              }" 
                     alt="Signature" 
                     style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
            : ""
        }
        <div style="text-align:left;">${signature.signatureText || ""}</div>
      </div>
    `
      : "";

    // Build preview context with sample data
    const previewContext = {
      candidateName: sampleData.candidateName || "John Doe",
      position: sampleData.position || "Software Engineer",
      companyName: companyCtx.name,
      companyAddress: companyCtx.address,
      formattedStartDate: sampleData.formattedStartDate || formatDateDMY(new Date()),
      formattedDeadline: sampleData.formattedDeadline || formatDateDMY(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
      formattedTime: sampleData.formattedTime || formatTime12hr("09:00"),
      grossSalary: sampleData.grossSalary || "100,000",
      probationDays: sampleData.probationDays || "90",
      signatureBlock: signatureBlock,
      signatureHtml: signatureBlock,
    };

    // Render preview
    const renderedSubject = render(subject, previewContext);
    const renderedHtml = render(html, previewContext);

    res.json({
      subject: renderedSubject,
      html: renderedHtml,
      context: previewContext
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to generate preview" });
  }
};

/* ---------- Get available template variables ---------- */
// GET /api/offer-email/variables
exports.getTemplateVariables = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const companyCtx = await getCompanyContext(owner);
    
    const variables = {
      candidateName: "Full name of the candidate",
      position: "Job position/designation",
      companyName: companyCtx.name,
      companyAddress: companyCtx.address,
      formattedStartDate: "Formatted start date (e.g., 15 January 2024)",
      formattedDeadline: "Formatted confirmation deadline date",
      formattedTime: "Formatted reporting time (e.g., 9:00 AM)",
      grossSalary: "Formatted gross salary with commas",
      probationDays: "Probation period in days",
      signatureBlock: "Signature block with image and text",
      signatureHtml: "HTML signature block",
    };

    res.json({
      variables,
      companyInfo: {
        name: companyCtx.name,
        email: companyCtx.email,
        phone: companyCtx.phone,
        website: companyCtx.website,
        address: companyCtx.address
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch template variables" });
  }
};

/* ---------- get latest generated for a candidate ---------- */
// GET /api/offer-email/latest?key=offer_letter&candidateEmail=foo@bar.com
exports.getLatestGenerated = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");
    const candidateEmail = String(req.query.candidateEmail || "");
    if (!candidateEmail) return res.status(400).json({ error: "candidateEmail is required" });

    const latest = await OfferEmailGenerated.findOne({ owner, key, candidateEmail })
      .sort({ createdAt: -1 })
      .lean();
    if (!latest) return res.status(404).json({ error: "No generated email found" });
    res.json(latest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch latest generated email" });
  }
};

/* ---------- Get all templates for user ---------- */
// GET /api/offer-email/all
exports.getAllTemplates = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const templates = await OfferEmailTemplate.find({ owner }).lean();
    res.json(templates);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
};

/* ---------- Delete template by key ---------- */
// DELETE /api/offer-email?key=offer_letter
exports.deleteTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");

    const result = await OfferEmailTemplate.deleteOne({ owner, key });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Template not found" });
    }
    res.json({ message: "Template deleted successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete template" });
  }
};

module.exports.render = render;