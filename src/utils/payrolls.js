const Employee = require('../models/Employees');
const PayrollPeriod = require('../models/PayrollPeriod');
const cron = require('node-cron');

cron.schedule('0 0 * * *', async () => {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  console.log("Payroll reset CRON ran!", todayISO);

  const allPayrolls = await PayrollPeriod.find({});
  for (const payroll of allPayrolls) {
    const { payrollPeriodType, payrollPeriodStartDay, payrollPeriodLength, shifts = [] } = payroll;
    const anchor = new Date(payrollPeriodStartDay);

    let isStartOfPeriod = false;
    let periodInfo = '';

    if (payrollPeriodType === "monthly") {
      isStartOfPeriod = today.getDate() === anchor.getDate();
      periodInfo = `[Monthly] Today: ${today.getDate()}, Anchor: ${anchor.getDate()}`;
    } else if (["custom", "bimonthly", "10-days", "weekly"].includes(payrollPeriodType)) {
      let length = payrollPeriodLength;
      if (payrollPeriodType === "weekly") length = 7;
      if (payrollPeriodType === "bimonthly") length = 15;
      if (payrollPeriodType === "10-days") length = 10;

      const msPerDay = 1000 * 60 * 60 * 24;
      const diffDays = Math.floor((today - anchor) / msPerDay);
      periodInfo = `[${payrollPeriodType}] Today: ${todayISO}, Anchor: ${payrollPeriodStartDay}, DiffDays: ${diffDays}, Length: ${length}`;

      isStartOfPeriod = diffDays >= 0 && diffDays % length === 0;
    }
    // Log period checking details for each payroll period

    if (isStartOfPeriod && shifts.length) {
      const res = await Employee.updateMany(
        { shifts: { $in: shifts } },
        { $set: { "leaveEntitlement.usedUnpaid": 0 } }
      );
      console.log(`[cron] Reset usedUnpaid for payroll ${payroll._id} on ${todayISO}. Modified count: ${res.modifiedCount}`);
    }
  }
}, { timezone: "UTC" });
