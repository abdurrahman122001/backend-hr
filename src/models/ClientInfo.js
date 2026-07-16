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
    // Client engagement: ongoing (recurring) or a one-off project with a
    // defined start/end date.
    engagementType: {
      type: String,
      enum: ["one_off", "recurring"],
      default: "recurring",
    },
    engagementStartDate: { type: String }, // YYYY-MM-DD (one-off only)
    engagementEndDate: { type: String }, // YYYY-MM-DD (one-off only)

    // Services agreed for this client (multi-select in the client form),
    // each marked as recurring or one-off work.
    scopeOfWork: [
      {
        _id: false,
        service: { type: String, required: true },
        billing: {
          type: String,
          enum: ["one_off", "recurring"],
          default: "recurring",
        },
      },
    ],
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
        photographUrl: {
          type: String,
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

    // Google-Chat space auto-created for this client (see clientSpaceService).
    chatSpace: {
      type: Schema.Types.ObjectId,
      ref: "Space",
      default: null,
    },

    readBy: [
      {
        employee: { type: Schema.Types.ObjectId, ref: "Employee" },
        readAt: { type: Date, default: Date.now },
      },
    ],

    // Denormalized last-message snapshot for fast WhatsApp sidebar (updated on every send/approve)
    lastWhatsAppMessage: {
      text:      { type: String, default: null },
      at:        { type: Date,   default: null },
      senderId:  { type: Schema.Types.ObjectId, ref: "Employee", default: null },
      hasAttachments: { type: Boolean, default: false },
      // true when the latest message was "deleted for everyone" — the sidebar
      // shows the "This message was deleted" placeholder, like WhatsApp.
      deleted:   { type: Boolean, default: false },
    },

    // Client photo
    photographUrl: { type: String },

    // Client active/inactive status
    isActive: { type: Boolean, default: true },

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
// Supports the $or supervisedBy branch in getChatList (was a collection scan)
ClientInfoSchema.index({ owner: 1, supervisedBy: 1 });
ClientInfoSchema.index({ owner: 1, "lastWhatsAppMessage.at": -1 });

module.exports = model("ClientInfo", ClientInfoSchema);
