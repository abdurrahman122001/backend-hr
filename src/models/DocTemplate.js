const mongoose = require("mongoose");

const DocTemplateSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true }, // "nda" | "contract" | ...
    canvas: { type: Object, required: true },            // your full canvas JSON
    defaultValues: { type: Object, default: {} },        // default variable values (optional)
  },
  { timestamps: true }
);

DocTemplateSchema.index({ type: 1 }, { unique: true });

module.exports = mongoose.model("DocTemplate", DocTemplateSchema);
