// backend/src/models/ClientInfo.js
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
    monthlyTransactions: { type: Number },
    accountingBasis: { type: String }, // Cash / Accrual
    numberOfBankFeeds: { type: Number },
    taxStatus: { type: String },

    // Assignment
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = model("ClientInfo", ClientInfoSchema);
