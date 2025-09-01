const mongoose = require("mongoose");

const OfferEmailGeneratedSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    key: { type: String, default: "offer_letter", index: true },
    candidateEmail: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    context: { type: Object }, // optional: keep the data used to render
  },
  { timestamps: true }
);

OfferEmailGeneratedSchema.index({ owner: 1, candidateEmail: 1, createdAt: -1 });

module.exports = mongoose.model("OfferEmailGenerated", OfferEmailGeneratedSchema);
