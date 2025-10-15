// backend/src/index.js
require("dotenv").config();
const AttendanceConfig = require("./models/AttendanceConfig");

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");
const socketIo = require("socket.io");
// Route imports
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
const hierarchyController = require("./controllers/hierarchyController");
const salarySettingsRoutes = require("./routes/salarySettings");
const salarySlipFields = require("./routes/salarySlipFields");
const loansRoutes = require("./routes/loans");
const onboardingRouter = require("./routes/onBoarding");
const requireAuth = require("./middleware/auth");
const requireEmployeeAuth = require("./middleware/empAuth");
const empAttendanceRouter = require("./routes/empAttendance");
const employeeBirthdays = require("./routes/empBirthdayRoutes");
const attendanceLeaveSummaryRouter = require("./routes/attendanceLeaveSummary");
const employeeLeavesRouter = require("./routes/employeeLeaves");
const assignmentMessageController = require("./controllers/assignmentMessageController");

// Model imports
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");
const sendSlipEmail = require("./routes/sendSlipEmail");
const probationPeriodRouter = require("./routes/probationPeriods");
const leaveRecordsRouter = require("./routes/leaveRecords");
const certificateRoutes = require("./routes/certificate");
const ExtraFields = require("./routes/extraFields");
const usersRoute = require("./routes/users"); // <-- Correc
const setDateRoute = require("./routes//setDate");
// IMAP watcher
const { startWatcher } = require("./watcher");
const fontSettingRoute = require("./routes/fontSetting");
const descryptionKeys = require("./routes/decryptionKeys");
const pfRoute = require("./routes/pf");
const GratuityRoute = require("./routes/gratuitySettings");
const SignaturRoute = require("./routes/signature");
const roleRoutes = require("./routes/role");
const pageRoute = require("./routes/page");
const taxRoutes = require("./routes/taxRoutes");
const managerRoutes = require("./routes/manager");
const taskRoutes = require("./routes/tasks");
const clientInfoRoutes = require("./routes/clientInfo");
const assignMessageRoutes = require("./routes/assignmentMessage");
const emailRoutes = require("./routes/emailRoutes");
const generateRouter = require("./routes/generate-pdfs");
const AssignmentMessage = require("./models/AssignmentMessage");
const whatsAppMessageRoutes = require("./routes/whatsAppMessageRoute");
const WhatsAppMessageSchema = require("./models/WhatsAppMessage");
const chatRoutes = require("./routes/chat");
const offerEmail = require("./routes/offerEmail");
// Get today's date in YYYY-MM-DD format (for cron job)
const app = express();
// Wrap express in an HTTP server for Socket-IO
const server = http.createServer(app);

// Initialize Socket-IO
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

// Make `io` available on `req.app` in case you ever want to emit from inside routes
app.set("io", io);

// === Middleware ===
app.use(
  cors({
    origin: [
      "http://admin.virsme.com",
      "http://admin.innand.com",
      "http://apis.innand.com",
      "http://employee.virsme.com",
      "http://hr.virsme.com",
      "http://localhost:8080",
      "http://innand.com",
      "http://localhost:8081",
      "http://localhost:8082",
    ],
    credentials: true, // if you need cookies/auth
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(
  "/uploads",
  express.static(path.join(__dirname, "./uploads"))
);

// If you want a separate mount for chat‐attachments you can,
// but it isn't necessary if they're inside uploads/chat-attachments/
app.use(
  "/uploads/chat-attachments",
  express.static(path.join(__dirname, "../uploads/chat-attachments"))
);

app.use("/api/auth", authRouter);
app.use("/api/emp-auth", empAuthRouter);
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
app.use("/api/employee-salary", employeeSalaryRouter); // <--- THIS LINE
app.use("/api/departments", requireAuth, departmentsRouter);
app.use("/api/designations", requireAuth, designationsRouter);
app.use("/api/salary-settings", requireAuth, salarySettingsRoutes);
app.use("/api/salary-fields", requireAuth, salarySlipFields);
app.use("/api/send-slip-email", requireAuth, sendSlipEmail);
app.use("/api/onboarding", requireAuth, onboardingRouter);
app.use("/api/loans", loansRoutes);
app.use("/api/loan", loansRoutes);
app.use("/api/probation-periods", probationPeriodRouter);
app.use("/api/leave-records", requireAuth, leaveRecordsRouter);
app.use("/api/certificates", certificateRoutes);
app.use("/api/font-setting", fontSettingRoute);
app.use("/api/decryption-keys", requireAuth, descryptionKeys);
app.use("/api/extra-fields", requireAuth, ExtraFields);
app.use("/api/pf", pfRoute);
app.use("/api/gratuity", requireAuth, GratuityRoute);
app.use("/api/role", requireAuth, roleRoutes);
app.use("/api/pages", requireAuth, pageRoute);
app.use("/api/users", requireAuth, usersRoute);
app.use("/api/setDate", requireAuth, setDateRoute);
app.use("/api/signature", requireAuth, SignaturRoute);
app.use("/api/emp-attendance", requireEmployeeAuth, empAttendanceRouter);
app.use("/api/emp-birthdays", employeeBirthdays);
app.use("/api/tax", taxRoutes);
app.use("/api/attendance", requireAuth, attendanceLeaveSummaryRouter);
app.use("/api/emp-leaves", requireEmployeeAuth, employeeLeavesRouter);
app.use("/api/manager", managerRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/client-info", clientInfoRoutes);
app.use("/api/assignment-messages", assignMessageRoutes);
app.use("/api/whatsApp-messages", whatsAppMessageRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/generate", requireAuth, generateRouter);
app.use("/api/offer-email" , requireAuth, offerEmail)
app.post("/api/hierarchy/create", requireAuth, hierarchyController.create);
app.post(
  "/api/hierarchy/bulkCreate",
  requireAuth,
  hierarchyController.bulkCreate
);
app.get("/api/hierarchy", requireAuth, hierarchyController.getHierarchy);
app.get(
  "/api/hierarchy/directReports/:employeeId",
  requireAuth,
  hierarchyController.getDirectReports
);
app.get(
  "/api/hierarchy/managementChain/:employeeId",
  requireAuth,
  hierarchyController.getManagementChain
);
app.delete(
  "/api/hierarchy/:id",
  requireAuth,
  hierarchyController.deleteHierarchy
);
app.get("/api/employees/count", async (req, res) => {
  try {
    const count = await Employee.countDocuments();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: "Failed to get employee count" });
  }
});

// Make io available to routes
app.set("io", io);

io.on("connection", (socket) => {
  // Join employee room
  socket.on("join_employee", (employeeId) => {
    if (!employeeId) {
      console.error("❌ join_employee: employeeId is required");
      return;
    }
    socket.join(`employee_${employeeId}`);
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

  // Handle assignment message disapproval - UPDATED FOR ARRAY RECEIVER
  socket.on("assignment_message_disapproved", async (data, callback) => {
    try {

      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data in disapproval");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy");

      if (!populatedMessage) {
        console.error(
          "❌ Disapproved assignment message not found:",
          message._id
        );
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }
      // Get the client ID
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // CRITICAL FIX: Handle receiver as array consistently
      let actualReceiverIds = [];

      if (Array.isArray(populatedMessage.receiver)) {
        actualReceiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id
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
            action: "disapproved",
          });
      }

      // 2. Notify the sender about disapproval
      const senderId =
        typeof populatedMessage.sender === "string"
          ? populatedMessage.sender
          : populatedMessage.sender?._id;

      if (senderId) {
        socket
          .to(`employee_${senderId}`)
          .emit("assignment_message_disapproved", {
            message: {
              ...populatedMessage,
              receiver: actualReceiverIds,
            },
            action: "disapproved",
            timestamp: new Date(),
          });
      }

      // 3. Notify all receivers about disapproval
      actualReceiverIds.forEach((receiverId) => {
        if (receiverId && receiverId !== senderId) {
          socket
            .to(`employee_${receiverId}`)
            .emit("assignment_message_disapproved", {
              message: {
                ...populatedMessage,
                receiver: actualReceiverIds,
              },
              action: "disapproved",
              timestamp: new Date(),
            });
        }
      });

      // 4. Notify team leads
      socket
        .to("assignment_team_leads")
        .emit("assignment_message_disapproved", {
          message: {
            ...populatedMessage,
            receiver: actualReceiverIds,
          },
          action: "disapproved",
          timestamp: new Date(),
        });

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

  // Join team leads room
  socket.on("join_assignment_team_leads", () => {
    socket.join("assignment_team_leads");
  });

  // Handle assignment message resubmission events - UPDATED FOR ARRAY RECEIVER
  socket.on("assignment_message_resubmitted", async (data, callback) => {
    try {
      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data in resubmission");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("attachments.uploadedBy");

      if (!populatedMessage) {
        console.error(
          "❌ Resubmitted assignment message not found:",
          message._id
        );
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      // Get the client ID
      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // CRITICAL FIX: Handle receiver as array consistently
      let actualReceiverIds = [];

      if (Array.isArray(populatedMessage.receiver)) {
        actualReceiverIds = populatedMessage.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id
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

  // Handle assignment message sending - SEND ONLY TO SPECIFIC RECEIVER IDs
  socket.on("send_assignment_message", async (data, callback) => {
    try {

      const { message } = data;

      if (!message || !message._id) {
        console.error("❌ Invalid message data");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the message with all necessary data
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("scheduledBy")
        .populate("attachments.uploadedBy");

      if (!populatedMessage) {
        console.error("❌ Assignment message not found:", message._id);
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      // Use the targeted emission function
      await emitToSpecificReceivers(
        io,
        populatedMessage,
        "new_assignment_message"
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
  // Handle assignment message updates - UPDATED FOR ARRAY RECEIVER
  socket.on("assignment_message_updated", (data) => {
    try {
      const { message, action, clientId } = data;

      if (!message) {
        console.error("❌ assignment_message_updated: message is required");
        return;
      }

      // CRITICAL FIX: Handle receiver as array consistently
      let receiverIds = [];

      if (Array.isArray(message.receiver)) {
        receiverIds = message.receiver
          .map((receiver) =>
            typeof receiver === "string" ? receiver : receiver?._id
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
              receiver: receiverIds, // Ensure consistent format
            },
            action,
          }
        );
      }

      // Notify ONLY actual participants
      const allParticipants = new Set(
        [senderId, ...receiverIds].filter(Boolean)
      );

      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: {
            ...message,
            receiver: receiverIds, // Ensure consistent format
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
    } catch (error) {
      console.error("❌ Error in assignment_message_updated:", error);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket client disconnected:", socket.id, "Reason:", reason);
  });

  socket.on("error", (error) => {
    console.error("🔴 Socket error:", error);
  });
});

io.on("connection", (socket) => {
  // Join room based on employee ID
  socket.on("join_employee", (employeeId) => {
    socket.join(`employee_${employeeId}`);
  });

  // Join room based on client ID
  socket.on("join_client", (clientId) => {
    socket.join(`client_${clientId}`);
  });

  // ========== ASSIGNMENT MESSAGES HANDLERS ==========
  socket.on("join_assignment_chat", (clientId) => {
    socket.join(`assignment_client_${clientId}`);
  });

  socket.on("send_assignment", async (data, callback) => {
    try {
      const { message, client, recipientIds, senderId } = data;

      if (!message) {
        console.error("❌ Invalid assignment message data");
        if (callback)
          callback({ success: false, error: "Invalid message data" });
        return;
      }

      // Populate the assignment message with all data
      const populatedMessage = await AssignmentMessage.findById(message._id)
        .populate("owner")
        .populate("sender")
        .populate("receiver")
        .populate("client")
        .populate("scheduledBy");

      if (!populatedMessage) {
        console.error("❌ Assignment message not found:", message._id);
        if (callback) callback({ success: false, error: "Message not found" });
        return;
      }

      const clientId =
        typeof populatedMessage.client === "string"
          ? populatedMessage.client
          : populatedMessage.client?._id;

      // 1. Broadcast to assignment client room
      if (clientId) {
        io.to(`assignment_client_${clientId}`).emit(
          "new_assignment_message",
          populatedMessage
        );
      }

      // 2. Broadcast to employee recipients from message data
      if (
        populatedMessage.receiver &&
        Array.isArray(populatedMessage.receiver)
      ) {
        populatedMessage.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "string" ? receiver : receiver._id;
          if (receiverId) {
            io.to(`employee_${receiverId}`).emit(
              "new_assignment_message",
              populatedMessage
            );
          }
        });
      }

      // 3. Broadcast to additional recipientIds if provided
      if (recipientIds && recipientIds.length > 0) {
        recipientIds.forEach((employeeId) => {
          if (employeeId !== senderId) {
            io.to(`employee_${employeeId}`).emit(
              "new_assignment_message",
              populatedMessage
            );
          }
        });
      }

      // 4. Send confirmation to sender
      socket.emit("new_assignment_message", populatedMessage);

      if (callback) {
        callback({
          success: true,
          message: "Assignment message delivered to all recipients",
        });
      }
    } catch (error) {
      console.error("❌ Error broadcasting assignment message:", error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Handle assignment message status updates
  socket.on("assignment_message_status_update", (data) => {
    const { messageId, status, clientId } = data;
    io.to(`assignment_client_${clientId}`).emit("assignment_message_status", {
      messageId,
      status,
    });
  });

  // Join manager room for assignments
  socket.on("join_assignment_managers", () => {
    socket.join("assignment_managers");
  });

  // Join team leads room for assignments
  socket.on("join_assignment_team_leads", () => {
    socket.join("assignment_team_leads");
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket client disconnected:", socket.id, "Reason:", reason);
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
          "❌ send_message: conversationId and message are required"
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
          "❌ send_space_message: spaceId and message are required"
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
        "❌ user_stopped_typing: conversationId and user are required"
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
        "❌ mark_messages_read: conversationId and userId are required"
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
// === Watch Employee collection for inserts ===
Employee.watch().on("change", (change) => {
  // 1) New document inserted
  if (change.operationType === "insert") {
    const emp = change.fullDocument;
    io.emit("employee_added", {
      message: `New employee added: ${emp.name}`,
      createdAt: emp.createdAt,
    });
  }

  // 2) Existing document updated
  if (change.operationType === "update") {
    const updatedFields = change.updateDescription.updatedFields;
    // a) CNIC field was set or changed
    if ("cnic" in updatedFields) {
      const newCnic = updatedFields.cnic;
      // You can fetch the full doc if you need other fields:
      Employee.findById(change.documentKey._id)
        .lean()
        .then((emp) => {
          io.emit("employee_cnic_updated", {
            message: `CNIC for ${emp.name} updated to ${newCnic}`,
            createdAt: new Date().toISOString(),
          });
        })
        .catch(console.error);
    }
  }
});

// === MongoDB connection ===
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

// === Cron job: auto-fill yesterday’s attendance ===
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      const config = await AttendanceConfig.findOne({}).lean();
      if (config && config.markAbsentManually === true) {
        return;
      }
      const holiday = await Attendance.findOne({ date, isHoliday: true });
      if (holiday) {
        return;
      }
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const y = yesterday.getFullYear();
      const m = String(yesterday.getMonth() + 1).padStart(2, "0");
      const d = String(yesterday.getDate()).padStart(2, "0");
      const date = `${y}-${m}-${d}`;

      // Identify who already has records
      const done = await Attendance.find({ date }).select("employee").lean();
      const doneIds = new Set(done.map((r) => r.employee.toString()));

      // Get all employees, including their shifts
      const allEmps = await Employee.find({}).select("_id owner shifts").lean();

      // Get all payroll periods
      const allPayrolls = await PayrollPeriod.find({}).lean();

      // Get day name (e.g., 'sunday') for yesterday
      const dayName = yesterday
        .toLocaleDateString("en-US", { weekday: "long" })
        .toLowerCase();
      const ops = [];

      for (const e of allEmps) {
        // Skip employees who already have attendance for the day
        if (doneIds.has(e._id.toString())) continue;

        // Find payroll period for any of employee's shifts (first match)
        const payroll = allPayrolls.find(
          (p) =>
            Array.isArray(p.shifts) &&
            e.shifts &&
            e.shifts.some((s) => p.shifts.map(String).includes(String(s)))
        );

        // If no payroll period or nonWorkingDays, mark absent as before
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

        // Check if yesterday is a non-working day for this payroll period
        const nonWorking = payroll.nonWorkingDays.map((n) =>
          String(n).toLowerCase().trim()
        );
        if (nonWorking.includes(dayName)) {
          // It's a non-working day, skip marking absent
          continue;
        }

        // Otherwise, mark absent as usual
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
cron.schedule(
  "* * * * *", // Every minute
  async () => {
    try {
      const results = await assignmentMessageController.sendScheduledMessages(
        io
      );

      if (results.sent > 0) {
        console.log(`[cron] Sent ${results.sent} scheduled messages`);
      }
      if (results.failed > 0) {
        console.error(
          `[cron] Failed to send ${results.failed} scheduled messages`
        );
      }
    } catch (err) {
      console.error("[cron] Error sending scheduled messages:", err);
    }
  },
  { timezone: "UTC" }
);
// === Start the server (with Socket-IO) ===
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`▶ API + Socket.IO listening on port ${PORT}`);
});