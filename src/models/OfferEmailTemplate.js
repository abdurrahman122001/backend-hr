const mongoose = require("mongoose");

const OfferEmailTemplateSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    key: { type: String, required: true, index: true }, // e.g. "offer_letter"
    subject: { type: String, required: true },          // supports {{placeholders}}
    html: { type: String, required: true },             // supports {{placeholders}}
  },
  { timestamps: true }
);

// one active template per (owner,key). Keep it simple:
OfferEmailTemplateSchema.index({ owner: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("OfferEmailTemplate", OfferEmailTemplateSchema);
