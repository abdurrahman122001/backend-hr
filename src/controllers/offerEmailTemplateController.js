const mongoose = require("mongoose");
const OfferEmailTemplate = require("../models/OfferEmailTemplate");
const { applyEmailBodyStyles } = require("../utils/removeSignatureParagraphMargins");


const DEFAULT_SUBJECT = "Offer of Employment – {{position}} at {{companyName}}";
const DEFAULT_HTML = `
<div style="font-family: Arial, sans-serif; line-height:1.7;">
  <p style="font-size: 15px;line-height: 18px;">Dear <b>{{safeCandidateName}}</b>,</p>
  <p style="font-size: 15px;line-height: 18px;">We're thrilled to have you on board!</p>
  <p style="font-size: 15px;line-height: 18px;">It gives us great pleasure to officially offer you the position of <b>{{position}}</b> at <b>{{companyName}}</b>.</p>
  <p style="font-size: 15px;line-height: 18px;">Your monthly gross salary will be PKR <b>{{grossSalary}}</b>.</p>
  <p style="font-size: 15px;line-height: 18px;">Start: <b>{{formattedStartDate}}</b> | Report by: <b>{{formattedTime}}</b> | Location: <b>{{companyAddress}}</b></p>
  <p style="font-size: 15px;line-height: 18px;">Probation: <b>{{probationDaysToMonths(probationDays)}}</b></p>
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
      return res.json({ key, subject: DEFAULT_SUBJECT, html: applyEmailBodyStyles(DEFAULT_HTML) });
    }
    return res.json({ key, subject: tpl.subject, html: applyEmailBodyStyles(tpl.html) });
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
