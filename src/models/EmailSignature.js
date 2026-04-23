const mongoose = require("mongoose");

const EmailSignatureSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
    required: true,
    unique: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  signatureText: {
    type: String,
    default: "",
  },
}, { timestamps: true });

module.exports = mongoose.model("EmailSignature", EmailSignatureSchema);
