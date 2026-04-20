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
  } catch (err) {
    console.error("Error fetching company profile:", err);
  }

  if (!companyDoc) {
    return FALLBACKS;
  }

  let selectedBranch = null;

  if (companyDoc.branches && companyDoc.branches.length > 0) {
    selectedBranch = companyDoc.branches.find(
      (b) =>
        b.useForDocumentation === true ||
        b.useForDocumentation === "true"
    );

    if (!selectedBranch) {
      selectedBranch = companyDoc.branches[0];
    }
  }

  const address = selectedBranch?.address || FALLBACKS.address;
  const phone = selectedBranch?.phone || FALLBACKS.phone;
  const email =
    selectedBranch?.email || companyDoc.email || FALLBACKS.email;

  return {
    name: companyDoc.name || FALLBACKS.name,
    email: email,
    phone: phone,
    website: companyDoc.website || FALLBACKS.website,
    address: address,
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

// simple {{placeholder}} -> value renderer
function render(tpl = "", ctx = {}) {
  let out = String(tpl);
  Object.entries(ctx).forEach(([k, v]) => {
    const re = new RegExp(`{{\\s*${k}\\s*}}`, "g");
    out = out.replace(re, String(v ?? ""));
  });
  return out;
}

/* -------------------- GET current template by key -------------------- */
exports.getTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");
    const tpl = await OfferEmailTemplate.findOne({ owner, key }).lean();

    const companyCtx = await getCompanyContext(owner);

    const signature = await Signature.findOne({ owner });
    const signatureBlock = signature
      ? `
      <div>
        <br>
        ${
          signature.signatureImage
            ? `<img src="${process.env.SERVER_URL || ""}${signature.signatureImage}"
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
        html: `
          <div style="font-family: Arial, sans-serif; line-height:1.7;">

            <p>Dear <b>{{candidateName}}</b>,</p>

            <p>We are pleased to offer you the position of <b>{{position}}</b> in our <b>{{department}}</b> department at <b>{{companyName}}</b>.</p>

            <p><strong>Company:</strong> {{companyName}}</p>
            <p><strong>Address:</strong> {{companyAddress}}</p>
            <p><strong>Email:</strong> {{companyEmail}}</p>
            <p><strong>Phone:</strong> {{companyPhone}}</p>
            <p><strong>Website:</strong> {{companyWebsite}}</p>

            <br>

            <p><strong>Department:</strong> {{department}}</p>
            <p><strong>Start Date:</strong> {{formattedStartDate}}</p>
            <p><strong>Reporting Time:</strong> {{formattedTime}}</p>
            <p><strong>Gross Salary:</strong> Rs. {{grossSalary}}</p>
            <p><strong>Probation Period:</strong> {{probationDays}} days</p>
            <p><strong>Confirmation Deadline:</strong> {{formattedDeadline}}</p>

            <br>
            <p>We look forward to welcoming you!</p>

            ${signatureBlock}

          </div>
        `,
      });
    }

    res.json(tpl);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch template" });
  }
};

/* -------------------- UPSERT template by key -------------------- */
exports.saveTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const { key = "offer_letter", subject, html } = req.body;
    if (!subject || !html)
      return res.status(400).json({ error: "subject and html are required" });

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

/* -------------------- PREVIEW TEMPLATE -------------------- */
exports.previewTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const { key = "offer_letter", subject, html, sampleData = {} } = req.body;

    if (!subject || !html)
      return res.status(400).json({ error: "subject and html are required" });

    const companyCtx = await getCompanyContext(owner);

    const signature = await Signature.findOne({ owner });
    const signatureBlock = signature
      ? `
      <div>
        <br>
        ${
          signature.signatureImage
            ? `<img src="${process.env.SERVER_URL || ""}${signature.signatureImage}"
                   alt="Signature"
                   style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
            : ""
        }
        <div style="text-align:left;">${signature.signatureText || ""}</div>
      </div>
    `
      : "";

    const previewContext = {
      candidateName: sampleData.candidateName || "John Doe",
      position: sampleData.position || "Software Engineer",
      department: sampleData.department || "Engineering", // Added department

      // FULL COMPANY INFO
      companyName: companyCtx.name,
      companyAddress: companyCtx.address,
      companyEmail: companyCtx.email,
      companyPhone: companyCtx.phone,
      companyWebsite: companyCtx.website,

      formattedStartDate:
        sampleData.formattedStartDate || formatDateDMY(new Date()),
      formattedDeadline:
        sampleData.formattedDeadline ||
        formatDateDMY(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
      formattedTime: sampleData.formattedTime || formatTime12hr("09:00"),
      grossSalary: sampleData.grossSalary || "100,000",
      probationDays: sampleData.probationDays || "90",

      signatureBlock,
      signatureHtml: signatureBlock,
    };

    const renderedSubject = render(subject, previewContext);
    const renderedHtml = render(html, previewContext);

    res.json({
      subject: renderedSubject,
      html: renderedHtml,
      context: previewContext,
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to generate preview" });
  }
};

/* -------------------- GET TEMPLATE VARIABLES -------------------- */
exports.getTemplateVariables = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const companyCtx = await getCompanyContext(owner);

    const variables = {
      candidateName: "Full name of candidate",
      position: "Job title",
      department: "Department name", // Added department variable
      companyName: companyCtx.name,
      companyAddress: companyCtx.address,
      companyEmail: companyCtx.email,
      companyPhone: companyCtx.phone,
      companyWebsite: companyCtx.website,
      formattedStartDate: "Start date",
      formattedDeadline: "Confirmation deadline",
      formattedTime: "Reporting time",
      grossSalary: "Formatted salary",
      probationDays: "Probation period (days)",
      signatureBlock: "Full signature block HTML",
      signatureHtml: "Alias of signatureBlock",
    };

    res.json({
      variables,
      companyInfo: companyCtx,
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch template variables" });
  }
};

/* -------------------- GET LATEST GENERATED EMAIL -------------------- */
exports.getLatestGenerated = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");
    const candidateEmail = String(req.query.candidateEmail || "");

    if (!candidateEmail)
      return res.status(400).json({ error: "candidateEmail is required" });

    const latest = await OfferEmailGenerated.findOne({
      owner,
      key,
      candidateEmail,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!latest)
      return res.status(404).json({ error: "No generated email found" });

    res.json(latest);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch latest generated email" });
  }
};

/* -------------------- GET ALL USER TEMPLATES -------------------- */
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

/* -------------------- DELETE TEMPLATE -------------------- */
exports.deleteTemplate = async (req, res) => {
  try {
    const owner = new mongoose.Types.ObjectId(req.user?._id || req.req_id);
    const key = String(req.query.key || "offer_letter");

    const result = await OfferEmailTemplate.deleteOne({ owner, key });

    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Template not found" });

    res.json({ message: "Template deleted successfully" });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete template" });
  }
};

module.exports.render = render;