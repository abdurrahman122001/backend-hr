const mongoose = require("mongoose");

const hrPolicySchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one policy per owner
    },
    title: { type: String, required: true },
    content: { type: String, required: true }, // HTML from ReactQuill
  },
  { timestamps: true }
);

module.exports = mongoose.model("HrPolicy", hrPolicySchema);
