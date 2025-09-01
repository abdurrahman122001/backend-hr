const mongoose = require("mongoose");
const OfferEmailTemplate = require("../models/OfferEmailTemplate");
const OfferEmailGenerated = require("../models/OfferEmailGenerated");

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
    if (!tpl) {
      return res.json({
        owner,
        key,
        subject: "Offer of Employment – {{position}} at {{companyName}}",
        html: `<div><p>Dear <b>{{candidateName}}</b>,</p><p>We’re excited to offer you the role of <b>{{position}}</b> at <b>{{companyName}}</b>.</p></div>`,
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

/* ---------- (Optional) get latest generated for a candidate ---------- */
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

module.exports.render = render;
