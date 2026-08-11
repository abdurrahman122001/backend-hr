const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const bcrypt = require("bcrypt");
const DEFAULT_SHIFT_ID = new mongoose.Types.ObjectId(
  "6849ac46fa83715da425e2b5"
);

// Sub-schemas for Experience/Designation Journey
const PositionSchema = new Schema({
  title: { type: String, required: false },
  startDate: { type: Date, required: false },
  endDate: { type: Date },
  isCurrentRole: { type: Boolean, default: false },
  description: { type: String },
  revisedInSalary: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const PermissionSchema = new Schema(
  {
    canAccessPenalties: { type: Boolean, default: false },
    canCreatePenalties: { type: Boolean, default: false },
    canApprovePenalties: { type: Boolean, default: false },
    canAccessWarnings: { type: Boolean, default: false },
    canCreateWarnings: { type: Boolean, default: false },
    canManageWarningConfig: { type: Boolean, default: false },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User" },
    grantedAt: { type: Date, default: Date.now },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ExperienceSchema = new Schema({
  positions: [PositionSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const EmployeeSchema = new Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // PERSONAL DETAILS
    name: { type: String, required: true, maxlength: 50 }, // Full Name - 50 chars like Gmail
    fatherOrHusbandName: { type: String, maxlength: 50 },
    dateOfBirth: { type: String },
    gender: { type: String },
    nationality: { type: String, maxlength: 50 },
    maritalStatus: { type: String, enum: ["Single", "Married"] },
    religion: { type: String, maxlength: 50 },
    cnic: { type: String, trim: true, default: "", maxlength: 15 }, // CNIC Number - 15 chars formatted
    cnicIssueDate: { type: String },
    cnicExpiryDate: { type: String },
    photographUrl: { type: String }, // Upload Photograph
    cvUrl: { type: String }, // Upload CV
    latestQualification: { type: String, maxlength: 50 },
    fieldOfQualification: { type: String, maxlength: 50 },
    phone: { type: String, maxlength: 20 }, // Mobile Number - 20 chars
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      maxlength: 254, // RFC standard 254 chars
      validate: {
        validator: (v) => typeof v === "string" && v.trim() !== "",
        message: "Email cannot be empty",
      },
    }, // Personal Email Address
    employeeId: { type: String, default: "" }, // System generated employee ID
    companyEmail: { type: String, default: "", maxlength: 254 }, // Office Email Address - 254 chars
    permanentAddress: { type: String, maxlength: 200 }, // 200 chars for address
    presentAddress: { type: String, maxlength: 200 }, // 200 chars for address
    role: { type: String, maxlength: 50 }, // e.g. "Employee", "Manager", "HR", "Admin"

    // BANK DETAILS
    bankName: { type: String, maxlength: 50 },
    bankAccountNumber: { type: String, maxlength: 34 }, // IBAN standard max 34 chars

    // NOMINEE DETAILS
    nomineeName: { type: String, maxlength: 50 },
    nomineeCnic: { type: String, maxlength: 15 },
    nomineeRelation: { type: String, maxlength: 50 }, // Relationship with Nominee
    nomineeNo: { type: String, maxlength: 20 }, // Nominee Number

    // EMERGENCY CONTACT DETAILS
    emergencyContactName: { type: String, maxlength: 50 },
    emergencyContactRelation: { type: String, maxlength: 50 },
    emergencyContactNumber: { type: String, maxlength: 20 },
    setPasswordToken: { type: String },
    setPasswordTokenExpires: { type: Date },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    password: { type: String },
    emergencyNo: { type: String }, // If used

    rt: { type: String, default: "15:00" },

    isNonAttendanceEmployee: { type: Boolean, default: false },

    // EMPLOYMENT DETAILS
    department: { type: String },
    subDepartment: { type: String },
    designation: { type: String },
    joiningDate: { type: String },
    leavingDate: { type: String }, // Last working day / employment end date
    experiences: [ExperienceSchema],

    shifts: {
      type: [{ type: Schema.Types.ObjectId, ref: "Shift" }],
      default: [DEFAULT_SHIFT_ID], // <-- Always select this shift by default!
    },

    supervisionMode: {
      type: String,
      enum: ["direct", "needs_approval"],
      default: "direct",
      index: true,
    },
    // Optional fixed Team Lead who must approve (used when needs_approval)
    supervisor: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    blockedUsers: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
        },
        blockedAt: {
          type: Date,
          default: Date.now,
        },
        reason: String,
      },
    ],
    noticePeriod: { type: Number, default: 0 },
    // User link (for future use)
    userAccount: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    // Admin access — super admin can grant this employee access to the admin dashboard
    isAdmin: { type: Boolean, default: false },
    // WhatsApp sidebar chats this employee manually marked as unread
    // (chat keys: "<clientId>", "client_employee_<clientId>_<employeeId>",
    // "group_<groupId>"). Cleared when the chat is opened / marked read.
    manualUnreadChats: { type: [String], default: [] },
    // Monetary bonus/cash awarded via admin approvals
    bonusCash: { type: Number, default: 0 },
    providentFund: {
      pfRate: { type: Number }, // If null, use global
      years: { type: Number },
      override: { type: Boolean, default: false },
    },

    // NDA/Contract
    ndaGenerated: { type: Boolean, default: false },
    ndaPath: { type: String },
    contractPath: { type: String },
    // Onboarding policies: set when the HR policy was emailed to this employee
    // (automatically on offer acceptance, or manually re-sent by HR). Also used
    // to keep the automatic send idempotent.
    hrPolicySentAt: { type: Date, default: null },
    // NOTE: trusted devices were moved to their own `TrustedDevice` collection
    // (models/TrustedDevice.js). Do not re-add them here.
    permissions: PermissionSchema,
    // Timestamp of when this employee last opened the GoogleChat "Mentions"
    // view. Mentions created after this are counted as unread (drives the
    // sidebar Mentions badge / bold state).
    mentionsSeenAt: { type: Date, default: null },
    status: {
      type: String,
      // Onboarding lifecycle, in order:
      //   Offered              → offer letter sent (offerLetterController)
      //   Onboarding           → candidate accepted (watcher: offer_acceptance)
      //   Document Submitted   → CNIC/CV received (watcher: document path)
      //   review               → password set after completing the profile
      //   active               → approved by HR
      // "Document Submitted" was written by the watcher via findOneAndUpdate,
      // which skips validators, so it persisted while missing here — every
      // later emp.save() on that document then failed validation.
      enum: [
        "active",
        "Offered",
        "Onboarding",
        "Document Submitted",
        "review",
        "resigned",
        "offboarded",
        "terminated",
      ],
      default: "Offered",
    },
    resignationDate: { type: String }, // Date when employee resigned
    noticePeriodEndDate: { type: String }, // Calculated date when notice period ends (resignationDate + 30 days)

    terminationDate: { type: String },
    resignationReason: { type: String },
    isTrashed: { type: Boolean, default: false },
    trashedAt: { type: Date },
    trashedBy: { type: Schema.Types.ObjectId, ref: "User" },

    emojiUsage: {
      type: [{ emoji: String, count: { type: Number, default: 1 } }],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Index for unique emails
EmployeeSchema.index(
  { email: 1 },
  {
    unique: true,
    sparse: true,
  }
);
EmployeeSchema.index({ isTrashed: 1 });
EmployeeSchema.index({ trashedAt: 1 });
EmployeeSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};
EmployeeSchema.index({ blockedUsers: 1 });

// Method to check if user is blocked
EmployeeSchema.methods.hasBlocked = function (userId) {
  return this.blockedUsers.some(
    (blocked) => blocked.user.toString() === userId.toString()
  );
};

// Method to check if user is blocked by someone
EmployeeSchema.statics.isBlockedBy = async function (userId, blockerId) {
  const blocker = await this.findById(blockerId).select("blockedUsers");
  return blocker ? blocker.hasBlocked(userId) : false;
};

// Method to get mutual block status
EmployeeSchema.statics.getBlockStatus = async function (user1Id, user2Id) {
  const user1 = await this.findById(user1Id).select("blockedUsers");
  const user2 = await this.findById(user2Id).select("blockedUsers");

  return {
    user1BlockedUser2: user1 ? user1.hasBlocked(user2Id) : false,
    user2BlockedUser1: user2 ? user2.hasBlocked(user1Id) : false,
    isMutualBlock:
      (user1 ? user1.hasBlocked(user2Id) : false) &&
      (user2 ? user2.hasBlocked(user1Id) : false),
    canCommunicate: !(
      (user1 ? user1.hasBlocked(user2Id) : false) ||
      (user2 ? user2.hasBlocked(user1Id) : false)
    ),
  };
};

// Update timestamp for experiences when saving
EmployeeSchema.pre("save", function (next) {
  this.$locals.removeFromChatMemberships =
    this.isModified("status") &&
    String(this.status || "").toLowerCase() !== "active";

  // The mirror image: finishing onboarding (or moving department) puts them in
  // the company + department groups. Hooked on the model rather than in a
  // controller because HR approval reaches "active" through several paths.
  this.$locals.syncSystemGroups =
    (this.isModified("status") || this.isModified("department")) &&
    String(this.status || "").toLowerCase() === "active";

  if (this.experiences && this.isModified("experiences")) {
    this.experiences.forEach((exp) => {
      exp.updatedAt = new Date();
      if (exp.positions) {
        exp.positions.forEach((pos) => {
          pos.updatedAt = new Date();
        });
      }
    });
  }
  // Update permissions timestamp if modified
  if (this.isModified("permissions")) {
    if (!this.permissions.updatedAt) {
      this.permissions = new PermissionSchema();
    }
    this.permissions.updatedAt = new Date();
  }

  next();
});

const getStatusFromUpdate = (update = {}) =>
  update.status ?? update.$set?.status ?? update.$setOnInsert?.status;

const captureEmployeesLeavingActiveStatus = async function (next) {
  try {
    const status = getStatusFromUpdate(this.getUpdate());
    if (
      status === undefined ||
      String(status || "").toLowerCase() === "active"
    ) {
      this._removeFromChatMembershipIds = [];
      return next();
    }

    this._removeFromChatMembershipIds = await this.model
      .find(this.getQuery())
      .distinct("_id");
    next();
  } catch (error) {
    next(error);
  }
};

const removeCapturedEmployeesFromChat = async function () {
  const employeeIds = this._removeFromChatMembershipIds || [];
  if (employeeIds.length === 0) return;

  const {
    removeEmployeesFromChatMemberships,
  } = require("../services/chatMembershipService");
  await removeEmployeesFromChatMemberships(employeeIds);
};

// The joining side of the same story. An update that could not have changed
// either field is left alone, so ordinary employee edits cost nothing.
const captureEmployeesJoiningSystemGroups = async function (next) {
  try {
    const update = this.getUpdate() || {};
    const touches = (field) =>
      update[field] !== undefined ||
      update.$set?.[field] !== undefined ||
      update.$setOnInsert?.[field] !== undefined;

    if (!touches("status") && !touches("department")) {
      this._syncSystemGroupIds = [];
      return next();
    }

    this._syncSystemGroupIds = await this.model
      .find(this.getQuery())
      .distinct("_id");
    next();
  } catch (error) {
    next(error);
  }
};

const syncCapturedEmployeesIntoSystemGroups = async function () {
  const employeeIds = this._syncSystemGroupIds || [];
  if (employeeIds.length === 0) return;

  const {
    syncSystemGroupsForEmployee,
  } = require("../services/systemGroupService");
  // Sequential on purpose: several employees changing at once would otherwise
  // race to create the same group.
  for (const employeeId of employeeIds) {
    await syncSystemGroupsForEmployee({ employeeId });
  }
};

EmployeeSchema.post("save", async function () {
  if (this.$locals.syncSystemGroups) {
    const {
      syncSystemGroupsForEmployee,
    } = require("../services/systemGroupService");
    await syncSystemGroupsForEmployee({ employeeId: this._id });
  }

  if (!this.$locals.removeFromChatMemberships) return;

  const {
    removeEmployeesFromChatMemberships,
  } = require("../services/chatMembershipService");
  await removeEmployeesFromChatMemberships([this._id]);
});

["findOneAndUpdate", "updateOne", "updateMany"].forEach((operation) => {
  EmployeeSchema.pre(operation, captureEmployeesLeavingActiveStatus);
  EmployeeSchema.pre(operation, captureEmployeesJoiningSystemGroups);
  EmployeeSchema.post(operation, removeCapturedEmployeesFromChat);
  EmployeeSchema.post(operation, syncCapturedEmployeesIntoSystemGroups);
});

module.exports = model("Employee", EmployeeSchema);
