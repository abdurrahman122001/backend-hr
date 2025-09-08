const cron = require("node-cron");
const mongoose = require("mongoose");
const Employee = require("../models/Employees");
const Attendance = require("../models/Attendance");
const PayrollPeriod = require("../models/PayrollPeriod");

// Helper to compute hours difference between "HH:mm" strings
function getHoursDiff(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [inH, inM] = checkIn.split(':').map(Number);
  const [outH, outM] = checkOut.split(':').map(Number);
  let diff = (outH * 60 + outM) - (inH * 60 + inM);
  if (diff < 0) diff += 24 * 60; // overnight shift
  return +(diff / 60).toFixed(2);
}

// Cron: runs every 2 minutes for testing
cron.schedule("*/1 * * * *", async () => {
  try {
    console.log("=== Running Credit Bonus Leaves Cron ===", new Date());

    // Get all payroll periods
    const payrolls = await PayrollPeriod.find({ payrollPeriodType: "monthly" }).lean();

    for (const payroll of payrolls) {
      console.log(`Processing payroll: ${payroll.name} (${payroll._id})`);

      // Determine periodStart / periodEnd dynamically
      const anchor = new Date(payroll.payrollPeriodStartDay);
      const today = new Date();

      const anchorDay = anchor.getDate();
      let periodStart, periodEnd;

      // Monthly payroll
      let thisMonthStart = new Date(today.getFullYear(), today.getMonth(), anchorDay);
      if (today >= thisMonthStart) {
        periodStart = thisMonthStart;
      } else {
        periodStart = new Date(today.getFullYear(), today.getMonth() - 1, anchorDay);
      }
      periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, periodStart.getDate());
      periodEnd.setDate(periodEnd.getDate() - 1);

      const start = periodStart.toISOString().slice(0, 10);
      const end = periodEnd.toISOString().slice(0, 10);

      // Get all employees for this payroll
      const employees = await Employee.find({ owner: payroll.owner }).lean();

      for (let emp of employees) {
        // Find all markedOnNonWorkingDay attendances in this period
        const attendances = await Attendance.find({
          owner: payroll.owner,
          employee: emp._id,
          date: { $gte: start, $lte: end },
          markedOnNonWorkingDay: true,
          status: "Present",
        });

        let nineHourCount = 0;
        for (let att of attendances) {
          if (getHoursDiff(att.checkIn, att.checkOut) === 9) {
            nineHourCount++;
          }
        }

        if (nineHourCount > 0) {
          await Employee.updateOne(
            { _id: emp._id },
            { $inc: { "leaveEntitlement.bonus": nineHourCount } }
          );
          console.log(
            `Employee: ${emp.name} | Bonus leaves added: ${nineHourCount}`
          );
        } else {
          console.log(`Employee: ${emp.name} | No 9-hour attendances found`);
        }
      }
      console.log(`Finished payroll: ${payroll.name}\n`);
    }

    console.log("=== Cron Completed ===", new Date(), "\n\n");
  } catch (err) {
    console.error("Error in Credit Bonus Leaves Cron:", err);
  }
});
