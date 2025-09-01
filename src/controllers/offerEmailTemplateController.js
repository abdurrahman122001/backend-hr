const mongoose = require("mongoose");
const OfferEmailTemplate = require("../models/OfferEmailTemplate");

const DEFAULT_SUBJECT = "Offer of Employment – {{position}} at {{companyName}}";
const DEFAULT_HTML = `
<div style="font-family: Arial, sans-serif; line-height:1.7;">
  <p>Dear <b>{{safeCandidateName}}</b>,</p>
  <p>We're thrilled to have you on board!</p>
  <p>It gives us great pleasure to officially offer you the position of <b>{{position}}</b> at <b>{{companyName}}</b>.</p>
  <p>Your monthly gross salary will be PKR <b>{{grossSalary}}</b>.</p>
  <p>Start: <b>{{formattedStartDate}}</b> | Report by: <b>{{formattedTime}}</b> | Location: <b>{{companyAddress}}</b></p>
  <p>Probation: <b>{{probationDaysToMonths(probationDays)}}</b></p>
  {{signatureBlock}}
</div>
`.trim();

async function getOfferEmailTemplate(req, res) {
  try {
    const key = String(req.query.key || "offer_letter");
    let ownerId = req.user._id;
    if (!(ownerId instanceof mongoose.Types.ObjectId)) {
      ownerId = new mongoose.Types.ObjectId(ownerId);
    }
    const tpl = await OfferEmailTemplate.findOne({ owner: ownerId, key }).lean();
    if (!tpl) {
      return res.json({ key, subject: DEFAULT_SUBJECT, html: DEFAULT_HTML });
    }
    return res.json({ key, subject: tpl.subject, html: tpl.html });
  } catch (e) {
    return res.status(500).json({ error: "Failed to fetch template" });
  }
}

async function saveOfferEmailTemplate(req, res) {
  try {
    const { key = "offer_letter", subject = DEFAULT_SUBJECT, html = DEFAULT_HTML } = req.body || {};
    let ownerId = req.user._id;
    if (!(ownerId instanceof mongoose.Types.ObjectId)) {
      ownerId = new mongoose.Types.ObjectId(ownerId);
    }
    const doc = await OfferEmailTemplate.findOneAndUpdate(
      { owner: ownerId, key },
      { $set: { subject, html } },
      { upsert: true, new: true }
    ).lean();
    return res.json({ key: doc.key, subject: doc.subject, html: doc.html });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save template" });
  }
}

module.exports = { getOfferEmailTemplate, saveOfferEmailTemplate };
