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
    clientPhone: { type: String, trim: true },

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
    monthlyTransactions: { type: Number },
    accountingBasis: { type: String }, // Cash / Accrual
    numberOfBankFeeds: { type: Number },
    taxStatus: { type: String },

    // 🔹 UK-specific fields
    region: { type: String },
    postcode: { type: String },
    companyNumber: { type: String },
    sicCode: { type: String },
    vatNumber: { type: String },
    utrNumber: { type: String },
    // 🔹 US-specific fields
    state: { type: String },
    ein: { type: String },

    whatsappPinned: { type: Boolean, default: false },
    whatsappFavourite: { type: Boolean, default: false },
    whatsappMuted: { type: Boolean, default: false },
    whatsappArchived: { type: Boolean, default: false },

    supervision: {
      type: String,
      enum: ["direct", "needs_approval"],
      default: "needs_approval",
    },

    supervisedBy: [
      {
        type: Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],

    // 🔹 CLIENT'S COMPANY EMPLOYEES (NEW)
    companyEmployees: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        designation: {
          type: String,
          required: true,
          trim: true,
        },
        email: {
          type: String,
          trim: true,
          lowercase: true,
        },
        phone: {
          type: String,
          trim: true,
        },
        department: {
          type: String,
          trim: true,
        },
        isPrimaryContact: {
          type: Boolean,
          default: false,
        },
        notes: {
          type: String,
          trim: true,
        },
        addedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    assignedTo: [
      {
        type: Schema.Types.ObjectId,
        ref: "Employee",
        index: true,
      },
    ],

    readBy: [
      {
        employee: { type: Schema.Types.ObjectId, ref: "Employee" },
        readAt: { type: Date, default: Date.now },
      },
    ],

    // 🔹 Metadata
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true },
);
// Create index for efficient assignment queries
ClientInfoSchema.index({ assignedTo: 1 });
ClientInfoSchema.index({ owner: 1, assignedTo: 1 });

module.exports = model("ClientInfo", ClientInfoSchema);
