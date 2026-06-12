// controllers/emailController.js
const emailReceiverService = require("../services/emailReceiverService");

// Start email receiver
exports.startEmailReceiver = async function(req, res) {
  try {
    const io = req.app.get("io");
    emailReceiverService.initialize(io);
    emailReceiverService.connect();
    
    res.json({
      success: true,
      message: "Email receiver started",
      status: emailReceiverService.getStatus()
    });
  } catch (error) {
    console.error("Error starting email receiver:", error);
    res.status(500).json({
      success: false,
      error: "Failed to start email receiver"
    });
  }
};

// Stop email receiver
exports.stopEmailReceiver = async function(req, res) {
  try {
    emailReceiverService.disconnect();
    
    res.json({
      success: true,
      message: "Email receiver stopped"
    });
  } catch (error) {
    console.error("Error stopping email receiver:", error);
    res.status(500).json({
      success: false,
      error: "Failed to stop email receiver"
    });
  }
};

// Get receiver status
exports.getReceiverStatus = async function(req, res) {
  try {
    res.json({
      success: true,
      status: emailReceiverService.getStatus()
    });
  } catch (error) {
    console.error("Error getting receiver status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get receiver status"
    });
  }
};

// Manual check for new emails
exports.manualCheckEmails = async function(req, res) {
  try {
    const result = await emailReceiverService.manualCheck();
    
    if (result) {
      res.json({
        success: true,
        message: "Manual email check completed"
      });
    } else {
      res.status(400).json({
        success: false,
        error: "Email receiver not connected"
      });
    }
  } catch (error) {
    console.error("Error in manual check:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check emails"
    });
  }
};

// Get emails for a specific client
exports.getClientEmails = async function(req, res) {
  try {
    const { clientId } = req.params;
    const { limit = 50, page = 1 } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const query = {
      client: clientId,
      source: "email"
    };

    const [emails, total] = await Promise.all([
      AssignmentMessage.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName legalBusinessName dba" }
        ])
        .lean(),
      AssignmentMessage.countDocuments(query)
    ]);

    res.json({
      success: true,
      items: emails,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim
    });

  } catch (error) {
    console.error("Error getting client emails:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch client emails"
    });
  }
};

// Forward email to internal team (manual trigger)
exports.forwardEmailToTeam = async function(req, res) {
  try {
    const { messageId, additionalReceivers = [], note } = req.body;
    
    const message = await AssignmentMessage.findById(messageId);
    
    if (!message || message.source !== "email") {
      return res.status(404).json({
        success: false,
        error: "Email message not found"
      });
    }

    // Add additional receivers
    const allReceivers = [...message.receiver, ...additionalReceivers];
    const uniqueReceivers = [...new Set(allReceivers.map(r => r.toString()))];

    // Update message with new receivers
    message.receiver = uniqueReceivers;
    if (note) {
      message.note += `\n\n[Forward Note]: ${note}`;
    }
    message.updatedAt = new Date();
    
    await message.save();

    // Populate and emit update
    const populated = await AssignmentMessage.findById(message._id)
      .populate([
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" }
      ]);

    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      uniqueReceivers.forEach(receiverId => {
        io.to(`employee_${receiverId}`).emit("email_forwarded", {
          message: populated,
          forwardedBy: req.employee._id,
          timestamp: new Date()
        });
      });
    }

    res.json({
      success: true,
      message: "Email forwarded to team",
      data: populated,
      receiversAdded: additionalReceivers.length
    });

  } catch (error) {
    console.error("Error forwarding email:", error);
    res.status(500).json({
      success: false,
      error: "Failed to forward email"
    });
  }
};