const mongoose = require("mongoose");

const EmailTemplateSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    key: { type: String, required: true, index: true },       // e.g. "offer_letter"
    name: { type: String, required: true },                   // e.g. "Offer Letter - Default"
    subject: { type: String, required: true },                // Handlebars: "Welcome {{candidateName}}"
    html: { type: String, required: true },                   // Handlebars body (HTML)
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

EmailTemplateSchema.index({ owner: 1, key: 1, isActive: 1 });

module.exports = mongoose.model("EmailTemplate", EmailTemplateSchema);
