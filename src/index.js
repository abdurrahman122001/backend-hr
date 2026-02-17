require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cron = require("node-cron");
const moment = require("moment-timezone");
const EmployeeSession = require("./models/EmployeeSession");

// ---------- Models used in cron / elsewhere ----------
const AttendanceConfig = require("./models/AttendanceConfig");
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");
const PayrollPeriod = require("./models/PayrollPeriod");
const ProbationPeriod = require("./models/ProbationPeriod");
const LeaveYearBalance = require("./models/LeaveYearBalance");
const LeaveTransaction = require("./models/LeaveTransaction");
const AssignmentMessage = require("./models/AssignmentMessage");
const empAuth = require("./middleware/empAuth");
const { getLeaveYear } = require("./utils/leaveEntitlement");
// ---------- Routers ----------
const authRouter = require("./routes/auth");
const empAuthRouter = require("./routes/empAuth");
const hrAuthRoutes = require("./routes/hrAuth");
const employeeCompleteRouter = require("./routes/employeeComplete");
const shiftsRouter = require("./routes/shift");
const employeesRouter = require("./routes/employees");
const attendanceRouter = require("./routes/attendance");
const leavesRouter = require("./routes/leaves");
const settingsRouter = require("./routes/settings");
const payrollPeriodsRouter = require("./routes/payrollPeriod");
const staffRouter = require("./routes/staff");
const salarySlipsRouter = require("./routes/salarySlips");
const attendanceConfigRouter = require("./routes/attendanceConfig");
const offerLetterRoutes = require("./routes/offerLetterRoutes");
const departmentsRouter = require("./routes/departments");
const designationsRouter = require("./routes/designations");
const docsRouter = require("./routes/docs");
const employeeSalaryRouter = require("./routes/employeeSalary");
const hierarchyController = require("./controllers/hierarchyController"); // (not mounted here, imported to ensure build)
const salarySettingsRoutes = require("./routes/salarySettings");
const salarySlipFields = require("./routes/salarySlipFields");
const loansRoutes = require("./routes/loans");
const onboardingRouter = require("./routes/onBoarding");
const requireAuth = require("./middleware/auth");
const requireEmployeeAuth = require("./middleware/empAuth");
const empAttendanceRouter = require("./routes/empAttendance");
const employeeBirthdays = require("./routes/empBirthdayRoutes");
const sendSlipEmail = require("./routes/sendSlipEmail");
const probationPeriodRouter = require("./routes/probationPeriods");
const leaveRecordsRouter = require("./routes/leaveRecords");
const certificateRoutes = require("./routes/certificate");
const ExtraFields = require("./routes/extraFields");
const usersRoute = require("./routes/users");
const setDateRoute = require("./routes/setDate"); // ✅ fixed double slash
const { startWatcher } = require("./watcher"); // IMAP watcher
const fontSettingRoute = require("./routes/fontSetting");
const decryptionKeysRoute = require("./routes/decryptionKeys");
const pfRoute = require("./routes/pf");
const gratuityRoute = require("./routes/gratuitySettings");
const signatureRoute = require("./routes/signature");
const roleRoutes = require("./routes/role");
const pageRoute = require("./routes/page");
const taxRoutes = require("./routes/taxRoutes");
const employeeDocsRouter = require("./routes/employeeDocs");
const attendanceLeaveSummaryRouter = require("./routes/attendanceLeaveSummary");
const employeeLeaveSummary = require("./routes/empLeaveBalanceRoutes");
const managerRoutes = require("./routes/manager");
const taskRoutes = require("./routes/tasks");
const clientInfoRoutes = require("./routes/clientInfo");
const assignMessageRoutes = require("./routes/assignmentMessage");
const employeeLeavesRouter = require("./routes/employeeLeaves");
const generateRouter = require("./routes/generate-pdfs");
const assignmentMessageController = require("./controllers/assignmentMessageController");
const WhatsAppMessageSchema = require("./models/WhatsAppMessage");
const whatsAppMessageRoutes = require("./routes/whatsAppMessageRoute");
const chatRoutes = require("./routes/chat");
const offerEmail = require("./routes/offerEmail");
const eventRoutes = require("./routes/eventRoutes");
const upcomingEventsRoutes = require("./routes/upcomingEvents");
const anniversariesRoute = require("./routes/anniversariesRoute");
const noticePeriodRouter = require("./routes/noticePeriodRoute");
const hrPolicyRoute = require("./routes/hrPolicyRoutes");
const companyProfile = require("./routes/companyProfile");
const bugRoutes = require("./routes/bugRoutes");
const hierarchyRoute = require("./routes/hierarchy"); // (not mounted here, imported to ensure build)
const threadChatRoutes = require("./routes/threadChatRoutes");
const ThreadChatMessage = require("./models/ThreadChatMessage");
const employeeShiftRoutes = require("./routes/employeeShiftRoute");
const emailReceiverRoutes = require("./routes/emailReceiverRoutes");
const emailPollingService = require("./services/emailPollingService");
const emailReceiverService = require("./services/emailReceiverService");
const labelRoutes = require("./routes/labelRoutes");
const adminWorkSpaceManagementRoute = require("./routes/adminWorkSpaceManagementRoute");
const employeeWorkSpaceManagementRoute = require("./routes/employeeTaskRoutes");
const penaltyRoutes = require("./routes/penaltyRoutes");
const warningRoutes = require("./routes/warningRoutes");
const unifiedAuth = require("./middleware/unifiedAuth");
const applyLeaveRoutes = require("./routes/applyLeaveRoutes");
const promotionRoutes = require("./routes/promotion");
const salaryStructureRoutes = require("./routes/salaryStructure");
const app = express();

// ---------- Static ----------
app.use(
  "/uploads",
  express.static(path.join(__dirname, "./uploads"), {
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*"); // or restrict to http://localhost:8080
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
    },
  }),
);
app.use("/upload", express.static(path.join(__dirname, "../uploads")));

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// If you want a separate mount for chat‐attachments you can,
// but it isn't necessary if they're inside uploads/chat-attachments/
app.use(
  "/uploads/chat-attachments",
  express.static(path.join(__dirname, "../uploads/chat-attachments")),
);
// ---------- CORS ----------
// If you need wildcard subdomains, switch to a regex check.
// For now, this is a strict allowlist.
const ALLOWED_ORIGINS = [
  "http://admin.virsme.com",
  "https://admin.virsme.com",
  "http://admin.innand.com",
  "https://admin.innand.com",
  "http://apis.innand.com",
  "https://apis.innand.com",
  "http://employee.virsme.com",
  "https://employee.virsme.com",
  "http://hr.virsme.com",
  "https://hr.virsme.com",
  "http://innand.com",
  "https://innand.com",
  "http://www.innand.com",
  "https://complete-profile.virsme.com",
  "https://www.innand.com",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:8083",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(
  cors({
    origin(origin, cb) {
      // Allow server-to-server, Postman, curl
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

// (Optional) CORS error handler to avoid generic 500s
app.use((err, _req, res, next) => {
  if (err && /CORS blocked/.test(String(err.message))) {
    return res.status(403).json({ error: err.message });
  }
  return next(err);
});

// ---------- Body parsers ----------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ---------- Public routes ----------
app.use("/api/auth", authRouter);
app.use("/api/emp-auth", empAuthRouter);

// ---------- Protected routes ----------
app.use("/api/employees", employeesRouter); // leave public if intentional
app.use("/api/attendance", requireAuth, attendanceRouter);
app.use("/api/leaves", requireAuth, leavesRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/payroll-periods", requireAuth, payrollPeriodsRouter);
app.use("/api/staff", requireAuth, staffRouter);
app.use("/api/salary-slips", requireAuth, salarySlipsRouter);
app.use("/api/shifts", requireAuth, shiftsRouter);
app.use("/api/offer-letter", requireAuth, offerLetterRoutes);
app.use("/api/attendance-config", requireAuth, attendanceConfigRouter);
app.use("/api/hr", hrAuthRoutes);
app.use("/api/employee", employeeCompleteRouter);
app.use("/api/company-profile", requireAuth, companyProfile);
app.use("/api/docs", requireAuth, docsRouter);
app.use("/api/employee-salary", employeeSalaryRouter);
app.use("/api/departments", requireAuth, departmentsRouter);
app.use("/api/designations", requireAuth, designationsRouter);
app.use("/api/salary-settings", requireAuth, salarySettingsRoutes);
app.use("/api/salary-fields", requireAuth, salarySlipFields);
app.use("/api/send-slip-email", requireAuth, sendSlipEmail);
app.use("/api/onboarding", requireAuth, onboardingRouter);
app.use("/api/employee-docs", employeeDocsRouter);
app.use("/api/attendance", attendanceLeaveSummaryRouter);
app.use("/api", employeeLeaveSummary);
// Intentionally expose both /api/loans and /api/loan to the same router?
// Keeping both since your code mounted both. If unintentional, remove one.
app.use("/api/loans", loansRoutes);
app.use("/api/loan", loansRoutes);

app.use("/api/probation-periods", probationPeriodRouter);
app.use("/api/leave-records", requireAuth, leaveRecordsRouter);
app.use("/api/certificates", certificateRoutes);
app.use("/api/font-setting", fontSettingRoute);
app.use("/api/decryption-keys", requireAuth, decryptionKeysRoute);
app.use("/api/extra-fields", requireAuth, ExtraFields);
app.use("/api/pf", pfRoute);
app.use("/api/gratuity", requireAuth, gratuityRoute);
app.use("/api/role", requireAuth, roleRoutes);
app.use("/api/pages", requireAuth, pageRoute);
app.use("/api/users", requireAuth, usersRoute);
app.use("/api/setDate", requireAuth, setDateRoute);
app.use("/api/signature", requireAuth, signatureRoute);
app.use("/api/emp-attendance", requireEmployeeAuth, empAttendanceRouter);
app.use("/api/emp-birthdays", employeeBirthdays);
app.use("/api/tax", taxRoutes);
app.use("/api/employee-docs", employeeDocsRouter);
app.use("/api/emp-leaves", requireEmployeeAuth, employeeLeavesRouter);

app.use("/api/manager", managerRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/client-info", clientInfoRoutes);
app.use("/api/assignment-messages", assignMessageRoutes);
app.use("/api/generate", requireAuth, generateRouter);
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/whatsApp-messages", whatsAppMessageRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/offer-email", requireAuth, offerEmail);
app.use("/api/events", requireAuth, eventRoutes);
app.use("/api/upcoming-events", empAuth, upcomingEventsRoutes);
app.use("/api/team-anniversaries", empAuth, anniversariesRoute);
app.use("/api/notice-period", requireAuth, noticePeriodRouter);
app.use("/api/hr-policies", requireAuth, hrPolicyRoute);
app.use("/api/bugs", bugRoutes);
app.use("/api/hierarchy", requireAuth, hierarchyRoute);
app.use("/api/thread-chat", threadChatRoutes);
app.use("/api/employee-shifts", employeeShiftRoutes);
app.use("/api/labels", labelRoutes);
app.use("/api/email", emailReceiverRoutes);
app.use("/api", employeeLeaveSummary);
app.use("/api/admin", adminWorkSpaceManagementRoute);
app.use("/api/employee/task", employeeWorkSpaceManagementRoute);
app.use("/api/penalties", penaltyRoutes);
app.use("/api/warnings", warningRoutes);
app.use("/api/apply-leave", applyLeaveRoutes);
app.use("/api/promotion", requireAuth, promotionRoutes);
app.use("/api/salary-structure", salaryStructureRoutes);
// ---------- MongoDB ----------
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in environment.");
  process.exit(1);
}

mongoose.set("strictQuery", false);
mongoose
  .connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log("▶ MongoDB connected");
    // ✅ ADDED: Start email receiver once DB is connected
    if (process.env.ENABLE_EMAIL_RECEIVER === "true") {
      console.log("🚀 Starting email receiver service...");
      setTimeout(() => {
        try {
          emailReceiverService.connect();
          console.log("✅ Email receiver service initialized");

          // Start polling after 5 seconds
          setTimeout(() => {
            emailPollingService.startPolling();
          }, 5000);
        } catch (e) {
          console.warn(
            "⚠️ Email receiver service failed to start:",
            e?.message || e,
          );
        }
      }, 3000);
    }
    // Start IMAP watcher once DB is up (wrap to avoid crashing if it throws)
    try {
      // startWatcher();
    } catch (e) {
      console.warn("⚠️ IMAP watcher failed to start:", e?.message || e);
    }

    // Setup change streams safely (replica set required)
    setupEmployeeChangeStream();
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });
function parseJoiningDate(joiningDate) {
  if (!joiningDate) return null;

  // joiningDate might be stored as string. Try Date constructor.
  const d = new Date(joiningDate);
  if (isNaN(d.getTime())) return null;

  // normalize to date-only (midnight)
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

/**
 * Month-based prorating with partial current month
 * yearlyLeaves = 22 by your business rule
 * If probation ends mid-month, include remaining days fraction of current month.
 *
 * Round off:
 * 9.6 => 10, 9.4 => 9  (Math.round)
 */
function calculateProratedLeavesFrom(probationEndDate, yearlyLeaves = 22) {
  const end = new Date(probationEndDate);
  end.setHours(0, 0, 0, 0);

  const year = end.getFullYear();

  // end of current month
  const lastDayOfMonth = new Date(year, end.getMonth() + 1, 0); // last date in month
  const daysInMonth = lastDayOfMonth.getDate();

  // remaining days in current month INCLUDING the probation end date
  const remainingDaysInMonth = daysInMonth - end.getDate() + 1;
  const monthFraction = remainingDaysInMonth / daysInMonth;

  // full months remaining after current month
  const remainingFullMonths = 11 - end.getMonth(); // if Jan (0) => 11 months after Jan
  const monthly = yearlyLeaves / 12;

  const raw = remainingFullMonths * monthly + monthFraction * monthly;

  // round rule
  return Math.round(raw);
}

/**
 * Decide if employee is "already regular" so we don't overwrite.
 * You said: "those employees which already has leaves will as regular"
 *
 * This checks if leaveEntitlement.total is already set to something meaningful
 * OR if they've already used paid/unpaid leaves.
 *
 * Adjust if your schema differs.
 */
function alreadyHasLeaveEntitlement(emp) {
  const le = emp.leaveEntitlement || {};
  const total = Number(le.total || 0);
  const usedPaid = Number(le.usedPaid || 0);
  const usedUnpaid = Number(le.usedUnpaid || 0);

  // If total already non-zero, or any usage exists, treat as regular
  if (total > 0) return true;
  if (usedPaid > 0 || usedUnpaid > 0) return true;

  return false;
}

const PROBATION_CRON_TZ = process.env.ATTENDANCE_CRON_TZ || "Asia/Karachi";

// ---------- Change Streams: Watch Employee inserts/updates ----------
function setupEmployeeChangeStream() {
  try {
    const changeStream = Employee.watch();

    changeStream.on("change", (change) => {
      if (!app.get("io")) return; // Socket not ready yet
      const io = app.get("io");

      if (change.operationType === "insert") {
        const emp = change.fullDocument || {};
        io.emit("employee_added", {
          message: `New employee added: ${emp.name || "Unknown"}`,
          createdAt: emp.createdAt || new Date().toISOString(),
        });
      }

      if (change.operationType === "update") {
        const updatedFields = change.updateDescription?.updatedFields || {};
        if ("cnic" in updatedFields) {
          const newCnic = updatedFields.cnic;
          Employee.findById(change.documentKey?._id)
            .lean()
            .then((emp) => {
              if (!emp) return;
              io.emit("employee_cnic_updated", {
                message: `CNIC for ${emp.name} updated to ${newCnic}`,
                createdAt: new Date().toISOString(),
              });
            })
            .catch((e) => console.error("watch update fetch error:", e));
        }
      }
    });

    changeStream.on("error", (err) => {
      console.warn(
        "⚠️ Employee change stream error (likely no replica set). Disabling watcher.",
        err?.message || err,
      );
      try {
        changeStream.close();
      } catch { }
    });
  } catch (e) {
    console.warn(
      "⚠️ Change streams not supported (no replica set / permissions?). Skipping.",
      e?.message || e,
    );
  }
}

// ---------- Public: employee count ----------
app.get("/api/employees/count", async (_req, res) => {
  try {
    const count = await Employee.countDocuments();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: "Failed to get employee count" });
  }
});

// ---------- Cron: auto-fill YESTERDAY’s attendance ----------
// Runs at 00:00 in configured timezone (default Asia/Karachi)
const ATTENDANCE_CRON_TZ = process.env.ATTENDANCE_CRON_TZ || "Asia/Karachi";
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      // Compute "yesterday" in the server's local time (the node-cron lib triggers in the TZ we pass)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const y = yesterday.getFullYear();
      const m = String(yesterday.getMonth() + 1).padStart(2, "0");
      const d = String(yesterday.getDate()).padStart(2, "0");
      const date = `${y}-${m}-${d}`;

      const config = await AttendanceConfig.findOne({}).lean();
      if (config && config.markAbsentManually === true) {
        return;
      }

      // Skip holidays
      const holiday = await Attendance.findOne({
        date,
        isHoliday: true,
      }).lean();
      if (holiday) {
        return;
      }

      // Employees already recorded for that date
      const done = await Attendance.find({ date }).select("employee").lean();
      const doneIds = new Set(done.map((r) => String(r.employee)));

      // All employees
      const allEmps = await Employee.find({}).select("_id owner shifts").lean();

      // Payroll periods
      const allPayrolls = await PayrollPeriod.find({}).lean();

      // Day name for yesterday (lowercase long weekday)
      const dayName = yesterday
        .toLocaleDateString("en-US", { weekday: "long" })
        .toLowerCase();
      const ops = [];

      for (const e of allEmps) {
        if (doneIds.has(String(e._id))) continue;

        const payroll = allPayrolls.find(
          (p) =>
            Array.isArray(p.shifts) &&
            Array.isArray(e.shifts) &&
            e.shifts.some((s) => p.shifts.map(String).includes(String(s))),
        );

        // If no payroll period or no nonWorkingDays config → mark absent
        if (!payroll || !Array.isArray(payroll.nonWorkingDays)) {
          ops.push({
            updateOne: {
              filter: { employee: e._id, date },
              update: {
                $setOnInsert: {
                  employee: e._id,
                  date,
                  owner: e.owner || null,
                  status: "Absent",
                  checkIn: null,
                  checkOut: null,
                  notes: null,
                  markedByHR: false,
                },
              },
              upsert: true,
            },
          });
          continue;
        }

        // Respect non-working days
        const nonWorking = payroll.nonWorkingDays.map((n) =>
          String(n).toLowerCase().trim(),
        );
        if (nonWorking.includes(dayName)) {
          // It's a non-working day for this employee; skip
          continue;
        }

        // Otherwise, mark absent
        ops.push({
          updateOne: {
            filter: { employee: e._id, date },
            update: {
              $setOnInsert: {
                employee: e._id,
                date,
                owner: e.owner || null,
                status: "Absent",
                checkIn: null,
                checkOut: null,
                notes: null,
                markedByHR: false,
              },
            },
            upsert: true,
          },
        });
      }

      if (ops.length) {
        const result = await Attendance.bulkWrite(ops);
        const upserted = result?.upsertedCount || 0;
      } else {
      }
    } catch (err) {
      console.error("[cron] Error auto-filling attendance:", err);
    }
  },
  { timezone: ATTENDANCE_CRON_TZ },
);
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      // ✅ normalize today to DATE ONLY
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);
      const owners = await Employee.distinct("owner", { isTrashed: false });

      for (const ownerId of owners) {
        const policy = await ProbationPeriod.findOne({ owner: ownerId })
          .sort({ createdAt: -1 })
          .lean();

        if (!policy) continue;
        if (!policy.leaveAfterProbation) continue;
        if (policy.leaveDuringProbation) continue;

        const probationDays = Number(policy.days || 0);
        if (probationDays < 1) continue;

        // ✅ ONLY ACTIVE EMPLOYEES
        const employees = await Employee.find({
          owner: ownerId,
          isTrashed: false,
          status: "active",
        })
          .select("_id joiningDate")
          .lean();

        for (const emp of employees) {
          if (!emp.joiningDate) continue;

          const joiningDate = new Date(emp.joiningDate);
          if (isNaN(joiningDate)) continue;

          // probation end = joiningDate + probationDays
          const probationEnd = new Date(joiningDate);
          probationEnd.setDate(probationEnd.getDate() + probationDays);
          probationEnd.setHours(0, 0, 0, 0);

          const probationEndStr = probationEnd.toISOString().slice(0, 10);

          // ✅ DATE-ONLY comparison
          if (probationEndStr > todayStr) continue;

          const leaveYear = getLeaveYear(probationEnd);

          // ⛔ prevent double credit
          const existingTx = await LeaveTransaction.findOne({
            owner: ownerId,
            employee: emp._id,
            year: leaveYear,
            type: "PAID_LEAVE_CREDITED",
            sourceModel: "PROBATION",
          }).lean();

          if (existingTx) continue;

          const leaveYearEnd = new Date(leaveYear, 11, 25); // 25 Dec of leaveYear
          leaveYearEnd.setHours(0, 0, 0, 0);

          // total days in leave year (Dec 26 → Dec 25)
          const leaveYearStart = new Date(leaveYear - 1, 11, 26); // 26 Dec prev year
          leaveYearStart.setHours(0, 0, 0, 0);

          const totalDaysInYear =
            (leaveYearEnd - leaveYearStart) / (1000 * 60 * 60 * 24) + 1;

          // remaining days from probation end → leave year end
          const remainingDays =
            (leaveYearEnd - probationEnd) / (1000 * 60 * 60 * 24) + 1;

          // per-day leave value
          const dailyRate = 22 / totalDaysInYear;

          function customRound(value) {
            const decimal = value - Math.floor(value);

            if (decimal > 0.5) return Math.ceil(value);
            if (decimal < 0.5) return Math.floor(value);

            return value;
          }
          const rawLeaves = dailyRate * remainingDays;

          const proratedLeaves = Math.max(0, customRound(rawLeaves));
          if (proratedLeaves <= 0) continue;

          // ✅ upsert LeaveYearBalance
          const balance = await LeaveYearBalance.findOneAndUpdate(
            {
              owner: ownerId,
              employee: emp._id,
              year: leaveYear,
            },
            {
              $inc: { total: proratedLeaves },
              lastRecalculatedAt: new Date(),
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            },
          );

          // 🧾 transaction record
          await LeaveTransaction.create({
            owner: ownerId,
            employee: emp._id,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: probationEnd,
            type: "PAID_LEAVE_CREDITED",
            value: proratedLeaves,
            sourceModel: "PROBATION",
            sourceId: emp._id,
            createdBy: null, // system
          });
        }
      }
    } catch (err) {
      console.error("[cron][leave] ❌ error:", err);
    }
  },
  { timezone: "Asia/Karachi" },
);

cron.schedule(
  "0 0 * * *", // 12:00 AM
  async () => {
    const nowKarachi = moment().tz(ATTENDANCE_CRON_TZ);
    const logoutTimeUTC = nowKarachi.utc().toDate();
    const actualLogoutTime = nowKarachi.format("YYYY-MM-DD HH:mm");

    const sessions = await EmployeeSession.find({ active: true });

    for (const session of sessions) {
      const loginTimeKarachi = moment(session.loginTime).tz(ATTENDANCE_CRON_TZ);
      const totalHours = nowKarachi.diff(loginTimeKarachi, "hours", true);

      await EmployeeSession.findByIdAndUpdate(session._id, {
        logoutTime: logoutTimeUTC,
        actualLogoutTime,
        totalHours: parseFloat(totalHours.toFixed(2)),
        active: false,
        status: totalHours < 6 ? "half-day" : session.status,
        isAutoLogout: true,
      });
    }
  },
  { timezone: "Asia/Karachi" },
);

// ---------- TLS (Let’s Encrypt) & Server Startup ----------
const ENABLE_HTTPS = false;
const HTTP_PORT = 4000;

const httpServer = http.createServer(app);
primaryServer = httpServer;

httpServer.listen(HTTP_PORT, () => {
  console.log(`🔓 Server running locally on http://localhost:${HTTP_PORT}`);
});

// ---------- Socket.IO on the primary server ----------
const { Server } = require("socket.io");
const io = new Server(primaryServer, {
  // If you want to restrict, set origin: ALLOWED_ORIGINS instead of "*"
  cors: { origin: "*", credentials: true },
});
app.set("io", io);

io.on("connection", (socket) => {
  const { userId, role } = socket.handshake.query;

  if (userId) socket.join(`emp_${userId}`);

  const lowerRole = (role || "").toLowerCase();
  if (lowerRole === "manager" || lowerRole.includes("team")) {
    socket.join("manager_room");
  }
  // Join employee room
  socket.on("join_employee", (employeeId) => {
    if (!employeeId) {
      console.error("❌ join_employee: employeeId is required");
      return;
    }
    socket.join(`employee_${employeeId}`);
  });

  socket.on("join_client_updates", (ownerId) => {
    if (!ownerId) {
      console.error("❌ join_client_updates: ownerId is required");
      return;
    }
    socket.join(`client_updates_${ownerId}`);
  });

  socket.on("client_updated", async (data, callback) => {
    try {
      const { action, client, ownerId } = data;

      if (!client || !ownerId) {
        console.error("❌ client_updated: client and ownerId are required");
        if (callback)
          callback({ success: false, error: "Missing required data" });
        return;
      }
      // Broadcast to all team members of this owner
      io.to(`client_updates_${ownerId}`).emit(`client_${action}`, {
        client,
        action,
        timestamp: new Date().toISOString(),
      });

      // Also notify assignment managers
      io.to("assignment_managers").emit(`client_${action}`, {
        client,
        action,
        timestamp: new Date().toISOString(),
      });

      if (callback) {
        callback({
          success: true,
          message: `Client ${action} broadcasted successfully`,
          deliveredTo: `client_updates_${ownerId}`,
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting client update:", error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on("join_manager_updates", (managerId) => {
    if (!managerId) {
      console.error("❌ join_manager_updates: managerId is required");
      return;
    }
    socket.join(`manager_updates_${managerId}`);
  });

  // In your backend socket setup
  socket.on("client_assignment_updated", async (data, callback) => {
    try {
      const {
        clientId,
        employeeId,
        assignedTo,
        clientName,
        dba,
        assignedBy,
        previousAssignee,
      } = data;

      if (!clientId) {
        console.error("❌ client_assigned: clientId is required");
        if (callback)
          callback({ success: false, error: "clientId is required" });
        return;
      }
      if (employeeId) {
        io.to(`employee_${employeeId}`).emit("client_assignment_updated", {
          type: "CLIENT_ASSIGNED_TO_YOU",
          clientId,
          clientName,
          dba,
          assignedBy,
          assignedAt: new Date().toISOString(),
          action: "assigned",
          assignedTo: employeeId, // ✅ THIS IS CRITICAL - must match client-side check
          previousAssignee: previousAssignee, // ✅ Add this too
        });
      }

      // ✅ Notify the PREVIOUSLY assigned employee (if any)
      if (previousAssignee && previousAssignee.toString() !== employeeId) {
        io.to(`employee_${previousAssignee}`).emit(
          "client_assignment_updated",
          {
            type: "CLIENT_UNASSIGNED_FROM_YOU",
            clientId,
            clientName,
            dba,
            assignedBy,
            unassignedAt: new Date().toISOString(),
            action: "unassigned",
            previousAssignee: previousAssignee, // ✅ Add this
            assignedTo: null, // ✅ Important for unassignment
          },
        );
      }

      // ✅ Notify all managers/team leads
      io.to("assignment_managers").emit("client_assignment_updated", {
        type: "CLIENT_ASSIGNMENT_CHANGED",
        clientId,
        employeeId,
        assignedTo,
        clientName,
        dba,
        assignedBy,
        previousAssignee,
        assignedAt: new Date().toISOString(),
        action: employeeId ? "assigned" : "unassigned",
      });

      // ✅ Broadcast general client update
      io.to(`client_updates_${assignedBy?.owner || assignedBy}`).emit(
        "client_updated",
        {
          client: { _id: clientId, clientName, dba, assignedTo: employeeId },
          action: "updated",
          timestamp: new Date().toISOString(),
        },
      );

      if (callback) {
        callback({
          success: true,
          message: "Client assignment broadcasted successfully",
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting client assignment:", error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  // Join assignment client room
  socket.on("join_assignment_chat", (clientId) => {
    if (!clientId) {
      console.error("❌ join_assignment_chat: clientId is required");
      return;
    }
    socket.join(`assignment_client_${clientId}`);
  });

  // Join manager room
  socket.on("join_assignment_managers", () => {
    socket.join("assignment_managers");
  });

  // Join team leads room
  socket.on("join_assignment_team_leads", () => {
    socket.join("assignment_team_leads");
  });

  // Join thread room
  socket.on("join_thread", (threadId) => {
    if (!threadId) {
      console.error("❌ join_thread: threadId is required");
      return;
    }
    socket.join(`thread_${threadId}`);
  });

  // 🔥 NEW: Handle attachment uploads in real-time
  socket.on(
    "assignment_message_attachments_updated",
    async (data, callback) => {
      try {
        const { messageId, attachments, action } = data;

        if (!messageId) {
          console.error(
            "❌ assignment_message_attachments_updated: messageId is required",
          );
          if (callback)
            callback({ success: false, error: "messageId is required" });
          return;
        }

        // Populate the message with all necessary data including attachments
        const populatedMessage = await AssignmentMessage.findById(messageId)
          .populate("owner")
          .populate("sender")
          .populate("receiver")
          .populate("client")
          .populate("attachments.uploadedBy");

        if (!populatedMessage) {
          console.error(
            "❌ Message not found for attachment update:",
            messageId,
          );
          if (callback)
            callback({ success: false, error: "Message not found" });
          return;
        }

        // Get all participants
        const senderId =
          typeof populatedMessage.sender === "string"
            ? populatedMessage.sender
            : populatedMessage.sender?._id;

        let receiverIds = [];
        if (Array.isArray(populatedMessage.receiver)) {
          receiverIds = populatedMessage.receiver
            .map((receiver) =>
              typeof receiver === "string" ? receiver : receiver?._id,
            )
            .filter(Boolean);
        }

        const allParticipants = new Set(
          [senderId, ...receiverIds].filter(Boolean),
        );
        const clientId =
          typeof populatedMessage.client === "string"
            ? populatedMessage.client
            : populatedMessage.client?._id;

        // 1. Emit to all participants
        allParticipants.forEach((participantId) => {
          io.to(`employee_${participantId}`).emit(
            "assignment_message_attachments_updated",
            {
              messageId: populatedMessage._id,
              attachments: populatedMessage.attachments || [],
              action: action, // 'added', 'removed', 'updated'
              message: populatedMessage,
              timestamp: new Date(),
            },
          );
        });

        // 2. Emit to thread room
        if (populatedMessage.threadId) {
          io.to(`thread_${populatedMessage.threadId}`).emit(
            "assignment_message_attachments_updated",
            {
              messageId: populatedMessage._id,
              attachments: populatedMessage.attachments || [],
              action: action,
              message: populatedMessage,
              timestamp: new Date(),
            },
          );
        }

        // 3. Emit to client room if applicable
        if (clientId) {
          io.to(`assignment_client_${clientId}`).emit(
            "assignment_message_attachments_updated",
            {
              messageId: populatedMessage._id,
              attachments: populatedMessage.attachments || [],
              action: action,
              message: populatedMessage,
              timestamp: new Date(),
            },
          );
        }

        // 4. Also emit general message update for compatibility
        allParticipants.forEach((participantId) => {
          io.to(`employee_${participantId}`).emit(
            "assignment_message_updated",
            {
              message: populatedMessage,
              action: "attachments_updated",
              timestamp: new Date(),
            },
          );
        });

        if (callback) {
          callback({
            success: true,
            message: `Attachment ${action} broadcasted successfully`,
            deliveredTo: {
              participants: Array.from(allParticipants),
              thread: populatedMessage.threadId,
              client: clientId,
            },
          });
        }
      } catch (error) {
        console.error("❌ Error broadcasting attachment update:", error);
        if (callback) {
          callback({
            success: false,
            error: error.message,
            code: "SOCKET_ATTACHMENT_UPDATE_ERROR",
          });
        }
      }
    },
  );

  // 🔥 NEW: Handle message edits with attachments
  socket.on("assignment_message_edited", async (data, callback) => {
    try {
      const { messageId, updates } = data;

      if (!messageId) {
        console.error("❌ assignment_message_edited: messageId is required");
        if (callback)
          callback({ success: false, error: "messageId is required" });
        return;
      }

      // Populate the message with all necessary data
      const populatedMessage = await AssignmentMessage.findById(messageId)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy")
        .populate("lastEditedBy");

      if (!populatedMessage) {
        console.error("❌ Message not found for edit:", messageId);
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      // Get all participants
      const senderId =
        typeof populatedMessage.sender === "string"
          ? populatedMessage.sender
          : populatedMessage.sender?._id;

      let receiverIds = [];
      if (Array.isArray(populatedMessage.receiver)) {
        receiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id,
          )
          .filter(Boolean);
      }

      const allParticipants = new Set(
        [senderId, ...receiverIds].filter(Boolean),
      );
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // 1. Emit specific edit event
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_edited", {
          messageId: populatedMessage._id,
          message: populatedMessage,
          updates: updates,
          timestamp: new Date(),
        });
      });

      // 2. Emit to thread room
      if (populatedMessage.threadId) {
        io.to(`thread_${populatedMessage.threadId}`).emit(
          "assignment_message_edited",
          {
            messageId: populatedMessage._id,
            message: populatedMessage,
            updates: updates,
            timestamp: new Date(),
          },
        );
      }

      // 3. Also emit general update for compatibility
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: populatedMessage,
          action: "edited",
          timestamp: new Date(),
        });
      });

      if (callback) {
        callback({
          success: true,
          message: "Message edit broadcasted successfully",
          deliveredTo: {
            participants: Array.from(allParticipants),
            thread: populatedMessage.threadId,
            client: clientId,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting message edit:", error);
      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "SOCKET_MESSAGE_EDIT_ERROR",
        });
      }
    }
  });

  // Handle assignment message approval - UPDATED WITH ATTACHMENTS
  socket.on("assignment_message_approved", async (data, callback) => {
    try {
      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data in approval");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data INCLUDING ATTACHMENTS
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy") // 🔥 IMPORTANT: Populate attachments
        .populate("approvedBy");

      if (!populatedMessage) {
        console.error("❌ Approved assignment message not found:", message._id);
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      // Get the client ID
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // Handle receiver as array consistently
      let actualReceiverIds = [];

      if (Array.isArray(populatedMessage.receiver)) {
        actualReceiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id,
          )
          .filter(Boolean);
      } else if (populatedMessage.receiver) {
        actualReceiverIds = [
          typeof populatedMessage.receiver === "string"
            ? populatedMessage.receiver
            : populatedMessage.receiver?._id,
        ].filter(Boolean);
      }

      // Get sender ID
      const senderId =
        typeof populatedMessage.sender === "string"
          ? populatedMessage.sender
          : populatedMessage.sender?._id;

      // 1. Emit specific approval event to all participants
      const allParticipants = new Set(
        [senderId, ...actualReceiverIds].filter(Boolean),
      );

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_approved", {
          messageId: populatedMessage._id,
          approvalStatus: "approved",
          message: populatedMessage,
          timestamp: new Date(),
        });
      });

      // 2. Also emit general update event for compatibility
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: populatedMessage,
          action: "approved",
          timestamp: new Date(),
        });
      });

      // 3. Notify team leads
      io.to("assignment_team_leads").emit("assignment_message_approved", {
        messageId: populatedMessage._id,
        approvalStatus: "approved",
        message: populatedMessage,
        timestamp: new Date(),
      });

      // 4. Broadcast to client room if applicable
      if (clientId) {
        io.to(`assignment_client_${clientId}`).emit(
          "assignment_message_approved",
          {
            messageId: populatedMessage._id,
            approvalStatus: "approved",
            message: populatedMessage,
            timestamp: new Date(),
          },
        );
      }

      // 5. Broadcast to thread room
      if (populatedMessage.threadId) {
        io.to(`thread_${populatedMessage.threadId}`).emit(
          "assignment_message_approved",
          {
            messageId: populatedMessage._id,
            approvalStatus: "approved",
            message: populatedMessage,
            timestamp: new Date(),
          },
        );
      }

      // Send success callback
      if (callback) {
        callback({
          success: true,
          message: "Approval notification delivered",
          deliveredTo: {
            client: clientId,
            sender: senderId,
            receivers: actualReceiverIds,
            teamLeads: true,
            thread: populatedMessage.threadId,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting approval notification:", error);
      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "SOCKET_APPROVAL_ERROR",
        });
      }
    }
  });

  // Handle assignment message disapproval - UPDATED WITH ATTACHMENTS
  socket.on("assignment_message_disapproved", async (data, callback) => {
    try {
      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data in disapproval");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data INCLUDING ATTACHMENTS
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy"); // 🔥 IMPORTANT: Populate attachments

      if (!populatedMessage) {
        console.error(
          "❌ Disapproved assignment message not found:",
          message._id,
        );
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }
      // Get the client ID
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // Handle receiver as array consistently
      let actualReceiverIds = [];

      if (Array.isArray(populatedMessage.receiver)) {
        actualReceiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id,
          )
          .filter(Boolean);
      } else if (populatedMessage.receiver) {
        actualReceiverIds = [
          typeof populatedMessage.receiver === "string"
            ? populatedMessage.receiver
            : populatedMessage.receiver?._id,
        ].filter(Boolean);
      }

      // Get sender ID
      const senderId =
        typeof populatedMessage.sender === "string"
          ? populatedMessage.sender
          : populatedMessage.sender?._id;

      // 1. Emit specific disapproval event to all participants
      const allParticipants = new Set(
        [senderId, ...actualReceiverIds].filter(Boolean),
      );

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit(
          "assignment_message_disapproved",
          {
            messageId: populatedMessage._id,
            approvalStatus: "disapproved",
            message: populatedMessage,
            timestamp: new Date(),
          },
        );
      });

      // 2. Also emit general update event for compatibility
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: populatedMessage,
          action: "disapproved",
          timestamp: new Date(),
        });
      });

      // 3. Notify team leads
      io.to("assignment_team_leads").emit("assignment_message_disapproved", {
        messageId: populatedMessage._id,
        approvalStatus: "disapproved",
        message: populatedMessage,
        timestamp: new Date(),
      });

      // 4. Broadcast to client room if applicable
      if (clientId) {
        io.to(`assignment_client_${clientId}`).emit(
          "assignment_message_disapproved",
          {
            messageId: populatedMessage._id,
            approvalStatus: "disapproved",
            message: populatedMessage,
            timestamp: new Date(),
          },
        );
      }

      // 5. Broadcast to thread room
      if (populatedMessage.threadId) {
        io.to(`thread_${populatedMessage.threadId}`).emit(
          "assignment_message_disapproved",
          {
            messageId: populatedMessage._id,
            approvalStatus: "disapproved",
            message: populatedMessage,
            timestamp: new Date(),
          },
        );
      }

      // Send success callback
      if (callback) {
        callback({
          success: true,
          message: "Disapproval notification delivered",
          deliveredTo: {
            client: clientId,
            sender: senderId,
            receivers: actualReceiverIds,
            teamLeads: true,
            thread: populatedMessage.threadId,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting disapproval notification:", error);
      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "SOCKET_DISAPPROVAL_ERROR",
        });
      }
    }
  });

  // Handle assignment message resubmission events - UPDATED WITH ATTACHMENTS
  socket.on("assignment_message_resubmitted", async (data, callback) => {
    try {
      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data in resubmission");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data INCLUDING ATTACHMENTS
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy"); // 🔥 IMPORTANT: Populate attachments

      if (!populatedMessage) {
        console.error(
          "❌ Resubmitted assignment message not found:",
          message._id,
        );
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      // Get the client ID
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // Handle receiver as array consistently
      let actualReceiverIds = [];

      if (Array.isArray(populatedMessage.receiver)) {
        actualReceiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id,
          )
          .filter(Boolean);
      } else if (populatedMessage.receiver) {
        actualReceiverIds = [
          typeof populatedMessage.receiver === "string"
            ? populatedMessage.receiver
            : populatedMessage.receiver?._id,
        ].filter(Boolean);
      }

      // 1. Broadcast to the assignment client room
      if (clientId) {
        socket
          .to(`assignment_client_${clientId}`)
          .emit("assignment_message_updated", {
            message: {
              ...populatedMessage,
              receiver: actualReceiverIds,
            },
            action: "resubmitted",
          });
      }

      // 2. Notify team leads about the resubmission
      socket
        .to("assignment_team_leads")
        .emit("assignment_message_resubmitted", {
          message: {
            ...populatedMessage,
            receiver: actualReceiverIds,
          },
          action: "resubmitted",
          timestamp: new Date(),
        });

      // 3. Notify the sender
      const senderId =
        typeof populatedMessage.sender === "string"
          ? populatedMessage.sender
          : populatedMessage.sender?._id;

      if (senderId) {
        socket.to(`employee_${senderId}`).emit("assignment_message_updated", {
          message: {
            ...populatedMessage,
            receiver: actualReceiverIds,
          },
          action: "resubmitted",
        });
      }

      // 4. Notify all receivers about resubmission
      actualReceiverIds.forEach((receiverId) => {
        if (receiverId && receiverId !== senderId) {
          socket
            .to(`employee_${receiverId}`)
            .emit("assignment_message_updated", {
              message: {
                ...populatedMessage,
                receiver: actualReceiverIds,
              },
              action: "resubmitted",
            });
        }
      });

      // Send success callback
      if (callback) {
        callback({
          success: true,
          message: "Resubmission notification delivered",
          deliveredTo: {
            client: clientId,
            teamLeads: true,
            sender: senderId,
            receivers: actualReceiverIds,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting resubmission notification:", error);
      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "SOCKET_RESUBMISSION_ERROR",
        });
      }
    }
  });

  // Handle assignment message sending - UPDATED WITH ATTACHMENTS
  socket.on("send_assignment_message", async (data, callback) => {
    try {
      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data INCLUDING ATTACHMENTS
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("scheduledBy")
        .populate("attachments.uploadedBy"); // 🔥 IMPORTANT: Populate attachments

      if (!populatedMessage) {
        console.error("❌ Assignment message not found:", message._id);
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }
      // Use the targeted emission function
      await emitToSpecificReceivers(
        io,
        populatedMessage,
        "new_assignment_message",
      );

      // Send success callback
      if (callback) {
        callback({
          success: true,
          message: "Assignment message delivered ONLY to specified receivers",
          deliveredTo: await getRecipientList(populatedMessage),
        });
      }
    } catch (error) {
      console.error("❌ Error sending assignment message:", error);
      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "SOCKET_SEND_ERROR",
        });
      }
    }
  });

  // Handle assignment message updates - UPDATED FOR ATTACHMENTS
  socket.on("assignment_message_updated", (data) => {
    try {
      const { message, action, clientId } = data;

      if (!message) {
        console.error("❌ assignment_message_updated: message is required");
        return;
      }

      // Handle receiver as array consistently
      let receiverIds = [];

      if (Array.isArray(message.receiver)) {
        receiverIds = message.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id,
          )
          .filter(Boolean);
      } else if (message.receiver) {
        receiverIds = [
          typeof message.receiver === "string"
            ? message.receiver
            : message.receiver?._id,
        ].filter(Boolean);
      }

      // Get sender ID
      const senderId =
        typeof message.sender === "string"
          ? message.sender
          : message.sender?._id;

      // Broadcast to client room
      if (clientId) {
        io.to(`assignment_client_${clientId}`).emit(
          "assignment_message_updated",
          {
            message: {
              ...message,
              receiver: receiverIds,
            },
            action,
          },
        );
      }

      // Notify ONLY actual participants
      const allParticipants = new Set(
        [senderId, ...receiverIds].filter(Boolean),
      );

      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: {
            ...message,
            receiver: receiverIds,
          },
          action,
        });
      });

      // Notify team leads for approval actions
      if (["approved", "disapproved", "pending"].includes(action)) {
        io.to("assignment_team_leads").emit("assignment_message_updated", {
          message: {
            ...message,
            receiver: receiverIds,
          },
          action,
        });
      }

      // Broadcast to thread room if available
      if (message.threadId) {
        io.to(`thread_${message.threadId}`).emit("assignment_message_updated", {
          message: {
            ...message,
            receiver: receiverIds,
          },
          action,
        });
      }
    } catch (error) {
      console.error("❌ Error in assignment_message_updated:", error);
    }
  });

  // Test socket events - for debugging
  socket.on("test_approval_event", (data) => {
    socket.emit("test_approval_response", {
      success: true,
      message: "Test event received",
      data: data,
      timestamp: new Date(),
    });
  });
  socket.on("join_thread_chat", (threadId) => {
    if (!threadId) {
      console.error("❌ join_thread_chat: threadId is required");
      return;
    }
    socket.join(`thread_chat_${threadId}`);
  });

  socket.on("join_thread_chat", (threadId) => {
    if (!threadId) {
      console.error("❌ join_thread_chat: threadId is required");
      return;
    }
    socket.join(`thread_chat_${threadId}`);
  });

  /**
   * Request previous chat context for a thread
   */
  socket.on("get_thread_context", async (data, callback) => {
    try {
      const { threadId, limit = 50, beforeTimestamp, userId } = data;

      if (!threadId) {
        if (callback)
          callback({ success: false, error: "threadId is required" });
        return;
      }

      // Build query
      const query = { threadId: threadId, isDeleted: false };

      if (beforeTimestamp) {
        query.createdAt = { $lt: new Date(beforeTimestamp) };
      }

      // Get thread messages with population
      const threadMessages = await ThreadChatMessage.find(query)
        .populate("sender", "name email avatar role")
        .populate("receiver", "name email avatar role")
        .populate("client", "clientName dba")
        .populate("attachments.uploadedBy", "name email")
        .populate("replyTo", "content sender createdAt")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      // Get related assignment messages
      const relatedAssignments = await AssignmentMessage.find({
        threadId: threadId,
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
      })
        .populate("sender", "name email")
        .populate("client", "clientName dba")
        .select("messageType content createdAt status attachments")
        .limit(10)
        .lean();

      // Get thread info from assignment messages
      const threadInfo = await AssignmentMessage.findOne({ threadId: threadId })
        .populate("client", "clientName dba")
        .populate("owner", "name email")
        .select("subject client owner createdAt")
        .lean();

      // Get thread participants
      const participants =
        await ThreadChatMessage.getThreadParticipants(threadId);

      // Format messages
      const allMessages = [
        ...threadMessages,
        ...relatedAssignments.map((msg) => ({
          ...msg,
          _id: msg._id,
          messageType: msg.messageType || "assignment",
          isAssignment: true,
        })),
      ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      // Emit context to the specific user who requested it
      socket.emit("thread_context_received", {
        threadId,
        messages: allMessages,
        threadInfo: {
          ...threadInfo,
          participants: participants,
          messageCount: allMessages.length,
        },
        relatedAssignments: relatedAssignments,
        totalCount: allMessages.length,
        timestamp: new Date().toISOString(),
      });

      // Also broadcast to thread room for any other participants
      socket.to(`thread_chat_${threadId}`).emit("thread_context_updated", {
        threadId,
        contextLoaded: true,
        loadedBy: userId,
        messageCount: allMessages.length,
        timestamp: new Date().toISOString(),
      });

      if (callback) {
        callback({
          success: true,
          message: `Loaded ${allMessages.length} messages from thread context`,
          data: {
            messages: allMessages.slice(0, 10),
            threadInfo: {
              ...threadInfo,
              participants: participants,
            },
            hasMore: allMessages.length > 10,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error getting thread context:", error);
      socket.emit("thread_error", {
        error: "Failed to load thread context",
        details: error.message,
      });

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_CONTEXT_ERROR",
        });
      }
    }
  });

  /**
   * Send a new message in thread chat
   */
  socket.on("send_thread_message", async (data, callback) => {
    try {
      const {
        threadId,
        content,
        senderId,
        ownerId,
        clientId,
        messageType = "text",
        attachments = [],
        replyTo = null,
        receiver = [],
      } = data;

      if (!threadId || !content || !senderId || !ownerId) {
        if (callback)
          callback({
            success: false,
            error: "threadId, content, senderId, and ownerId are required",
          });
        return;
      }

      // Get sender info
      const sender = await Employee.findById(senderId)
        .select("name email avatar role")
        .lean();

      // Determine receivers if not provided
      let messageReceivers = receiver;
      if (!messageReceivers || messageReceivers.length === 0) {
        // Get existing participants
        const participants =
          await ThreadChatMessage.getThreadParticipants(threadId);
        messageReceivers = participants.filter(
          (id) => id.toString() !== senderId.toString(),
        );
      }

      // Create new thread message
      const newMessage = new ThreadChatMessage({
        threadId,
        content,
        owner: ownerId,
        client: clientId,
        sender: senderId,
        receiver: messageReceivers,
        messageType,
        attachments,
        replyTo,
        readBy: [{ employee: senderId, readAt: new Date() }],
      });

      await newMessage.save();

      // Populate the saved message
      const populatedMessage = await ThreadChatMessage.findById(newMessage._id)
        .populate("sender", "name email avatar role")
        .populate("receiver", "name email avatar")
        .populate("client", "clientName dba")
        .populate("replyTo", "content sender createdAt")
        .populate("attachments.uploadedBy", "name email")
        .lean();

      // Emit to thread room
      io.to(`thread_chat_${threadId}`).emit("new_thread_message", {
        message: populatedMessage,
        threadId,
        sender: sender,
        timestamp: newMessage.createdAt,
        participants: messageReceivers,
      });

      // Emit to individual participants
      messageReceivers.forEach((receiverId) => {
        if (String(receiverId) !== String(senderId)) {
          io.to(`employee_${receiverId}`).emit("thread_message_received", {
            threadId,
            message: populatedMessage,
            sender: sender,
            isMentioned: content.includes(`@${receiverId}`),
            timestamp: new Date(),
          });
        }
      });

      // Notify the sender
      socket.emit("thread_message_sent", {
        threadId,
        message: populatedMessage,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Thread message sent successfully",
          data: populatedMessage,
          deliveredTo: {
            threadRoom: `thread_chat_${threadId}`,
            participants: messageReceivers,
            sender: senderId,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error sending thread message:", error);
      socket.emit("thread_error", {
        error: "Failed to send thread message",
        details: error.message,
      });

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_SEND_ERROR",
        });
      }
    }
  });

  /**
   * Mark thread messages as read
   */
  socket.on("mark_thread_read", async (data) => {
    try {
      const { threadId, userId, messageIds = [] } = data;

      if (!threadId || !userId) {
        console.error("❌ mark_thread_read: threadId and userId are required");
        return;
      }

      // Update read status for specific messages
      if (messageIds.length > 0) {
        await ThreadChatMessage.updateMany(
          {
            _id: { $in: messageIds },
            "readBy.employee": { $ne: userId },
          },
          {
            $push: {
              readBy: {
                employee: userId,
                readAt: new Date(),
              },
            },
          },
        );
      } else {
        // Mark all unread messages in thread as read
        const unreadMessages = await ThreadChatMessage.find({
          threadId,
          "readBy.employee": { $ne: userId },
          isDeleted: false,
        })
          .select("_id")
          .lean();

        const unreadMessageIds = unreadMessages.map((msg) => msg._id);

        await ThreadChatMessage.updateMany(
          {
            _id: { $in: unreadMessageIds },
          },
          {
            $push: {
              readBy: {
                employee: userId,
                readAt: new Date(),
              },
            },
          },
        );
      }

      // Get updated message IDs
      const updatedMessages = await ThreadChatMessage.find({
        threadId,
        "readBy.employee": userId,
        isDeleted: false,
      })
        .select("_id")
        .lean();

      // Notify other participants
      socket.to(`thread_chat_${threadId}`).emit("thread_messages_read", {
        threadId,
        userId,
        messageIds: updatedMessages.map((m) => m._id),
        readAt: new Date(),
      });
    } catch (error) {
      console.error("❌ Error marking thread as read:", error);
    }
  });

  /**
   * Edit a thread message
   */
  socket.on("edit_thread_message", async (data, callback) => {
    try {
      const { messageId, threadId, content, editedBy, attachments = [] } = data;

      if (!messageId || !threadId || !content || !editedBy) {
        if (callback)
          callback({
            success: false,
            error: "messageId, threadId, content, and editedBy are required",
          });
        return;
      }

      // Find and edit the message
      const message = await ThreadChatMessage.findById(messageId);
      if (!message) {
        throw new Error("Message not found");
      }

      // Use the edit method from schema
      await message.edit(content, editedBy);

      // Update attachments if provided
      if (attachments.length > 0) {
        message.attachments = attachments;
        await message.save();
      }

      // Get updated message with population
      const updatedMessage = await ThreadChatMessage.findById(messageId)
        .populate("sender", "name email avatar")
        .populate("editHistory.editedBy", "name email")
        .populate("attachments.uploadedBy", "name email")
        .lean();

      // Broadcast edit to thread room
      io.to(`thread_chat_${threadId}`).emit("thread_message_edited", {
        messageId,
        threadId,
        message: updatedMessage,
        editedBy,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Thread message edited successfully",
          data: updatedMessage,
        });
      }
    } catch (error) {
      console.error("❌ Error editing thread message:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_EDIT_ERROR",
        });
      }
    }
  });

  /**
   * Delete a thread message (soft delete)
   */
  socket.on("delete_thread_message", async (data, callback) => {
    try {
      const { messageId, threadId, deletedBy, reason = "User deleted" } = data;

      if (!messageId || !threadId || !deletedBy) {
        if (callback)
          callback({
            success: false,
            error: "messageId, threadId, and deletedBy are required",
          });
        return;
      }

      // Soft delete
      const deletedMessage = await ThreadChatMessage.findByIdAndUpdate(
        messageId,
        {
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: deletedBy,
          deleteReason: reason,
          content: "[This message was deleted]",
          attachments: [],
        },
        { new: true },
      ).lean();

      // Broadcast deletion to thread room
      io.to(`thread_chat_${threadId}`).emit("thread_message_deleted", {
        messageId,
        threadId,
        deletedBy,
        reason,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Thread message deleted successfully",
          data: deletedMessage,
        });
      }
    } catch (error) {
      console.error("❌ Error deleting thread message:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_DELETE_ERROR",
        });
      }
    }
  });

  /**
   * Get thread summary/context for AI/assistants
   */
  socket.on("get_thread_summary", async (data, callback) => {
    try {
      const { threadId, maxMessages = 100, forAI = false } = data;

      if (!threadId) {
        if (callback)
          callback({ success: false, error: "threadId is required" });
        return;
      }

      // Get recent messages
      const recentMessages = await ThreadChatMessage.find({
        threadId,
        isDeleted: false,
      })
        .populate("sender", "name role avatar")
        .sort({ createdAt: -1 })
        .limit(maxMessages)
        .lean();

      // Get thread participants
      const participants =
        await ThreadChatMessage.getThreadParticipants(threadId);

      // Get assignment info
      const assignmentInfo = await AssignmentMessage.findOne({
        threadId: threadId,
      })
        .populate("client", "clientName dba")
        .lean();

      // Generate summary
      const summary = {
        threadId,
        totalMessages: recentMessages.length,
        participants: participants.length,
        participantNames: [
          ...new Set(recentMessages.map((m) => m.sender?.name).filter(Boolean)),
        ],
        lastActivity: recentMessages[0]?.createdAt || new Date(),
        keyTopics: extractKeyTopics(recentMessages),
        client: assignmentInfo?.client,
        withAttachments: recentMessages.filter((m) => m.attachments?.length > 0)
          .length,
        messageTypes: recentMessages.reduce((acc, msg) => {
          acc[msg.messageType] = (acc[msg.messageType] || 0) + 1;
          return acc;
        }, {}),
      };

      // For AI context, provide more detailed data
      if (forAI) {
        summary.messages = recentMessages.map((msg) => ({
          role: msg.sender?.role || "user",
          name: msg.sender?.name,
          content: msg.content,
          timestamp: msg.createdAt,
          type: msg.messageType,
          hasAttachments: msg.attachments?.length > 0,
        }));
      }

      socket.emit("thread_summary_received", {
        threadId,
        summary,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          data: summary,
        });
      }
    } catch (error) {
      console.error("❌ Error getting thread summary:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_SUMMARY_ERROR",
        });
      }
    }
  });

  /**
   * Search within thread messages
   */
  socket.on("search_thread_messages", async (data, callback) => {
    try {
      const { threadId, query, userId, limit = 20 } = data;

      if (!threadId || !query) {
        if (callback)
          callback({
            success: false,
            error: "threadId and query are required",
          });
        return;
      }

      const searchResults = await ThreadChatMessage.find({
        threadId,
        isDeleted: false,
        $text: { $search: query },
      })
        .populate("sender", "name email avatar")
        .populate("attachments.uploadedBy", "name email")
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean();

      socket.emit("thread_search_results", {
        threadId,
        query,
        results: searchResults,
        count: searchResults.length,
        searchedBy: userId,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          data: {
            results: searchResults,
            count: searchResults.length,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error searching thread messages:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_SEARCH_ERROR",
        });
      }
    }
  });

  /**
   * Add reaction to thread message
   */
  socket.on("add_thread_reaction", async (data, callback) => {
    try {
      const { messageId, threadId, userId, emoji } = data;

      if (!messageId || !threadId || !userId || !emoji) {
        if (callback)
          callback({
            success: false,
            error: "messageId, threadId, userId, and emoji are required",
          });
        return;
      }

      // Find message and add reaction
      const message = await ThreadChatMessage.findById(messageId);
      if (!message) {
        throw new Error("Message not found");
      }

      await message.addReaction(userId, emoji);

      // Get updated message with populated reactions
      const updatedMessage = await ThreadChatMessage.findById(messageId)
        .populate("reactions.employee", "name avatar")
        .lean();

      // Broadcast reaction to thread room
      io.to(`thread_chat_${threadId}`).emit("thread_reaction_added", {
        messageId,
        threadId,
        userId,
        emoji,
        reactions: updatedMessage.reactions,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Reaction added successfully",
          data: updatedMessage.reactions,
        });
      }
    } catch (error) {
      console.error("❌ Error adding thread reaction:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_REACTION_ERROR",
        });
      }
    }
  });

  /**
   * Remove reaction from thread message
   */
  socket.on("remove_thread_reaction", async (data, callback) => {
    try {
      const { messageId, threadId, userId } = data;

      if (!messageId || !threadId || !userId) {
        if (callback)
          callback({
            success: false,
            error: "messageId, threadId, and userId are required",
          });
        return;
      }

      // Find message and remove reaction
      const message = await ThreadChatMessage.findById(messageId);
      if (!message) {
        throw new Error("Message not found");
      }

      await message.removeReaction(userId);

      // Get updated message with populated reactions
      const updatedMessage = await ThreadChatMessage.findById(messageId)
        .populate("reactions.employee", "name avatar")
        .lean();

      // Broadcast reaction removal to thread room
      io.to(`thread_chat_${threadId}`).emit("thread_reaction_removed", {
        messageId,
        threadId,
        userId,
        reactions: updatedMessage.reactions,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Reaction removed successfully",
          data: updatedMessage.reactions,
        });
      }
    } catch (error) {
      console.error("❌ Error removing thread reaction:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_REACTION_ERROR",
        });
      }
    }
  });

  /**
   * Upload attachments for thread message
   */
  socket.on("upload_thread_attachments", async (data, callback) => {
    try {
      const { threadId, messageId, attachments, userId } = data;

      if (!threadId || !attachments || !userId) {
        if (callback)
          callback({
            success: false,
            error: "threadId, attachments, and userId are required",
          });
        return;
      }

      let message;

      if (messageId) {
        // Add attachments to existing message
        message = await ThreadChatMessage.findById(messageId);
        if (!message) {
          throw new Error("Message not found");
        }

        // Add new attachments
        attachments.forEach((attachment) => {
          attachment.uploadedBy = userId;
          attachment.uploadedAt = new Date();
          message.attachments.push(attachment);
        });

        await message.save();
      } else {
        // Create a new file message
        message = new ThreadChatMessage({
          threadId,
          content: `Sent ${attachments.length} file(s)`,
          owner: userId, // You might need to get owner from context
          sender: userId,
          receiver: [], // You'll need to determine receivers
          messageType: "file",
          attachments: attachments.map((attachment) => ({
            ...attachment,
            uploadedBy: userId,
            uploadedAt: new Date(),
          })),
        });

        await message.save();
      }

      // Populate the message
      const populatedMessage = await ThreadChatMessage.findById(message._id)
        .populate("sender", "name email avatar")
        .populate("attachments.uploadedBy", "name email")
        .lean();

      // Broadcast to thread room
      io.to(`thread_chat_${threadId}`).emit("thread_attachments_uploaded", {
        threadId,
        messageId: message._id,
        message: populatedMessage,
        attachments: populatedMessage.attachments,
        uploadedBy: userId,
        timestamp: new Date(),
      });

      if (callback) {
        callback({
          success: true,
          message: "Attachments uploaded successfully",
          data: populatedMessage,
        });
      }
    } catch (error) {
      console.error("❌ Error uploading thread attachments:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_UPLOAD_ERROR",
        });
      }
    }
  });

  /**
   * Get thread participants
   */
  socket.on("get_thread_participants", async (data, callback) => {
    try {
      const { threadId } = data;

      if (!threadId) {
        if (callback)
          callback({ success: false, error: "threadId is required" });
        return;
      }

      const participants =
        await ThreadChatMessage.getThreadParticipants(threadId);

      // Get participant details
      const participantDetails = await Employee.find({
        _id: { $in: participants },
      })
        .select("name email avatar role department")
        .lean();

      if (callback) {
        callback({
          success: true,
          data: {
            participants: participantDetails,
            count: participantDetails.length,
          },
        });
      }
    } catch (error) {
      console.error("❌ Error getting thread participants:", error);

      if (callback) {
        callback({
          success: false,
          error: error.message,
          code: "THREAD_PARTICIPANTS_ERROR",
        });
      }
    }
  });

  // =============== HELPER FUNCTIONS ===============

  /**
   * Extract key topics from messages
   */
  function extractKeyTopics(messages) {
    const topics = new Map();
    const commonWords = new Set([
      "the",
      "and",
      "for",
      "this",
      "that",
      "with",
      "have",
      "from",
      "will",
      "just",
      "like",
    ]);

    messages.forEach((msg) => {
      if (msg.content && typeof msg.content === "string") {
        const words = msg.content.toLowerCase().split(/\W+/);
        words.forEach((word) => {
          if (word.length > 3 && !commonWords.has(word)) {
            topics.set(word, (topics.get(word) || 0) + 1);
          }
        });
      }
    });

    return Array.from(topics.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => ({ word, count }));
  }

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket client disconnected:", socket.id, "Reason:", reason);
  });

  socket.on("error", (error) => {
    console.error("🔴 Socket error:", error);
  });
});

io.on("connection", (socket) => {
  socket.on("join_employee", (employeeId) => {
    if (!employeeId) {
      console.error("❌ join_employee: employeeId is required");
      return;
    }
    socket.join(`employee_${employeeId}`);
  });

  // Join client room for specific client chats
  socket.on("join_client", (clientId) => {
    if (!clientId) {
      console.error("❌ join_client: clientId is required");
      return;
    }
    socket.join(`client_${clientId}`);
  });

  // Join conversation room (for group chats)
  socket.on("join_conversation", (conversationId) => {
    if (!conversationId) {
      console.error("❌ join_conversation: conversationId is required");
      return;
    }
    socket.join(`conversation_${conversationId}`);
  });

  // 🔥 FIXED: Join client employee room - KEEP ONLY THIS ONE
  socket.on("join_client_employee", (employeeId) => {
    if (!employeeId) {
      console.error("❌ join_client_employee: employeeId is required");
      return;
    }
    // Join BOTH employee room AND client employee room
    socket.join(`employee_${employeeId}`);
    socket.join(`client_employee_${employeeId}`);
  });
  // 🔥 UPDATED: Handle whatsapp_send_message from frontend with approval filtering
  // 🔥 FIXED: whatsapp_send_message handler
  socket.on("whatsapp_send_message", async (data) => {
    try {
      const { message, clientId, senderId, receivers, clientEmployeeId } = data;

      if (!message || !senderId) {
        console.error(
          "❌ whatsapp_send_message: message and senderId are required",
        );
        socket.emit("message_error", { error: "Missing required fields" });
        return;
      }

      // 🔥 CRITICAL: Only notify sender about their own message
      socket.emit("new_message", {
        message: message,
        type: "message_sent",
        action: "sent",
        approvalStatus: message.approvalStatus,
      });

      // 🔥 IMPORTANT: Filter receivers to only notify actual recipients
      if (receivers && Array.isArray(receivers)) {
        receivers.forEach((receiverId) => {
          // Check if this receiver is the actual sender (should already be handled)
          if (receiverId === senderId) return;

          // Check approval status for filtering
          let shouldNotify = false;

          if (
            message.approvalStatus === "approved" ||
            message.approvalStatus === null
          ) {
            // Approved messages or Team Lead/Manager messages
            shouldNotify = true;
          } else if (message.approvalStatus === "pending") {
            // Only notify Team Leads for pending approval
            const isReceiverTeamLead = checkIfTeamLead(receiverId);
            shouldNotify = isReceiverTeamLead;
          }

          if (shouldNotify) {
            // 🔥 Use io.to instead of socket.to to ensure proper delivery
            io.to(`employee_${receiverId}`).emit("new_message", {
              message: message,
              type:
                message.approvalStatus === "pending"
                  ? "reply_needs_approval"
                  : "new_assignment",
              action: "received",
              requiresApproval: message.approvalStatus === "pending",
              // 🔥 ADD: Explicitly mark as for this receiver
              forReceiver: receiverId,
            });
          }
        });
      }

      // 🎯 FIXED: Check approval status before emitting to client rooms
      if (clientEmployeeId) {
        // Only emit to rooms if message is approved or has no approval status
        if (message.approvalStatus !== "pending") {
          // Emit to the parent client room
          if (clientId) {
            io.to(`client_${clientId}`).emit("new_message", {
              message: message,
              type: "new_message",
              action: "client_received",
              isClientEmployeeMessage: true,
              clientEmployeeId: clientEmployeeId,
              clientId: clientId,
            });
          }

          // Emit to the specific client employee room
          io.to(`client_employee_${clientEmployeeId}`).emit("new_message", {
            message: message,
            type: "client_employee_message",
            action: "client_employee_received",
            isClientEmployeeMessage: true,
            clientEmployeeId: clientEmployeeId,
            clientId: clientId,
          });
        }
      } else {
        // Only emit if message is approved or has no approval status
        if (message.approvalStatus !== "pending" && clientId) {
          io.to(`client_${clientId}`).emit("new_message", {
            message: message,
            type: "new_message",
            action: "client_received",
            isClientEmployeeMessage: false,
            clientId: clientId,
          });
        }
      }
    } catch (error) {
      console.error("❌ Error in whatsapp_send_message:", error);
      socket.emit("message_error", { error: "Failed to send message" });
    }
  });
  async function checkIfTeamLead(userId) {
    try {
      const user = await User.findById(userId).select("role").lean();
      if (user && user.role) {
        const role = user.role.toLowerCase();
        return role.includes("lead") || role === "team_lead";
      }
      return false;
    } catch (error) {
      console.error("Error checking team lead status:", error);
      return false;
    }
  }

  socket.on("join:message", (messageId) => {
    if (!messageId) return;
    socket.join(`message:${messageId}`);
  });

  // Leave message room
  socket.on("leave:message", (messageId) => {
    if (!messageId) return;
    socket.leave(`message:${messageId}`);
  });

  socket.on("join:user", (userId) => {
    if (!userId) return;
    socket.join(`user:${userId}`);
  });

  socket.on("comment:add", async (data) => {
    try {
      const { messageId, comment, senderId } = data;

      if (!messageId || !comment || !senderId) {
        console.error(
          "❌ comment:add: messageId, comment, and senderId are required",
        );
        return;
      }

      // Save comment to database (you'll need to implement this)
      // const savedComment = await saveCommentToDatabase(messageId, comment, senderId);

      // For now, create a mock comment
      const savedComment = {
        _id: `comment_${Date.now()}`,
        ...comment,
        sender: { _id: senderId, name: "User" }, // Get from DB
        createdAt: new Date().toISOString(),
        reactions: [],
      };

      // Get updated comment count from database
      // const commentCount = await getCommentCount(messageId);
      const commentCount = 1; // Mock

      // Emit to everyone in the message room
      io.to(`message:${messageId}`).emit("comment:added", {
        messageId,
        comment: savedComment,
        commentCount,
        lastCommentAt: savedComment.createdAt,
        lastCommentBy: savedComment.sender,
      });

      // Also notify specific user if mentioned
      if (comment.mentions && Array.isArray(comment.mentions)) {
        comment.mentions.forEach((mention) => {
          if (mention.userId && mention.userId !== senderId) {
            io.to(`user:${mention.userId}`).emit("comment:mentioned", {
              messageId,
              comment: savedComment,
              mentionedBy: senderId,
            });
          }
        });
      }
    } catch (error) {
      console.error("❌ Error in comment:add:", error);
      socket.emit("comment:error", { error: "Failed to add comment" });
    }
  });

  socket.on("comment:edit", async (data) => {
    try {
      const { messageId, commentId, text, editedBy } = data;

      if (!messageId || !commentId || !text || !editedBy) {
        console.error("❌ comment:edit: All fields are required");
        return;
      }

      const updatedComment = {
        _id: commentId,
        text,
        isEdited: true,
        editedAt: new Date().toISOString(),
        editedBy,
      };

      io.to(`message:${messageId}`).emit("comment:updated", {
        messageId,
        comment: updatedComment,
      });
    } catch (error) {
      console.error("❌ Error in comment:edit:", error);
      socket.emit("comment:error", { error: "Failed to edit comment" });
    }
  });

  socket.on("comment:delete", async (data) => {
    try {
      const { messageId, commentId, deletedBy } = data;

      if (!messageId || !commentId || !deletedBy) {
        console.error("❌ comment:delete: All fields are required");
        return;
      }

      // Delete comment from database
      // await deleteCommentFromDatabase(commentId, deletedBy);
      // const commentCount = await getCommentCount(messageId);
      const commentCount = 0; // Mock

      io.to(`message:${messageId}`).emit("comment:deleted", {
        messageId,
        commentId,
        commentCount,
      });
    } catch (error) {
      console.error("❌ Error in comment:delete:", error);
      socket.emit("comment:error", { error: "Failed to delete comment" });
    }
  });

  socket.on("comment:add_reaction", async (data) => {
    try {
      const { messageId, commentId, reaction, userId } = data;

      if (!messageId || !commentId || !reaction || !userId) {
        console.error("❌ comment:add_reaction: All fields are required");
        return;
      }

      const updatedReaction = {
        emoji: reaction,
        userId,
        timestamp: new Date().toISOString(),
      };

      io.to(`message:${messageId}`).emit("comment:reaction_added", {
        messageId,
        commentId,
        reaction: updatedReaction,
      });
    } catch (error) {
      console.error("❌ Error in comment:add_reaction:", error);
      socket.emit("comment:error", { error: "Failed to add reaction" });
    }
  });

  socket.on("comment:typing", (data) => {
    try {
      const { messageId, userId, isTyping } = data;

      if (!messageId || !userId) {
        console.error("❌ comment:typing: messageId and userId are required");
        return;
      }

      // Broadcast typing status to everyone in the message room except the typing user
      socket.to(`message:${messageId}`).emit("comment:typing", {
        messageId,
        userId,
        isTyping,
      });
    } catch (error) {
      console.error("❌ Error in comment:typing:", error);
    }
  });

  socket.on("whatsapp_approve_message", async (data) => {
    try {
      const { message, approvedBy, receivers, clientId } = data;

      if (!message || !approvedBy) {
        console.error(
          "❌ whatsapp_approve_message: message and approvedBy are required",
        );
        return;
      }

      const updatedMessage = {
        ...message,
        approvalStatus: "approved",
        isForwarded: true,
        forwardedBy: approvedBy,
        forwardedAt: new Date(),
      };

      const allInvolvedUsers = new Set();

      // Add sender
      if (message.sender && message.sender._id) {
        allInvolvedUsers.add(String(message.sender._id));
      }

      // Add all receivers
      if (message.receiver && Array.isArray(message.receiver)) {
        message.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) {
            allInvolvedUsers.add(String(receiverId));
          }
        });
      }

      // Add the approver
      allInvolvedUsers.add(String(approvedBy));

      // Add additional receivers if provided
      if (receivers && Array.isArray(receivers)) {
        receivers.forEach((receiverId) => {
          allInvolvedUsers.add(String(receiverId));
        });
      }

      const involvedUsersArray = Array.from(allInvolvedUsers);

      // Notify all involved users
      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "approved",
          approvedBy: approvedBy,
          timestamp: new Date(),
        });
      });

      // Also emit to the client room for real-time chat updates
      if (clientId) {
        io.to(`client_${clientId}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "approved",
        });
      }

      // Notify sender specifically
      socket.emit("new_message", {
        message: updatedMessage,
        type: "message_approved",
        action: "approved",
      });
    } catch (error) {
      console.error("❌ Error in whatsapp_approve_message:", error);
      socket.emit("message_error", { error: "Failed to approve message" });
    }
  });
  // 🎯 CRITICAL FIX: Handle forwarded approved messages to managers
  socket.on("whatsapp_forward_to_managers", async (data) => {
    try {
      const { message, managers, forwardedBy, clientId } = data;

      if (!message || !managers || !Array.isArray(managers)) {
        console.error(
          "❌ whatsapp_forward_to_managers: message and managers array are required",
        );
        return;
      }

      // Mark this as a forwarded message
      const forwardedMessage = {
        ...message,
        isForwarded: true,
        forwardedBy: forwardedBy,
        originalMessageId: message._id,
        approvalStatus: "approved", // Ensure it's marked as approved
      };

      // Notify each manager about the new forwarded message
      managers.forEach((managerId) => {
        io.to(`employee_${managerId}`).emit("new_message", {
          message: forwardedMessage,
          type: "new_approved_message",
          action: "forwarded_approved",
          forwardedBy: forwardedBy,
          originalMessageId: message._id,
          timestamp: new Date(),
        });
      });

      // Notify the forwarder that forwarding was successful
      socket.emit("new_message", {
        message: forwardedMessage,
        type: "message_forwarded",
        action: "forwarded_to_managers",
      });
    } catch (error) {
      console.error("❌ Error in whatsapp_forward_to_managers:", error);
      socket.emit("message_error", {
        error: "Failed to forward message to managers",
      });
    }
  });

  // 🎯 CRITICAL FIX: Handle message editing events
  socket.on("whatsapp_edit_message", async (data) => {
    try {
      const { message, editedBy, clientId } = data;

      if (!message || !editedBy) {
        console.error(
          "❌ whatsapp_edit_message: message and editedBy are required",
        );
        return;
      }

      // Notify ALL involved users about edit
      const allInvolvedUsers = new Set();

      // Add sender
      if (message.sender && message.sender._id) {
        allInvolvedUsers.add(String(message.sender._id));
      }

      // Add all receivers
      if (message.receiver && Array.isArray(message.receiver)) {
        message.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) {
            allInvolvedUsers.add(String(receiverId));
          }
        });
      }

      // Add the editor
      allInvolvedUsers.add(String(editedBy));

      // Convert to array and emit to each user
      const involvedUsersArray = Array.from(allInvolvedUsers);

      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: message,
          type: "message_updated",
          action: "edited",
          editedBy: editedBy,
          timestamp: new Date(),
        });
      });

      // Also emit to the client room for real-time chat updates
      if (clientId) {
        io.to(`client_${clientId}`).emit("new_message", {
          message: message,
          type: "message_updated",
          action: "edited",
        });
      }
    } catch (error) {
      console.error("❌ Error in whatsapp_edit_message:", error);
      socket.emit("message_error", { error: "Failed to edit message" });
    }
  });

  // 🎯 CRITICAL FIX: Handle message status updates (delivered, read, etc.)
  socket.on("whatsapp_message_status", async (data) => {
    try {
      const { messageId, status, userId, clientId } = data;

      if (!messageId || !status) {
        console.error(
          "❌ whatsapp_message_status: messageId and status are required",
        );
        return;
      }

      // Notify relevant users about status change
      socket.emit("message_status", {
        messageId: messageId,
        status: status,
      });

      // If there's a specific user who triggered the status update, notify them
      if (userId) {
        io.to(`employee_${userId}`).emit("message_status", {
          messageId: messageId,
          status: status,
        });
      }

      // Also notify client room if applicable
      if (clientId) {
        io.to(`client_${clientId}`).emit("message_status", {
          messageId: messageId,
          status: status,
        });
      }
    } catch (error) {
      console.error("❌ Error in whatsapp_message_status:", error);
      socket.emit("message_error", {
        error: "Failed to update message status",
      });
    }
  });

  // Handle generic message sending (keep for backward compatibility)
  socket.on("send_message", async (data) => {
    try {
      const { conversationId, message } = data;

      if (!conversationId || !message) {
        console.error(
          "❌ send_message: conversationId and message are required",
        );
        return;
      }

      // Broadcast to ALL clients in the conversation room
      io.to(`conversation_${conversationId}`).emit("receive_message", message);

      // Also send to sender for confirmation
      socket.emit("message_sent", { success: true, message });
    } catch (error) {
      console.error("❌ Error in send_message:", error);
      socket.emit("message_error", { error: "Failed to send message" });
    }
  });

  // Handle typing indicators
  socket.on("user_typing", (data) => {
    const { conversationId, user, isSpace = false } = data;

    if (!conversationId || !user) {
      console.error("❌ user_typing: conversationId and user are required");
      return;
    }

    const room = isSpace
      ? `space_${conversationId}`
      : `conversation_${conversationId}`;
    socket.to(room).emit("user_typing", { user, conversationId });
  });

  socket.on("user_stopped_typing", (data) => {
    const { conversationId, user, isSpace = false } = data;

    if (!conversationId || !user) {
      console.error(
        "❌ user_stopped_typing: conversationId and user are required",
      );
      return;
    }

    const room = isSpace
      ? `space_${conversationId}`
      : `conversation_${conversationId}`;
    socket.to(room).emit("user_stopped_typing", { user, conversationId });
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    console.log("🔴 Client disconnected:", socket.id, "Reason:", reason);
  });

  socket.on("error", (error) => {
    console.error("🔴 Socket error:", error);
  });
});

io.on("connection", (socket) => {
  socket.on("join_user", (userId) => {
    if (!userId) {
      console.error("❌ join_user: userId is required");
      return;
    }
    socket.join(`user_${userId}`);
  });

  /** 🔹 Join conversation room */
  socket.on("join_conversation", (conversationId) => {
    if (!conversationId) {
      console.error("❌ join_conversation: conversationId is required");
      return;
    }
    socket.join(`conversation_${conversationId}`);
  });

  /** 🔹 Join space room */
  socket.on("join_space", (spaceId) => {
    if (!spaceId) {
      console.error("❌ join_space: spaceId is required");
      return;
    }
    socket.join(`space_${spaceId}`);
  });

  /** 🔹 CRITICAL FIX: Use io.to() for broadcasting to ALL users in room */
  socket.on("send_message", async (data) => {
    try {
      const { conversationId, message } = data;

      if (!conversationId || !message) {
        console.error(
          "❌ send_message: conversationId and message are required",
        );
        return;
      }

      // ✅ FIX: Use io.to() to broadcast to ALL clients in the room
      io.to(`conversation_${conversationId}`).emit("receive_message", message);

      // Also send to sender for confirmation
      socket.emit("message_sent", { success: true, message });
    } catch (error) {
      console.error("❌ Error in send_message:", error);
      socket.emit("message_error", { error: "Failed to send message" });
    }
  });

  /** 🔹 CRITICAL FIX: Use io.to() for space messages too */
  socket.on("send_space_message", async (data) => {
    try {
      const { spaceId, message } = data;

      if (!spaceId || !message) {
        console.error(
          "❌ send_space_message: spaceId and message are required",
        );
        return;
      }

      // ✅ FIX: Use io.to() to broadcast to ALL clients in the room
      io.to(`space_${spaceId}`).emit("receive_space_message", message);

      // Also send to sender for confirmation
      socket.emit("space_message_sent", { success: true, message });
    } catch (error) {
      console.error("❌ Error in send_space_message:", error);
      socket.emit("message_error", { error: "Failed to send space message" });
    }
  });
  /** 🔹 Typing indicators */
  socket.on("user_typing", (data) => {
    const { conversationId, user, isSpace = false } = data;

    if (!conversationId || !user) {
      console.error("❌ user_typing: conversationId and user are required");
      return;
    }

    const room = isSpace
      ? `space_${conversationId}`
      : `conversation_${conversationId}`;
    socket.to(room).emit("user_typing", { user, conversationId });
  });

  socket.on("user_stopped_typing", (data) => {
    const { conversationId, user, isSpace = false } = data;

    if (!conversationId || !user) {
      console.error(
        "❌ user_stopped_typing: conversationId and user are required",
      );
      return;
    }

    const room = isSpace
      ? `space_${conversationId}`
      : `conversation_${conversationId}`;
    socket.to(room).emit("user_stopped_typing", { user, conversationId });
  });

  /** 🔹 Read receipts */
  socket.on("mark_messages_read", (data) => {
    const { conversationId, userId, messageIds = [] } = data;

    if (!conversationId || !userId) {
      console.error(
        "❌ mark_messages_read: conversationId and userId are required",
      );
      return;
    }

    const room = `conversation_${conversationId}`;
    socket.to(room).emit("messages_read", {
      conversationId,
      userId,
      messageIds,
      readAt: new Date(),
    });
  });

  /** 🔹 Handle disconnection */
  socket.on("disconnect", (reason) => {
    console.log("🔴 Client disconnected:", socket.id, "Reason:", reason);
  });

  socket.on("error", (error) => {
    console.error("🔴 Socket error:", error);
  });
});
// 🎯 CRITICAL FIX: Add server-side emission functions for backend controllers
const emitWhatsAppMessage = (io, data) => {
  const { message, type, action, targetUsers, clientId } = data;

  if (!message || !type) {
    console.error("❌ emitWhatsAppMessage: message and type are required");
    return;
  }

  // Emit to specific users if provided
  if (targetUsers && Array.isArray(targetUsers)) {
    targetUsers.forEach((userId) => {
      io.to(`employee_${userId}`).emit("new_message", {
        message: message,
        type: type,
        action: action,
        timestamp: new Date(),
      });
    });
  }

  // Always emit to client room if clientId provided
  if (clientId) {
    io.to(`client_${clientId}`).emit("new_message", {
      message: message,
      type: type,
      action: action,
    });
  }

  // If no specific users, emit to all connected clients (broadcast)
  if (!targetUsers || targetUsers.length === 0) {
    io.emit("new_message", {
      message: message,
      type: type,
      action: action,
    });
  }
};

// 🎯 CRITICAL FIX: Specific function for forwarding to managers
const emitForwardToManagers = (io, data) => {
  const { message, managers, forwardedBy, clientId } = data;

  if (!message || !managers || !Array.isArray(managers)) {
    console.error(
      "❌ emitForwardToManagers: message and managers array are required",
    );
    return;
  }

  const forwardedMessage = {
    ...message,
    isForwarded: true,
    forwardedBy: forwardedBy,
    originalMessageId: message._id,
  };

  managers.forEach((managerId) => {
    io.to(`employee_${managerId}`).emit("new_message", {
      message: forwardedMessage,
      type: "new_approved_message",
      action: "forwarded_approved",
      forwardedBy: forwardedBy,
      originalMessageId: message._id,
      timestamp: new Date(),
    });
  });
};

module.exports = {
  emitWhatsAppMessage,
  emitForwardToManagers,
};
cron.schedule(
  "* * * * *",
  async () => {
    try {
      const results =
        await assignmentMessageController.sendScheduledMessages(io);

      if (results.sent > 0) {
        console.log(`[cron] Sent ${results.sent} scheduled messages`);
      }
      if (results.failed > 0) {
        console.error(
          `[cron] Failed to send ${results.failed} scheduled messages`,
        );
      }
    } catch (err) {
      console.error("[cron] Error sending scheduled messages:", err);
    }
  },
  { timezone: "UTC" },
);
cron.schedule(
  "15 21 26 12 *",
  async () => {
    try {
      const year = new Date().getFullYear();

      // Get distinct owners to respect owner-specific probation policies
      const owners = await Employee.distinct("owner", { isTrashed: false });
      let totalUpdated = 0;

      for (const ownerId of owners) {
        try {
          const probationPolicy = await ProbationPeriod.findOne({
            owner: ownerId,
          })
            .sort({ createdAt: -1 })
            .lean();
          const probationDays = probationPolicy
            ? Number(probationPolicy.days || 0)
            : 0;
          const leaveDuringProbation = probationPolicy
            ? !!probationPolicy.leaveDuringProbation
            : true;

          const baseFilter = {
            isTrashed: false,
            status: { $in: ["active", "pending", "review", "Onboarding"] },
            owner: ownerId,
          };

          if (!leaveDuringProbation && probationDays > 0) {
            // Only update employees whose probation period has ended (joiningDate + probationDays <= today)
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - probationDays);

            // Fetch employees for this owner and filter in JS because joiningDate is stored as string
            const emps = await Employee.find(baseFilter)
              .select("_id joiningDate")
              .lean();
            const idsToUpdate = [];

            for (const e of emps) {
              if (!e.joiningDate) continue;
              const jd = new Date(e.joiningDate);
              if (isNaN(jd.getTime())) continue;
              if (jd <= cutoff) idsToUpdate.push(e._id);
            }

            if (idsToUpdate.length > 0) {
              const res = await Employee.updateMany(
                { _id: { $in: idsToUpdate } },
                {
                  $set: {
                    "leaveEntitlement.total": 22,
                    "leaveEntitlement.usedPaid": 0,
                    "leaveEntitlement.usedUnpaid": 0,
                    "leaveEntitlement.bonus": 0,
                    "leaveEntitlement.bonusHoursAccumulated": 0,
                    "leaveEntitlement.bonusYear": year,
                  },
                },
              );
              totalUpdated += res.modifiedCount || 0;
            }
          } else {
            // Leave allowed during probation or no probation policy: update all for this owner
            const res = await Employee.updateMany(baseFilter, {
              $set: {
                "leaveEntitlement.total": 22,
                "leaveEntitlement.usedPaid": 0,
                "leaveEntitlement.usedUnpaid": 0,
                "leaveEntitlement.bonus": 0,
                "leaveEntitlement.bonusHoursAccumulated": 0,
                "leaveEntitlement.bonusYear": year,
              },
            });
            totalUpdated += res.modifiedCount || 0;
          }
        } catch (innerErr) {
          console.error(
            `Error processing owner ${ownerId} probation policy:`,
            innerErr,
          );
        }
      }
    } catch (error) {
      console.error("❌ Yearly leave entitlement reset failed:", error);
    }
  },
  {
    timezone: "Asia/Karachi",
  },
);

// ---------- Optional root route ----------
app.get("/", (_req, res) => {
  res.send("OK");
});