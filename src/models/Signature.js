const mongoose = require("mongoose");

const SignatureSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User", // Change if your user model name differs
    required: true,
    unique: true,
  },
  signatureText: {
    type: String,
    required: true,
  },
  signatureImage: {
    type: String, // Store path or URL to the image
  },
});

module.exports = mongoose.model("Signature", SignatureSchema);
