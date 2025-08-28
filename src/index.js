// backend/src/index.js
require("dotenv").config();
const AttendanceConfig = require("./models/AttendanceConfig");

const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const mongoose = require("mongoose");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");

// --- Models used in cron / elsewhere ---
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");
const PayrollPeriod = require("./models/PayrollPeriod"); // <-- adjust path if your model file differs

const authRouter = require("./routes/auth");
const empAuthRouter = require('./routes/empAuth');
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
const hierarchyController = require("./controllers/hierarchyController");
const salarySettingsRoutes = require("./routes/salarySettings");
const salarySlipFields = require("./routes/salarySlipFields");
const loansRoutes = require('./routes/loans');
const onboardingRouter = require("./routes/onBoarding");
const requireAuth = require("./middleware/auth");
const requireEmployeeAuth = require('./middleware/empAuth');
const empAttendanceRouter = require("./routes/empAttendance");
const employeeBirthdays = require("./routes/empBirthdayRoutes");


const sendSlipEmail = require("./routes/sendSlipEmail");
const probationPeriodRouter = require("./routes/probationPeriods");
const leaveRecordsRouter = require('./routes/leaveRecords');
const certificateRoutes = require('./routes/certificate');
const ExtraFields = require('./routes/extraFields');
const usersRoute = require('./routes/users');  // <-- Correc
const setDateRoute = require('./routes//setDate');
// IMAP watcher
const { startWatcher } = require("./watcher");
const fontSettingRoute = require("./routes/fontSetting");
const descryptionKeys = require("./routes/decryptionKeys");
const pfRoute = require("./routes/pf");
const GratuityRoute = require("./routes/gratuitySettings");
const SignaturRoute = require("./routes/signature");
const roleRoutes = require("./routes/role");
const pageRoute = require("./routes/page");
const app = express();
const taxRoutes = require("./routes/taxRoutes");
const server = http.createServer(app);
// IMAP watcher
const { startWatcher } = require("./watcher");

const app = express();

/* ---------- Security / Headers (optional but recommended) ---------- */
// Force HTTPS on clients after first visit (1 year)
/*
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});
*/

/* ---------- Static files ---------- */
app.use("/uploads", express.static(path.join(__dirname, "./uploads")));

/* ---------- CORS ---------- */
const ALLOWED_ORIGINS = [
  "http://admin.virsme.com",   "https://admin.virsme.com",
  "http://admin.innand.com",   "https://admin.innand.com",
  "http://apis.innand.com",    "https://apis.innand.com",
  "http://employee.virsme.com","https://employee.virsme.com",
  "http://hr.virsme.com",      "https://hr.virsme.com",
  "http://innand.com",         "https://innand.com",
  "http://www.innand.com",     "https://www.innand.com",
  "http://localhost:8080", "http://localhost:8081", "http://localhost:8082",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl / server-to-server
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(path.join(__dirname, './uploads'))); // Serve static files from uploads folder
// === Public routes ===
app.use("/api/auth", authRouter);
app.use('/api/emp-auth', empAuthRouter);
// === Protected routes ===
app.use("/api/employees", employeesRouter);
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
app.use("/api/company-profile", require("./routes/companyProfile"));
app.use("/api/docs", docsRouter);
app.use("/api/employee-salary", employeeSalaryRouter);  // <--- THIS LINE
app.use("/api/departments", requireAuth, departmentsRouter);
app.use("/api/designations", requireAuth, designationsRouter);
app.use("/api/salary-settings", requireAuth, salarySettingsRoutes);
app.use("/api/salary-fields", requireAuth, salarySlipFields);
app.use("/api/send-slip-email", requireAuth, sendSlipEmail);
app.use("/api/onboarding", requireAuth, onboardingRouter);
app.use("/api/loans", loansRoutes);
app.use('/api/loan', loansRoutes);
app.use("/api/probation-periods", probationPeriodRouter);
app.use('/api/leave-records', requireAuth, leaveRecordsRouter);
app.use('/api/certificates', certificateRoutes);
app.use("/api/font-setting", fontSettingRoute);
app.use('/api/decryption-keys', requireAuth, descryptionKeys);
app.use('/api/extra-fields', requireAuth, ExtraFields);
app.use('/api/pf', pfRoute);
app.use('/api/gratuity', requireAuth, GratuityRoute);
app.use('/api/role', requireAuth, roleRoutes);
app.use('/api/pages', requireAuth, pageRoute);
app.use('/api/users', requireAuth, usersRoute);
app.use('/api/setDate', requireAuth, setDateRoute)
app.use('/api/signature', requireAuth, SignaturRoute);
app.use('/api/emp-attendance', requireEmployeeAuth, empAttendanceRouter);
app.use("/api/emp-birthdays", employeeBirthdays);
app.use("/api/tax", taxRoutes);

/* ---------- Health ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ---------- TLS (Let’s Encrypt) ---------- */
const CERT_FULLCHAIN =
  process.env.CERT_FULLCHAIN || "/etc/letsencrypt/live/innand.com/fullchain.pem";
const CERT_PRIVKEY =
  process.env.CERT_PRIVKEY || "/etc/letsencrypt/live/innand.com/privkey.pem";

const httpsServer = https.createServer(
  {
    cert: fs.readFileSync(CERT_FULLCHAIN),
    key: fs.readFileSync(CERT_PRIVKEY),
  },
  app
);

/* ---------- Socket.IO on HTTPS server ---------- */
const { Server } = require("socket.io");
const io = new Server(httpsServer, {
  cors: { origin: "*", credentials: true }, // tighten if you want: origin: ALLOWED_ORIGINS
});
app.set("io", io);

io.on("connection", (socket) => {
  console.log("🟢 Socket client connected:", socket.id);
  socket.on("disconnect", () =>
    console.log("🔴 Socket client disconnected:", socket.id)
  );
});

/* ---------- MongoDB ---------- */
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("▶ MongoDB connected");
    // Start IMAP watcher once DB is up
    startWatcher();
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* ---------- Change Streams: Watch Employee inserts/updates ---------- */
Employee.watch().on("change", (change) => {
  if (change.operationType === "insert") {
    const emp = change.fullDocument;
    io.emit("employee_added", {
      message: `New employee added: ${emp.name}`,
      createdAt: emp.createdAt,
    });
  }

  if (change.operationType === "update") {
    const updatedFields = change.updateDescription.updatedFields || {};
    if ("cnic" in updatedFields) {
      const newCnic = updatedFields.cnic;
      Employee.findById(change.documentKey._id)
        .lean()
        .then((emp) => {
          if (!emp) return;
          io.emit("employee_cnic_updated", {
            message: `CNIC for ${emp.name} updated to ${newCnic}`,
            createdAt: new Date().toISOString(),
          });
        })
        .catch(console.error);
    }
  }
});

/* ---------- Public: employee count ---------- */
app.get("/api/employees/count", async (_req, res) => {
  try {
    const count = await Employee.countDocuments();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: "Failed to get employee count" });
  }
});

/* ---------- Cron: auto-fill yesterday’s attendance ---------- */
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      // Compute date first (fixes earlier reference before assignment)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const y = yesterday.getFullYear();
      const m = String(yesterday.getMonth() + 1).padStart(2, "0");
      const d = String(yesterday.getDate()).padStart(2, "0");
      const date = `${y}-${m}-${d}`;

      const config = await AttendanceConfig.findOne({}).lean();
      if (config && config.markAbsentManually === true) {
        console.log(
          "[cron] markAbsentManually is true; skipping auto-absent marking for today."
        );
        return;
      }

      // Skip holidays
      const holiday = await Attendance.findOne({ date, isHoliday: true }).lean();
      if (holiday) {
        console.log(
          `[cron] ${date} is marked as a holiday; skipping auto-absent marking.`
        );
        return;
      }

      console.log("[cron] Auto-filling absent attendance for yesterday");

      // Employees already recorded for that date
      const done = await Attendance.find({ date })
        .select("employee")
        .lean();
      const doneIds = new Set(done.map((r) => String(r.employee)));

      // All employees
      const allEmps = await Employee.find({})
        .select("_id owner shifts")
        .lean();

      // Payroll periods
      const allPayrolls = await PayrollPeriod.find({}).lean();

      // Day name for yesterday
      const dayName = yesterday
        .toLocaleDateString("en-US", { weekday: "long" })
        .toLowerCase();
      console.log(`[cron] Yesterday was: ${dayName}`);

      const ops = [];

      for (const e of allEmps) {
        if (doneIds.has(String(e._id))) continue;

        const payroll = allPayrolls.find(
          (p) =>
            Array.isArray(p.shifts) &&
            e.shifts &&
            e.shifts.some((s) => p.shifts.map(String).includes(String(s)))
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
                  owner: e.owner,
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
        const nonWorking = payroll.nonWorkingDays
          .map((n) => String(n).toLowerCase().trim());
        if (nonWorking.includes(dayName)) {
          continue; // skip marking absent on a non-working day
        }

        // Otherwise, mark absent
        ops.push({
          updateOne: {
            filter: { employee: e._id, date },
            update: {
              $setOnInsert: {
                employee: e._id,
                date,
                owner: e.owner,
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
        const res = await Attendance.bulkWrite(ops);
        console.log(`[cron] Upserted ${res.upsertedCount} records for ${date}`);
      } else {
        console.log(
          `[cron] All employees have attendance for ${date} or it's a non-working day.`
        );
      }
    } catch (err) {
      console.error("[cron] Error auto-filling attendance:", err);
    }
  },
  { timezone: "UTC" }
);

/* ---------- Start servers ---------- */
const HTTPS_PORT = 443;
const HTTP_PORT = 80;

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTPS listening on https://innand.com (:${HTTPS_PORT})`);
});

// Lightweight HTTP → HTTPS redirect
http
  .createServer((req, res) => {
    const host = req.headers.host || "innand.com";
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  })
  .listen(HTTP_PORT, () => {
    console.log(`➡️  Redirecting HTTP (:${HTTP_PORT}) → HTTPS (:${HTTPS_PORT})`);
  });
