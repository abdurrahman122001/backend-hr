const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const ClientInfoSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Core identity
    clientName: { type: String, required: true, trim: true },
    clientEmail: { type: String, required: true, trim: true, lowercase: true },
    country: { type: String, required: true },
    country: { type: String, required: true },

    // 🔹 Location and general info
    companyLocation: { type: String },
    nameInAccountingSoftware: { type: String }, // Xero/QBO
    industry: { type: String },
    natureOfBusiness: { type: String },
    financialYear: { type: String },
    bookkeepingSoftware: { type: String },
    legalBusinessName: { type: String },
    dba: { type: String },
    naicsOrSic: { type: String },
    incorporationState: { type: String }, // US only
    websites: [{ type: String }],
    incorporationYear: { type: String }, // keep string for flexibility
    servicesStartDate: { type: String }, // YYYY-MM-DD
    incorporationYear: { type: String },
    servicesStartDate: { type: String },   // YYYY-MM-DD
    monthlyTransactions: { type: Number },
    accountingBasis: { type: String }, // Cash / Accrual
    numberOfBankFeeds: { type: Number },
    taxStatus: { type: String },
    websites: [{ type: String }],

    // 🔹 UK-specific fields
    region: { type: String },           // England / Scotland / Wales / N. Ireland
    postcode: { type: String },
    companyNumber: { type: String },
    sicCode: { type: String },
    vatNumber: { type: String },
    utrNumber: { type: String },

    // 🔹 Assignment
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
      index: true,
    },

    // 🔹 Metadata
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
);

module.exports = model("ClientInfo", ClientInfoSchema);
