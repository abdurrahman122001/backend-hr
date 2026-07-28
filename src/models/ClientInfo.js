const mongoose = require("mongoose");
const { Schema, model } = mongoose;

// A contact person inside the client's organisation. Used both at client level
// (ClientInfo.companyEmployees — the legacy/company-wide contacts) and per
// business (ClientInfo.businesses[].companyEmployees), so the shape stays
// identical wherever a client contact is edited.
const CompanyEmployeeSchema = new Schema({
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
  // Separate email signature for this client employee — auto-inserted
  // when composing an email addressed to this specific employee.
  emailSignature: {
    type: String,
    default: "",
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
});

// One client can operate several businesses (separate trading entities under
// the same relationship). Each business carries its OWN email, its OWN assigned
// team members and its OWN contacts at the client's side.
const BusinessSchema = new Schema({
  businessName: { type: String, required: true, trim: true },
  legalBusinessName: { type: String, trim: true },
  dba: { type: String, trim: true },

  // Business-specific email — used instead of the client-level clientEmail when
  // corresponding about this business.
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },

  industry: { type: String, trim: true },
  natureOfBusiness: { type: String, trim: true },
  companyLocation: { type: String, trim: true },

  // Our team members responsible for THIS business (independent of the
  // client-level ClientInfo.assignedTo).
  assignedTo: [
    {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
  ],

  // The client's own staff for this business.
  companyEmployees: [CompanyEmployeeSchema],

  // Signature auto-inserted when composing to this business's email.
  emailSignature: { type: String, default: "" },

  notes: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now },
});

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
    companyEmployees: [CompanyEmployeeSchema],

    // 🔹 CLIENT'S BUSINESSES — a client may run multiple businesses, each with
    // its own email, its own assigned team members and its own contacts.
    businesses: [BusinessSchema],

    // NOTE: the client-level emailSignature has moved to the business
    // (businesses[].emailSignature) — signatures belong to the business whose
    // address the mail is sent from. Kept only so existing records are readable
    // during migration; nothing writes it any more.
    emailSignature: {
      type: String,
      default: "",
    },

    // ⚠️ DERIVED — do not assign to this directly. Employees are assigned per
    // business (businesses[].assignedTo); this array is the union of those and
    // is rebuilt by syncClientAssignees() on every business-assignment change.
    // It stays because the rest of the app keys off it: WhatsApp chat lists,
    // email routing, client visibility queries and chat-space membership.
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
// Per-business assignment lookups ("which businesses am I assigned to")
ClientInfoSchema.index({ owner: 1, "businesses.assignedTo": 1 });
// Inbound email routing can match a business address as well as clientEmail
ClientInfoSchema.index({ owner: 1, "businesses.email": 1 });

module.exports = model("ClientInfo", ClientInfoSchema);
