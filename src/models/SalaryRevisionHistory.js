const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SalaryRevisionHistorySchema = new Schema({
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    designation: { type: String, required: true }, // Designation at the time of this salary

    // Encrypted salary fields (same as Salaries model)
    basic: { type: String, default: "" },
    dearnessAllowance: { type: String, default: "" },
    houseRentAllowance: { type: String, default: "" },
    conveyanceAllowance: { type: String, default: "" },
    medicalAllowance: { type: String, default: "" },
    utilityAllowance: { type: String, default: "" },
    overtimeCompensation: { type: String, default: "" },
    dislocationAllowance: { type: String, default: "" },
    leaveEncashment: { type: String, default: "" },
    bonus: { type: String, default: "" },
    arrears: { type: String, default: "" },
    autoAllowance: { type: String, default: "" },
    incentive: { type: String, default: "" },
    fuelAllowance: { type: String, default: "" },
    othersAllowances: { type: String, default: "" },
    grossSalary: { type: String, default: "" },

    taxDeduction: { type: String, default: "" },
    netPayable: { type: String, default: "" },

    revisionDate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('SalaryRevisionHistory', SalaryRevisionHistorySchema);
