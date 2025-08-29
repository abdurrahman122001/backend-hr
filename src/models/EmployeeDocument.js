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
    cnicUrl:   { type: String, default: "" },  // single PDF for CNIC (front+back together)
    resumeUrl: { type: String, default: "" },

    // Optional metadata
    verified: { type: Boolean, default: false },
    notes:    { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeDocument", EmployeeDocumentSchema);
