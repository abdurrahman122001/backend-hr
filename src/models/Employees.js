const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const bcrypt = require("bcrypt");
const DEFAULT_SHIFT_ID = new mongoose.Types.ObjectId(
  "6849ac46fa83715da425e2b5"
);

const EmployeeSchema = new Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // PERSONAL DETAILS
    name: { type: String, required: true }, // Full Name
    fatherOrHusbandName: { type: String },
    dateOfBirth: { type: String },
    gender: { type: String },
    nationality: { type: String },
    maritalStatus: { type: String, enum: ["Single", "Married"] },
    religion: { type: String },
    cnic: { type: String, trim: true, default: "" }, // CNIC Number
    cnicIssueDate: { type: String },
    cnicExpiryDate: { type: String },
    photographUrl: { type: String }, // Upload Photograph
    cvUrl: { type: String }, // Upload CV
    latestQualification: { type: String },
    fieldOfQualification: { type: String },
    phone: { type: String }, // Mobile Number
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      validate: {
        validator: (v) => typeof v === "string" && v.trim() !== "",
        message: "Email cannot be empty",
      },
    }, // Personal Email Address
    companyEmail: { type: String, default: "" }, // Office Email Address
    permanentAddress: { type: String },
    presentAddress: { type: String },
    role: { type: String }, // e.g. "Employee", "Manager", "HR", "Admin"

    // BANK DETAILS
    bankName: { type: String },
    bankAccountNumber: { type: String },

    // NOMINEE DETAILS
    nomineeName: { type: String },
    nomineeCnic: { type: String },
    nomineeRelation: { type: String }, // Relationship with Nominee
    nomineeNo: { type: String }, // Nominee Number

    // EMERGENCY CONTACT DETAILS
    emergencyContactName: { type: String },
    emergencyContactRelation: { type: String },
    emergencyContactNumber: { type: String },
    setPasswordToken: { type: String },
    setPasswordTokenExpires: { type: Date },
    password: { type: String }, // Hash, can be null until set
    // (OPTIONAL) If you want to keep emergencyNo separately
    emergencyNo: { type: String }, // If used

    rt: { type: String, default: "15:30" },

    // EMPLOYMENT DETAILS
    department: { type: String },
    designation: { type: String },
    joiningDate: { type: String },
    leavingDate: { type: String }, // Last working day / employment end date

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

    // LEAVE ENTITLEMENT
    leaveEntitlement: {
      total: { type: Number, default: 22 },
      bonus: { type: Number, default: 0 },
      bonusHoursAccumulated: { type: Number, default: 0 },
      bonusYear: { type: Number }, // required for yearly reset
      usedPaid: { type: Number, default: 0 },
      usedUnpaid: { type: Number, default: 0 },
    },

    // COMPENSATION DETAILS (all fields now STRING for encryption)
    compensation: {
      basic: { type: String, default: "" },
      dearnessAllowance: { type: String, default: "" },
      houseRentAllowance: { type: String, default: "" },
      conveyanceAllowance: { type: String, default: "" },
      medicalAllowance: { type: String, default: "" },
      utilityAllowance: { type: String, default: "" },
      overtimeComp: { type: String, default: "" },
      dislocationAllowance: { type: String, default: "" },
      leaveEncashment: { type: String, default: "" },
      bonus: { type: String, default: "" },
      arrears: { type: String, default: "" },
      autoAllowance: { type: String, default: "" },
      incentive: { type: String, default: "" },
      fuelAllowance: { type: String, default: "" },
      others: { type: String, default: "" },
      grossSalary: { type: String, default: "" },
    },

    // DEDUCTIONS (all fields now STRING for encryption)
    deductions: {
      leaveDeductions: { type: String, default: "" },
      lateDeductions: { type: String, default: "" },
      eobi: { type: String, default: "" },
      sessi: { type: String, default: "" },
      providentFund: { type: String, default: "" },
      gratuityFund: { type: String, default: "" },
      loanDeductions: {
        vehicleLoan: { type: String, default: "" },
        otherLoans: { type: String, default: "" },
      },
      advanceSalary: { type: String, default: "" },
      medicalInsurance: { type: String, default: "" },
      lifeInsurance: { type: String, default: "" },
      penalties: { type: String, default: "" },
      others: { type: String, default: "" },
      tax: { type: String, default: "" },
    },

    // User link (for future use)
    userAccount: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    providentFund: {
      pfRate: { type: Number }, // If null, use global
      years: { type: Number },
      override: { type: Boolean, default: false },
    },

    // NDA/Contract
    ndaGenerated: { type: Boolean, default: false },
    ndaPath: { type: String },
    contractPath: { type: String },
    trustedDevices: [
      {
        deviceId: { type: String, required: false }, // permanent token
        deviceFingerprint: { type: String },
        userAgent: { type: String },
        ip: { type: String },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    // EMPLOYMENT STATUS FIELDS - UPDATED
    status: {
      type: String,
      enum: ["active", "pending", "resigned", "offboarded", "terminated"],
      default: "pending",
    },
    resignationDate: { type: String }, // Date when employee resigned
    noticePeriodEndDate: { type: String }, // Calculated date when notice period ends (resignationDate + 30 days)

    terminationDate: { type: String },
    resignationReason: { type: String },
    isTrashed: { type: Boolean, default: false },
    trashedAt: { type: Date },
    trashedBy: { type: Schema.Types.ObjectId, ref: "User" },
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
module.exports = model("Employee", EmployeeSchema);
