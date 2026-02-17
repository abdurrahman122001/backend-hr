const mongoose = require('mongoose');
const { Schema, model } = mongoose;

const SalaryStructureSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        name: {
            type: String,
            default: 'Default Salary Structure',
        },
        description: {
            type: String,
            default: '',
        },
        // All percentage fields (must total to 100%)
        basicPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        dearnessAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        houseRentAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        conveyanceAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        medicalAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        utilityAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        overtimeCompensationPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        dislocationAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        leaveEncashmentPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        bonusPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        arrearsPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        autoAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        incentivePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        fuelAllowancePercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        othersAllowancesPercentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        medicalAllowanceCap: {
            type: Number,
            default: 10000, // As requested: not greater than 10,000
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        isDefault: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

// Index for finding active structures by owner
SalaryStructureSchema.index({ owner: 1, isActive: 1 });
SalaryStructureSchema.index({ owner: 1, isDefault: 1 });

// Virtual to calculate total percentage
SalaryStructureSchema.virtual('totalPercentage').get(function () {
    return (
        this.basicPercentage +
        this.dearnessAllowancePercentage +
        this.houseRentAllowancePercentage +
        this.conveyanceAllowancePercentage +
        this.medicalAllowancePercentage +
        this.utilityAllowancePercentage +
        this.overtimeCompensationPercentage +
        this.dislocationAllowancePercentage +
        this.leaveEncashmentPercentage +
        this.bonusPercentage +
        this.arrearsPercentage +
        this.autoAllowancePercentage +
        this.incentivePercentage +
        this.fuelAllowancePercentage +
        this.othersAllowancesPercentage
    );
});

// Method to calculate salary breakdown from gross salary
SalaryStructureSchema.methods.calculateBreakdown = function (grossSalary) {
    const gross = parseFloat(grossSalary) || 0;

    let medical = Math.round((gross * this.medicalAllowancePercentage) / 100);
    let excess = 0;

    // Apply cap to medical allowance
    const cap = this.medicalAllowanceCap || 10000;
    if (medical > cap) {
        excess = medical - cap;
        medical = cap;
    }

    // Calculate others allowance and add excess from medical if any
    let others = Math.round((gross * this.othersAllowancesPercentage) / 100) + excess;

    return {
        basic: Math.round((gross * this.basicPercentage) / 100),
        dearnessAllowance: Math.round((gross * this.dearnessAllowancePercentage) / 100),
        houseRentAllowance: Math.round((gross * this.houseRentAllowancePercentage) / 100),
        conveyanceAllowance: Math.round((gross * this.conveyanceAllowancePercentage) / 100),
        medicalAllowance: medical,
        utilityAllowance: Math.round((gross * this.utilityAllowancePercentage) / 100),
        overtimeCompensation: Math.round((gross * this.overtimeCompensationPercentage) / 100),
        dislocationAllowance: Math.round((gross * this.dislocationAllowancePercentage) / 100),
        leaveEncashment: Math.round((gross * this.leaveEncashmentPercentage) / 100),
        bonus: Math.round((gross * this.bonusPercentage) / 100),
        arrears: Math.round((gross * this.arrearsPercentage) / 100),
        autoAllowance: Math.round((gross * this.autoAllowancePercentage) / 100),
        incentive: Math.round((gross * this.incentivePercentage) / 100),
        fuelAllowance: Math.round((gross * this.fuelAllowancePercentage) / 100),
        othersAllowances: others,
        grossSalary: gross,
    };
};

module.exports = model('SalaryStructure', SalaryStructureSchema);
