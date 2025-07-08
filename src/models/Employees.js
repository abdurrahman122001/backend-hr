const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const EmployeeSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // PERSONAL DETAILS
    name: { type: String, required: true }, // Full Name
    fatherOrHusbandName: { type: String },
    dateOfBirth: { type: String }, // Could be Date, but matching your frontend
    gender: { type: String },
    nationality: { type: String },
    maritalStatus: { type: String, enum: ["Single", "Married"] },
    religion: { type: String },
    cnic: { type: String, trim: true, default: "" }, // CNIC Number
    cnicIssueDate: { type: String },
    cnicExpiryDate: { type: String },
    photographUrl: { type: String },      // Upload Photograph
    cvUrl: { type: String },              // Upload CV
    latestQualification: { type: String },
    fieldOfQualification: { type: String },
    phone: { type: String },              // Mobile Number
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      validate: {
        validator: (v) => typeof v === "string" && v.trim() !== "",
        message: "Email cannot be empty",
      },
    },                                   // Personal Email Address
    companyEmail: { type: String, default: "" }, // Office Email Address
    permanentAddress: { type: String },
    presentAddress: { type: String },

    // BANK DETAILS
    bankName: { type: String },
    bankAccountNumber: { type: String },

    // NOMINEE DETAILS
    nomineeName: { type: String },
    nomineeCnic: { type: String },
    nomineeRelation: { type: String },      // Relationship with Nominee
    nomineeNo: { type: String },            // Nominee Number

    // EMERGENCY CONTACT DETAILS
    emergencyContactName: { type: String },
    emergencyContactRelation: { type: String },
    emergencyContactNumber: { type: String },

    // (OPTIONAL) If you want to keep emergencyNo separately
    emergencyNo: { type: String }, // If used

    rt: { type: String, default: "15:15" }, // Reporting Time

    // EMPLOYMENT DETAILS
    department: { type: String },
    designation: { type: String },
    joiningDate: { type: String },
    shifts: [{ type: Schema.Types.ObjectId, ref: "Shift" }],

    // LEAVE ENTITLEMENT
    leaveEntitlement: {
      total: { type: Number, default: 22 },
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

    // NDA/Contract
    ndaGenerated: { type: Boolean, default: false },
    ndaPath: { type: String },
    contractPath: { type: String },
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

module.exports = model("Employee", EmployeeSchema);
