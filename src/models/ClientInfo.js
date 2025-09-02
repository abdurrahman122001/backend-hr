const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const ClientInfoSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "Employee", // Owner employee id
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee", // Manager who created
      required: true,
    },

    clientName: { type: String, required: true },
    companyLocation: { type: String },
    nameInAccountingSoftware: { type: String }, // Name in Xero/QBO
    industry: { type: String },
    natureOfBusiness: { type: String },
    financialYear: { type: String },
    bookkeepingSoftware: { type: String },
    legalBusinessName: { type: String },
    dba: { type: String }, // Doing Business As
    naicsOrSic: { type: String },
    incorporationState: { type: String }, // US only
    websites: { type: [String], default: [] },
    incorporationYear: { type: Number },
    servicesStartDate: { type: String },
    monthlyTransactions: { type: Number },
    accountingBasis: { type: String, enum: ["Cash", "Accrual", "Other"] },
    numberOfBankFeeds: { type: Number },
    taxStatus: { type: String },
  },
  { timestamps: true }
);

module.exports = model("ClientInfo", ClientInfoSchema);
