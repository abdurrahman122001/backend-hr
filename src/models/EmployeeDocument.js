const mongoose = require("mongoose");

const EmployeeDocumentSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      unique: true, // one doc bundle per employee
    },

    // File URLs (relative to server, e.g. /uploads/...)
    cnicFrontUrl: { type: String, default: "" }, // PDF for CNIC front
    cnicBackUrl: { type: String, default: "" }, // PDF for CNIC back
    resumeUrl: { type: String, default: "" },

    // Optional metadata
    verified: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeDocument", EmployeeDocumentSchema);
