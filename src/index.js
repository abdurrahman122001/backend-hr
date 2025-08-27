// backend/src/index.js
require("dotenv").config();
const AttendanceConfig = require("./models/AttendanceConfig");

const express = require("express");
const http = require("http");
const https = require("https");            // <--- NEW
const fs = require("fs");                  // <--- NEW
const mongoose = require("mongoose");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");

// Routes (unchanged) ...
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

// Models (unchanged)
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");
const sendSlipEmail = require("./routes/sendSlipEmail");
const probationPeriodRouter = require("./routes/probationPeriods");
const leaveRecordsRouter = require('./routes/leaveRecords');
const certificateRoutes = require('./routes/certificate');
const ExtraFields = require('./routes/extraFields');
const usersRoute = require('./routes/users');
const setDateRoute = require('./routes//setDate');
const { startWatcher } = require("./watcher");
const fontSettingRoute = require("./routes/fontSetting");
const descryptionKeys = require("./routes/decryptionKeys");
const pfRoute = require("./routes/pf");
const GratuityRoute = require("./routes/gratuitySettings");
const SignaturRoute = require("./routes/signature");
const roleRoutes = require("./routes/role");
const pageRoute = require("./routes/page");

const app = express();

/* ---------- CORS: add HTTPS origins ---------- */
const ALLOWED_ORIGINS = [
  "http://admin.virsme.com",  "https://admin.virsme.com",
  "http://admin.innand.com",  "https://admin.innand.com",
  "http://apis.innand.com",   "https://apis.innand.com",
  "http://employee.virsme.com","https://employee.virsme.com",
  "http://hr.virsme.com",     "https://hr.virsme.com",
  "http://localhost:8080",    "http://localhost:8081",
  "http://innand.com",        "https://innand.com",
  "http://www.innand.com",    "https://www.innand.com",
];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, './uploads')));

/* ---------- Routes (unchanged) ---------- */
app.use("/api/auth", authRouter);
app.use('/api/emp-auth', empAuthRouter);
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
app.use("/api/employee-salary", employeeSalaryRouter);
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
app.use('/api/setDate', requireAuth, setDateRoute);
app.use('/api/signature', requireAuth, SignaturRoute);
app.use('/api/emp-attendance', requireEmployeeAuth, empAttendanceRouter);
app.use("/api/emp-birthdays", employeeBirthdays);

/* ---------- Health ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ---------- Socket.IO on HTTPS server ---------- */
const CERT_FULLCHAIN = process.env.CERT_FULLCHAIN || "/etc/letsencrypt/live/innand.com/fullchain.pem";
const CERT_PRIVKEY   = process.env.CERT_PRIVKEY  || "/etc/letsencrypt/live/innand.com/privkey.pem";

const httpsServer = https.createServer({
  cert: fs.readFileSync(CERT_FULLCHAIN),
  key:  fs.readFileSync(CERT_PRIVKEY),
}, app);

// Socket.IO must attach to the HTTPS server
const { Server } = require("socket.io");
const io = new Server(httpsServer, { cors: { origin: "*"} });
app.set("io", io);

io.on("connection", (socket) => {
  console.log("🟢 Socket client connected:", socket.id);
  socket.on("disconnect", () => console.log("🔴 Socket client disconnected:", socket.id));
});

/* ---------- DB connect ---------- */
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => { console.log("▶ MongoDB connected"); startWatcher(); })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* ---------- Cron job (unchanged logic) ---------- */
// ... your cron block stays as-is ...

/* ---------- Start servers ---------- */
const HTTPS_PORT = 443;
const HTTP_PORT  = 80;

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTPS listening on https://innand.com (:${HTTPS_PORT})`);
});

// Lightweight HTTP -> HTTPS redirect
http.createServer((req, res) => {
  const host = req.headers.host || "innand.com";
  res.writeHead(301, { Location: `https://${host}${req.url}` });
  res.end();
}).listen(HTTP_PORT, () => {
  console.log(`➡️  Redirecting HTTP (:${HTTP_PORT}) → HTTPS (:${HTTPS_PORT})`);
});
