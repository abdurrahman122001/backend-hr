const cron = require("node-cron");
const mongoose = require("mongoose");
const Attendance = require("../models/Attendance");
const PayrollPeriod = require("../models/PayrollPeriod");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");

// ---------- Helpers ----------
function getHoursDiff(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  let diff = outH * 60 + outM - (inH * 60 + inM);
  if (diff < 0) diff += 24 * 60;
  return +(diff / 60).toFixed(2);
}

function getLeaveYear(dateInput) {
  const d = new Date(dateInput);
  const year = d.getFullYear();
  const dec26 = new Date(year, 11, 26);
  return d >= dec26 ? year + 1 : year;
}

// ---------- CRON ----------
// Nightly at 23:30 (was every minute, which both burned CPU scanning a full
// month of attendance per payroll and re-credited the same bonus days on
// every run because there was no dedup against prior BONUS_EARNED credits).
cron.schedule("30 23 * * *", async () => {
  const session = await mongoose.startSession();
  try {
    console.log("=== Bonus Leave Cron Started ===", new Date());

    const payrolls = await PayrollPeriod.find({
      payrollPeriodType: "monthly",
    }).lean();

    for (const payroll of payrolls) {
      const anchor = new Date(payroll.payrollPeriodStartDay);
      const today = new Date();
      const anchorDay = anchor.getDate();

      let periodStart;
      if (today >= new Date(today.getFullYear(), today.getMonth(), anchorDay)) {
        periodStart = new Date(today.getFullYear(), today.getMonth(), anchorDay);
      } else {
        periodStart = new Date(today.getFullYear(), today.getMonth() - 1, anchorDay);
      }

      let periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      periodEnd.setDate(periodEnd.getDate() - 1);

      const start = periodStart.toISOString().slice(0, 10);
      const end = periodEnd.toISOString().slice(0, 10);

      const attendances = await Attendance.find({
        owner: payroll.owner,
        markedOnNonWorkingDay: true,
        status: "Present",
        date: { $gte: start, $lte: end },
      }).lean();

      const grouped = {};
      for (const att of attendances) {
        if (getHoursDiff(att.checkIn, att.checkOut) === 9) {
          grouped[att.employee] = (grouped[att.employee] || 0) + 1;
        }
      }

      for (const [employeeId, earnedDays] of Object.entries(grouped)) {
        if (earnedDays <= 0) continue;

        const year = getLeaveYear(new Date());

        // Only credit the delta over what this cron already credited for the
        // current payroll period — otherwise every run re-adds the full total.
        const priorCredits = await LeaveTransaction.aggregate([
          {
            $match: {
              owner: payroll.owner,
              employee: new mongoose.Types.ObjectId(employeeId),
              type: "BONUS_EARNED",
              sourceModel: "Cron",
              date: {
                $gte: periodStart,
                // periodEnd is midnight on the period's last day — include
                // credits written later that day.
                $lt: new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000),
              },
            },
          },
          { $group: { _id: null, total: { $sum: "$value" } } },
        ]);
        const alreadyCredited = priorCredits[0]?.total || 0;
        const bonusDays = earnedDays - alreadyCredited;
        if (bonusDays <= 0) continue;

        let balance = await LeaveYearBalance.findOne({
          owner: payroll.owner,
          employee: employeeId,
          year,
        });

        if (!balance) {
          balance = await LeaveYearBalance.create({
            owner: payroll.owner,
            employee: employeeId,
            year,
            total: 0,
            bonus: 0,
            usedPaid: 0,
            usedUnpaid: 0,
          });
        }

        session.startTransaction();

        await LeaveTransaction.create(
          [
            {
              owner: payroll.owner,
              employee: employeeId,
              leaveYearBalance: balance._id,
              year,
              date: new Date(),
              type: "BONUS_EARNED",
              value: bonusDays,
              sourceModel: "Cron",
            },
          ],
          { session }
        );

        balance.bonus += bonusDays;
        await balance.save({ session });

        await session.commitTransaction();

        console.log(
          `[BONUS] Employee=${employeeId} | BonusDays=${bonusDays} | LeaveYear=${year}`
        );
      }
    }

    console.log("=== Bonus Leave Cron Completed ===", new Date());
  } catch (err) {
    await session.abortTransaction();
    console.error("Error in Bonus Leave Cron:", err);
  } finally {
    session.endSession();
  }
});
