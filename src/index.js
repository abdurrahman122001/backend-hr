// backend/src/index.js
// ---------------------------------------------
// Bootstrapped, robust Express + Mongoose server
// - Safer HTTPS handling (falls back to HTTP if certs missing)
// - Safer Mongo change streams (no crash if not in replica set)
// - Fixed small typos & path issues
// - Configurable cron timezone (defaults to Asia/Karachi)
// ---------------------------------------------

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cron = require("node-cron");

// ---------- Models used in cron / elsewhere ----------
const AttendanceConfig = require("./models/AttendanceConfig");
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");
const PayrollPeriod = require("./models/PayrollPeriod");

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

// ---------- App ----------
const app = express();

// ---------- Static ----------
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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
  "https://www.innand.com",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:8082",
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
  })
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
app.use("/api/company-profile", require("./routes/companyProfile"));
app.use("/api/docs", docsRouter);
app.use("/api/employee-salary", employeeSalaryRouter);
app.use("/api/departments", requireAuth, departmentsRouter);
app.use("/api/designations", requireAuth, designationsRouter);
app.use("/api/salary-settings", requireAuth, salarySettingsRoutes);
app.use("/api/salary-fields", requireAuth, salarySlipFields);
app.use("/api/send-slip-email", requireAuth, sendSlipEmail);
app.use("/api/onboarding", requireAuth, onboardingRouter);

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

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

    // Start IMAP watcher once DB is up (wrap to avoid crashing if it throws)
    try {
      startWatcher();
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
        err?.message || err
      );
      try {
        changeStream.close();
      } catch {}
    });
  } catch (e) {
    console.warn(
      "⚠️ Change streams not supported (no replica set / permissions?). Skipping.",
      e?.message || e
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
        console.log(
          "[cron] markAbsentManually = true; skipping auto-absent marking."
        );
        return;
      }

      // Skip holidays
      const holiday = await Attendance.findOne({ date, isHoliday: true }).lean();
      if (holiday) {
        console.log(`[cron] ${date} is a holiday; skipping auto-absent marking.`);
        return;
      }

      console.log(`[cron] Auto-filling 'Absent' for ${date} where needed`);

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
      console.log(`[cron] Yesterday was: ${dayName}`);

      const ops = [];

      for (const e of allEmps) {
        if (doneIds.has(String(e._id))) continue;

        const payroll = allPayrolls.find(
          (p) =>
            Array.isArray(p.shifts) &&
            Array.isArray(e.shifts) &&
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
        const nonWorking = payroll.nonWorkingDays
          .map((n) => String(n).toLowerCase().trim());
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
        console.log(`[cron] Upserted ${upserted} records for ${date}`);
      } else {
        console.log(
          `[cron] Nothing to upsert for ${date} (already marked or non-working).`
        );
      }
    } catch (err) {
      console.error("[cron] Error auto-filling attendance:", err);
    }
  },
  { timezone: ATTENDANCE_CRON_TZ }
);

// ---------- TLS (Let’s Encrypt) & Server Startup ----------
const ENABLE_HTTPS = (process.env.ENABLE_HTTPS || "true").toLowerCase() !== "false";
const DEFAULT_DOMAIN = process.env.DOMAIN || "innand.com";

const CERT_FULLCHAIN =
  process.env.CERT_FULLCHAIN ||
  `/etc/letsencrypt/live/${DEFAULT_DOMAIN}/fullchain.pem`;
const CERT_PRIVKEY =
  process.env.CERT_PRIVKEY ||
  `/etc/letsencrypt/live/${DEFAULT_DOMAIN}/privkey.pem`;

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
const HTTP_PORT = Number(process.env.HTTP_PORT || 80);

let primaryServer; // the server we attach socket.io to
let httpsEnabled = false;

if (ENABLE_HTTPS && fs.existsSync(CERT_FULLCHAIN) && fs.existsSync(CERT_PRIVKEY)) {
  // Start HTTPS server
  const httpsServer = https.createServer(
    {
      cert: fs.readFileSync(CERT_FULLCHAIN),
      key: fs.readFileSync(CERT_PRIVKEY),
    },
    app
  );
  primaryServer = httpsServer;
  httpsEnabled = true;

  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🔐 HTTPS listening on https://${DEFAULT_DOMAIN}:${HTTPS_PORT}`);
  });

  // Lightweight HTTP → HTTPS redirect
  http
    .createServer((req, res) => {
      const host = req.headers.host || DEFAULT_DOMAIN;
      const location = `https://${host}${req.url}`;
      res.writeHead(301, { Location: location });
      res.end();
    })
    .listen(HTTP_PORT, () => {
      console.log(`➡️  Redirecting HTTP (:${HTTP_PORT}) → HTTPS (:${HTTPS_PORT})`);
    });
} else {
  // Fallback to HTTP only (useful for local/dev or when cert files missing)
  const httpServer = http.createServer(app);
  primaryServer = httpServer;

  httpServer.listen(HTTP_PORT, () => {
    console.log(`🔓 HTTP listening on http://0.0.0.0:${HTTP_PORT}`);
    if (ENABLE_HTTPS) {
      console.warn(
        "⚠️ HTTPS requested but cert files were not found. Running on HTTP only. " +
          "Set ENABLE_HTTPS=false to silence this warning, or provide CERT_FULLCHAIN & CERT_PRIVKEY."
      );
    }
  });
}

// ---------- Socket.IO on the primary server ----------
const { Server } = require("socket.io");
const io = new Server(primaryServer, {
  // If you want to restrict, set origin: ALLOWED_ORIGINS instead of "*"
  cors: { origin: "*", credentials: true },
});
app.set("io", io);

io.on("connection", (socket) => {
  console.log("🟢 Socket client connected:", socket.id);
  socket.on("disconnect", () =>
    console.log("🔴 Socket client disconnected:", socket.id)
  );
});

// ---------- Optional root route ----------
app.get("/", (_req, res) => {
  res.send("OK");
});
