const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ScheduledAllowanceSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    allowanceType: { type: String, required: true }, // e.g., 'incentive'
    amount: { type: Number, required: true },
    startMonth: { type: String, required: true }, // format: "YYYY-MM"
    endMonth: { type: String, required: true }, // format: "YYYY-MM"
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ScheduledAllowance", ScheduledAllowanceSchema);
