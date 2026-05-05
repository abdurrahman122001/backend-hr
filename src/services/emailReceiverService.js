// services/emailReceiverService.js - UPDATED: Client as Sender with Team Leads and Thread ID Fix
const Imap = require("node-imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const AssignmentMessage = require("../models/AssignmentMessage");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");

class EmailReceiverService {
  constructor() {
    this.imap = null;
    this.transporter = null;
    this.isConnected = false;
    this.io = null;
    this.checkInterval = parseInt(process.env.IMAP_CHECK_INTERVAL) || 30000;
    this.pollingInterval = null;
    this.isProcessing = false;
    this.processedMessageIds = new Set();
  }

  initialize(io) {
    this.io = io;
  }

  connect() {
    try {
      console.log('🔗 [EmailReceiver] Connecting to IMAP server...');
      console.log('📧 [EmailReceiver] IMAP Config:', {
        host: process.env.IMAP_HOST || 'imap.titan.email',
        user: process.env.IMAP_USER || process.env.MAIL_USERNAME,
        port: parseInt(process.env.IMAP_PORT) || 993
      });

      this.imap = new Imap({
        user: process.env.IMAP_USER || process.env.MAIL_USERNAME,
        password: process.env.IMAP_PASSWORD || process.env.MAIL_PASSWORD,
        host: process.env.IMAP_HOST || "imap.titan.email",
        port: parseInt(process.env.IMAP_PORT) || 993,
        tls: true,
        tlsOptions: {
          rejectUnauthorized: false,
          servername: process.env.IMAP_HOST || "imap.titan.email",
        },
        authTimeout: 30000,
        connTimeout: 60000,
        keepalive: {
          interval: 10000,
          idleInterval: 30000,
          forceNoop: true,
        },
      });

      this.imap.once("ready", () => {
        console.log('✅ [EmailReceiver] IMAP Connected successfully');
        this.isConnected = true;
        this.openInbox();
      });

      this.imap.once("error", (err) => {
        console.error(
          "❌ [EmailReceiver] IMAP Connection error:",
          err.message || err
        );
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.imap.once("end", () => {
        console.log('🔌 [EmailReceiver] IMAP Connection ended');
        this.isConnected = false;
        this.scheduleReconnect();
      });

      // Connect timeout
      setTimeout(() => {
        if (
          !this.isConnected &&
          this.imap &&
          this.imap.state !== "authenticated"
        ) {
          console.log('⏰ [EmailReceiver] IMAP connection timeout');
          this.disconnect();
          this.scheduleReconnect();
        }
      }, 60000);

      this.imap.connect();
    } catch (error) {
      console.error("❌ [EmailReceiver] Error in IMAP setup:", error);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    setTimeout(() => {
      console.log('🔄 [EmailReceiver] Attempting to reconnect...');
      this.connect();
    }, 10000);
  }

  openInbox() {
    this.imap.openBox("INBOX", true, (err, box) => {
      if (err) {
        console.error("❌ [EmailReceiver] Error opening inbox:", err);
        this.disconnect();
        this.scheduleReconnect();
        return;
      }

      console.log(`📥 [EmailReceiver] Inbox opened with ${box.messages.total} messages`);
      this.startListening();
    });
  }

  startListening() {
    this.imap.on("mail", (numNewMsgs) => {
      console.log(`📨 [EmailReceiver] New email(s) arrived: ${numNewMsgs}`);
      if (!this.isProcessing) {
        this.processNewEmails();
      }
    });
  }

  async processNewEmails() {
    if (this.isProcessing) {
      console.log('⏳ [EmailReceiver] Already processing, skipping');
      return;
    }

    this.isProcessing = true;
    try {
      console.log('🔄 [EmailReceiver] Processing new emails...');

      await new Promise((resolve, reject) => {
        this.imap.search(["UNSEEN"], (err, results) => {
          if (err) {
            console.error(
              "❌ [EmailReceiver] Error searching new emails:",
              err
            );
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            console.log('📭 [EmailReceiver] No new unseen emails');
            resolve();
            return;
          }

          console.log(`📨 [EmailReceiver] Found ${results.length} new unseen email(s)`);
          const recentEmails = results.slice(-10);
          console.log(`📨 [EmailReceiver] Processing ${recentEmails.length} most recent email(s)`);

          this.processEmailBatch(recentEmails, resolve, reject);
        });
      });
    } catch (error) {
      console.error("❌ [EmailReceiver] Error in processNewEmails:", error);
    } finally {
      this.isProcessing = false;
    }
  }

  async checkForNewEmails() {
    if (this.isProcessing) {
      console.log('⏳ [EmailReceiver] Already processing, skipping check');
      return;
    }

    if (!this.isConnected || !this.imap) {
      console.log('⚠️ [EmailReceiver] IMAP not connected');
      return;
    }

    this.isProcessing = true;
    try {
      console.log('🔍 [EmailReceiver] Checking for new emails...');

      await new Promise((resolve, reject) => {
        this.imap.search(["UNSEEN"], (err, results) => {
          if (err) {
            console.error(
              "❌ [EmailReceiver] Error searching new emails:",
              err
            );
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            console.log('📭 [EmailReceiver] No new unseen emails');
            resolve();
            return;
          }

          console.log(`📨 [EmailReceiver] Found ${results.length} new unseen email(s)`);
          this.processEmailBatch(results, resolve, reject);
        });
      });
    } catch (error) {
      console.error("❌ [EmailReceiver] Error in checkForNewEmails:", error);
    } finally {
      this.isProcessing = false;
    }
  }

  // Add this method for backward compatibility
  async fetchNewEmails() {
    return this.checkForNewEmails();
  }

  processEmailBatch(results, resolve, reject) {
    if (results.length === 0) {
      resolve();
      return;
    }

    console.log(`📤 [EmailReceiver] Fetching ${results.length} email(s)...`);

    const f = this.imap.fetch(results, {
      bodies: "",
      struct: true,
      markSeen: true,
    });

    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    f.on("message", (msg, seqno) => {
      const uid = results[seqno - 1];
      console.log(`📩 [EmailReceiver] Processing message #${seqno} (UID: ${uid})`);

      let emailBuffer = "";

      msg.on("body", (stream) => {
        stream.on("data", (chunk) => {
          emailBuffer += chunk.toString("utf8");
        });
      });

      msg.once("end", async () => {
        try {
          const parsed = await simpleParser(emailBuffer);
          const shouldProcess = await this.processEmail(parsed, uid);

          if (shouldProcess === "skipped") {
            skippedCount++;
          } else if (shouldProcess === "processed") {
            processedCount++;
          } else {
            errorCount++;
          }
        } catch (parseErr) {
          console.error(
            `❌ [EmailReceiver] Error parsing email UID ${uid}:`,
            parseErr
          );
          errorCount++;
        }

        const totalProcessed = processedCount + errorCount + skippedCount;
        if (totalProcessed === results.length) {
          console.log(`✅ [EmailReceiver] Batch processing complete: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors`);
          resolve();
        }
      });
    });

    f.once("error", (fetchErr) => {
      console.error("❌ [EmailReceiver] Error fetching emails:", fetchErr);
      reject(fetchErr);
    });
  }

  async processEmail(email, uid) {
    try {
      const fromEmail = email.from?.value[0]?.address || email.from?.text || "";
      const fromName = email.from?.value[0]?.name || "";

      console.log(`📧 [EmailReceiver] Processing email UID ${uid} from: ${fromName} <${fromEmail}>`);

      const emailDetails = {
        uid: uid,
        from: fromEmail,
        fromName: fromName,
        to: email.to?.value[0]?.address || email.to?.text || "",
        toName: email.to?.value[0]?.name || "",
        subject: email.subject || "(No Subject)",
        text: email.text || "",
        html: email.html || email.text || "",
        date: email.date || new Date(),
        messageId: email.messageId || "",
        inReplyTo: email.inReplyTo || email.headers.get('in-reply-to') || null,
        references: email.references || email.headers.get('references') || null,
        cc: email.cc ? email.cc.value.map((cc) => cc.address) : [],
        bcc: email.bcc ? email.bcc.value.map((bcc) => bcc.address) : [],
        attachments: email.attachments || [],
        headers: email.headers || {},
      };

      console.log('📧 [EmailReceiver] Email details:', {
        from: emailDetails.from,
        to: emailDetails.to,
        subject: emailDetails.subject.substring(0, 50),
        date: emailDetails.date,
        inReplyTo: emailDetails.inReplyTo?.substring(0, 50) || 'None',
        references: emailDetails.references?.substring(0, 50) || 'None'
      });

      if (this.processedMessageIds.has(emailDetails.messageId)) {
        console.log(`⏭️ [EmailReceiver] Email already processed in this session`);
        return "skipped";
      }

      if (this.isFromOurDomain(emailDetails.from)) {
        console.log(`⏭️ [EmailReceiver] Skipping email from our own domain`);
        this.processedMessageIds.add(emailDetails.messageId);
        return "skipped";
      }

      if (this.isAutoGenerated(emailDetails)) {
        console.log(`⏭️ [EmailReceiver] Skipping auto-generated email`);
        this.processedMessageIds.add(emailDetails.messageId);
        return "skipped";
      }

      const existingMessage = await AssignmentMessage.findOne({
        "emailMetadata.messageId": emailDetails.messageId,
      });

      if (existingMessage) {
        console.log(`⏭️ [EmailReceiver] Email already processed in database`);
        this.processedMessageIds.add(emailDetails.messageId);
        return "skipped";
      }

      // STEP 1: Find client by email (this is the sender)
      const clientMatch = await this.findClientByEmail(emailDetails.from);

      if (!clientMatch) {
        console.log(`❌ [EmailReceiver] No client found for sender email: ${emailDetails.from}`);
        this.processedMessageIds.add(emailDetails.messageId);
        return "skipped";
      }

      const { client, clientEmployee } = clientMatch;

      // STEP 2: Get assigned employee (this is the receiver)
      const assignedEmployee = await this.getAssignedEmployee(client);

      if (!assignedEmployee) {
        console.log(`❌ [EmailReceiver] No assigned employee found for client: ${client.clientName}`);
        this.processedMessageIds.add(emailDetails.messageId);
        return "skipped";
      }

      // STEP 3: Get team leads for this owner
      const teamLeads = await this.getTeamLeadsForOwner(client.owner);

      // STEP 4: Check if this is a reply to an existing thread
      let threadId = null;
      let replyToMessage = null;

      // Try to find the original message this is replying to
      if (emailDetails.inReplyTo) {
        console.log(`🔍 [EmailReceiver] Checking for reply to message: ${emailDetails.inReplyTo}`);

        // Try to find by message ID in emailMetadata
        replyToMessage = await AssignmentMessage.findOne({
          "emailMetadata.messageId": emailDetails.inReplyTo
        });

        if (replyToMessage) {
          console.log(`✅ [EmailReceiver] Found original message for reply: ${replyToMessage._id}`);
          threadId = replyToMessage.threadId;
        } else if (emailDetails.references) {
          // Try to find by references (thread of messages)
          const referenceIds = emailDetails.references.split(/\s+/);
          for (const refId of referenceIds) {
            const refMessage = await AssignmentMessage.findOne({
              "emailMetadata.messageId": refId
            });
            if (refMessage) {
              console.log(`✅ [EmailReceiver] Found reference message: ${refMessage._id}`);
              threadId = refMessage.threadId;
              replyToMessage = refMessage;
              break;
            }
          }
        }
      }

      // If no thread found by reply headers, try to find by subject and client
      if (!threadId) {
        // Clean the subject to remove reply prefixes
        const cleanSubject = this.cleanEmailSubject(emailDetails.subject);
        console.log(`🔍 [EmailReceiver] Searching for thread with subject: ${cleanSubject} for client: ${client.clientName}`);

        // Look for existing threads from this client with similar subject
        const existingThreads = await AssignmentMessage.find({
          client: client._id,
          sender: client._id, // Client as sender
          subject: { $regex: new RegExp(cleanSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
        })
          .sort({ createdAt: -1 })
          .limit(1);

        if (existingThreads.length > 0) {
          threadId = existingThreads[0].threadId;
          replyToMessage = existingThreads[0];
          console.log(`✅ [EmailReceiver] Found existing thread: ${threadId}`);
        }
      }

      // STEP 5: Create assignment message with client as sender and include team leads
      const assignmentMessage = await this.createAssignmentMessage(
        emailDetails,
        client,
        assignedEmployee,
        clientEmployee,
        teamLeads,
        threadId,
        replyToMessage?._id
      );

      if (assignmentMessage) {
        this.processedMessageIds.add(emailDetails.messageId);

        // Send auto-reply if needed (commented out for now)
        // this.sendAutoReply(emailDetails, client, true).catch(err => {
        //   console.error(`❌ [EmailReceiver] Auto-reply failed:`, err.message);
        // });

        console.log(`✅ [EmailReceiver] Email processed successfully for client: ${client.clientName}`);
        return "processed";
      }

      return "skipped";
    } catch (error) {
      console.error(
        `❌ [EmailReceiver] Error processing email UID ${uid}:`,
        error
      );
      return "error";
    }
  }

  cleanEmailSubject(subject) {
    if (!subject) return "";

    // Remove common reply prefixes
    const cleanSubject = subject
      .replace(/^(Re:|Fwd:|FW:|RE:|fwd:|fw:)\s*/i, '') // Remove reply/forward prefixes
      .replace(/\[.*?\]\s*/g, '') // Remove brackets content
      .trim();

    return cleanSubject;
  }

  isFromOurDomain(email) {
    if (!email) return false;
    const ourDomains = ["virsme.com", "mavensadvisor.com", "mavensadvisor.co"];
    return ourDomains.some((domain) => email.toLowerCase().includes(domain));
  }

  isAutoGenerated(emailDetails) {
    if (!emailDetails.headers) return false;

    const autoHeaders = [
      "auto-submitted",
      "x-auto-response-suppress",
      "x-autoreply",
    ];
    for (const header of autoHeaders) {
      if (emailDetails.headers[header]) {
        const value = emailDetails.headers[header].toLowerCase();
        if (
          value.includes("auto") ||
          value.includes("vacation") ||
          value.includes("out-of-office")
        ) {
          return true;
        }
      }
    }

    const subject = (emailDetails.subject || "").toLowerCase();
    const autoSubjects = [
      "auto:",
      "automatic reply",
      "out of office",
      "away from office",
      "vacation",
      "delivery status",
      "undeliverable",
      "delivery failure",
      "failure notice",
    ];
    for (const autoSubject of autoSubjects) {
      if (subject.includes(autoSubject)) {
        return true;
      }
    }

    return false;
  }

  async findClientByEmail(email) {
    try {
      if (!email) {
        console.log('❌ [EmailReceiver] No email provided');
        return null;
      }

      const emailAddress = email.toLowerCase().trim();
      console.log(`🔍 [EmailReceiver] Looking for client with email: ${emailAddress}`);

      // First check by client's main email
      const clientByEmail = await ClientInfo.findOne({
        clientEmail: emailAddress,
      })
        .populate("owner assignedTo")
        .select(
          "_id owner clientName clientEmail assignedTo companyEmployees supervision"
        );

      if (clientByEmail) {
        console.log(`✅ [EmailReceiver] Found client by main email: ${clientByEmail.clientName}`);
        return {
          client: clientByEmail,
          clientEmployee: {
            name: clientByEmail.clientName,
            email: clientByEmail.clientEmail,
            isPrimaryContact: true,
            clientId: clientByEmail._id,
          },
        };
      }

      // Then check by company employees
      const clientWithEmployee = await ClientInfo.findOne({
        "companyEmployees.email": emailAddress,
      })
        .populate("owner assignedTo")
        .select(
          "_id owner clientName clientEmail assignedTo companyEmployees supervision"
        );

      if (clientWithEmployee) {
        const employee = clientWithEmployee.companyEmployees.find(
          (emp) => emp.email && emp.email.toLowerCase() === emailAddress
        );

        if (employee) {
          console.log(`✅ [EmailReceiver] Found client by company employee: ${clientWithEmployee.clientName}`);
          return {
            client: clientWithEmployee,
            clientEmployee: {
              name: employee.name,
              email: employee.email,
              designation: employee.designation,
              department: employee.department,
              isPrimaryContact: employee.isPrimaryContact || false,
              clientId: clientWithEmployee._id,
            },
          };
        }
      }

      console.log(`❌ [EmailReceiver] No client found for email: ${emailAddress}`);
      return null;
    } catch (error) {
      console.error("❌ [EmailReceiver] Error finding client by email:", error);
      return null;
    }
  }

  async getAssignedEmployee(clientInfo) {
    try {
      // First try to get the specifically assigned employee
      if (clientInfo.assignedTo) {
        const assignedEmployee = await Employee.findById(
          clientInfo.assignedTo
        ).select("_id name companyEmail role owner");

        if (assignedEmployee) {
          console.log(`👤 [EmailReceiver] Found assigned employee: ${assignedEmployee.name}`);
          return assignedEmployee;
        }
      }

      // If no assigned employee, get the owner as fallback
      if (clientInfo.owner) {
        const ownerEmployee = await Employee.findOne({
          owner: clientInfo.owner,
        }).select("_id name companyEmail role owner");

        if (ownerEmployee) {
          console.log(`👤 [EmailReceiver] Using owner as assigned employee: ${ownerEmployee.name}`);
          return ownerEmployee;
        }
      }

      console.log('❌ [EmailReceiver] No employee found to assign the message to');
      return null;
    } catch (error) {
      console.error(
        "❌ [EmailReceiver] Error getting assigned employee:",
        error
      );
      return null;
    }
  }

  async getTeamLeadsForOwner(ownerId) {
    try {
      if (!ownerId) {
        console.log('❌ [EmailReceiver] No owner ID provided for team leads search');
        return [];
      }

      console.log(`🔍 [EmailReceiver] Looking for team leads for owner: ${ownerId}`);

      // Find all team leads for this owner
      const teamLeads = await Employee.find({
        owner: ownerId,
        role: { $in: ["Team Lead", "team_lead", "team lead"] }
      }).select("_id name companyEmail role");

      console.log(`👥 [EmailReceiver] Found ${teamLeads.length} team lead(s) for owner`);

      if (teamLeads.length > 0) {
        teamLeads.forEach(tl => {
          console.log(`   - ${tl.name} (${tl.role})`);
        });
      }

      return teamLeads;
    } catch (error) {
      console.error("❌ [EmailReceiver] Error getting team leads:", error);
      return [];
    }
  }

  async createAssignmentMessage(
    emailDetails,
    client,
    assignedEmployee,
    clientEmployee,
    teamLeads = [],
    existingThreadId = null,
    replyToMessageId = null
  ) {
    try {
      let threadId = existingThreadId;

      // Generate thread ID if not provided
      if (!threadId) {
        threadId = this.generateThreadId(client, emailDetails.subject);
        console.log(`🆕 [EmailReceiver] Created new thread ID: ${threadId}`);
      } else {
        console.log(`🔗 [EmailReceiver] Using existing thread ID: ${threadId}`);
      }

      // Prepare receiver list: assigned employee + team leads
      let receivers = [assignedEmployee._id];

      // Add team leads to receivers if any exist
      if (teamLeads && teamLeads.length > 0) {
        const teamLeadIds = teamLeads.map(tl => tl._id);
        receivers = [...receivers, ...teamLeadIds];
        console.log(`👥 [EmailReceiver] Added ${teamLeads.length} team lead(s) to receivers`);
      }

      // Add internal employees from CC to receivers
      if (emailDetails.cc && emailDetails.cc.length > 0) {
        try {
          const ccEmails = emailDetails.cc.map(email => email.toLowerCase().trim());
          const matchingEmployees = await Employee.find({
            owner: client.owner,
            $or: [
              { email: { $in: ccEmails } },
              { companyEmail: { $in: ccEmails } }
            ],
            status: { $ne: "offboarded" }
          }).select("_id");

          if (matchingEmployees.length > 0) {
            matchingEmployees.forEach(emp => {
              const empId = emp._id.toString();
              if (!receivers.includes(empId)) {
                receivers.push(empId);
              }
            });
          }
        } catch (err) {
          console.error("❌ [EmailReceiver] Error matching CC employees:", err);
        }
      }

      // Remove duplicates and convert to ObjectId
      receivers = [...new Set(receivers.map(id => id.toString()))]
        .map(id => new mongoose.Types.ObjectId(id));

      // Create message data with client as sender
      const messageData = {
        owner: client.owner,
        threadId: threadId,

        // Client is the sender (using client ID as sender)
        sender: client._id, // Changed from employee._id to client._id
        senderType: "client", // Add sender type to differentiate

        // Employee and team leads are the receivers
        receiver: receivers,

        subject: emailDetails.subject || "Email from Client",
        note: emailDetails.html || emailDetails.text || "",
        approvalStatus: null,
        isScheduled: false,
        starred: false,
        starredBy: [],
        scheduledAt: null,
        scheduledBy: null,
        sentAt: new Date(),
        status: "sent",
        isTrashed: false,
        isSpam: false,
        spamReportCount: 0,
        spamReporters: [],
        replyTo: replyToMessageId || null,
        isHrPolicy: false,
        isSystemMessage: false,
        readBy: [],
        attachments: [],

        // Client information
        client: client._id,
        isFromClient: true,
        isFromCompanyEmployee:
          !!clientEmployee && !clientEmployee.isPrimaryContact,
        clientEmployeeName: clientEmployee?.name || client.clientName,
        clientEmployeeEmail: clientEmployee?.email || client.clientEmail,
        clientName: client.clientName,

        source: "email",
        emailMetadata: {
          messageId: emailDetails.messageId,
          from: emailDetails.from,
          fromName: emailDetails.fromName,
          to: emailDetails.to,
          date: emailDetails.date,
          cc: emailDetails.cc,
          bcc: emailDetails.bcc,
          headers: emailDetails.headers || {},
          inReplyTo: emailDetails.inReplyTo || null,
          references: emailDetails.references || null,
        },
      };

      // Handle CC recipients if any
      if (emailDetails.cc && emailDetails.cc.length > 0) {
        messageData.cc = emailDetails.cc.map((ccEmail) => ({
          email: ccEmail.trim().toLowerCase(),
          name: ccEmail.split("@")[0],
          addedAt: new Date(),
        }));
      }

      // Process attachments if any
      if (emailDetails.attachments && emailDetails.attachments.length > 0) {
        console.log(`📎 [EmailReceiver] Processing ${emailDetails.attachments.length} attachment(s)`);

        messageData.attachments = await Promise.all(
          emailDetails.attachments.map(async (attachment) => {
            try {
              const content = attachment.content || Buffer.from("");
              return {
                filename: attachment.filename || "attachment",
                originalName: attachment.filename || "attachment",
                mimetype: attachment.contentType || "application/octet-stream",
                size: attachment.size || content.length,
                url: `data:${attachment.contentType};base64,${content.toString(
                  "base64"
                )}`,
                uploadedAt: new Date(),
                uploadedBy: assignedEmployee._id,
              };
            } catch (err) {
              console.error(
                "❌ [EmailReceiver] Error processing attachment:",
                err
              );
              return null;
            }
          })
        );

        messageData.attachments = messageData.attachments.filter(
          (att) => att !== null
        );
      }

      // Create the message in database
      const message = await AssignmentMessage.create(messageData);

      console.log(`✅ [EmailReceiver] Created assignment message: ${message._id}`);
      console.log('📝 [EmailReceiver] Message details:', {
        sender: `Client: ${client.clientName}`,
        receivers: `Total: ${receivers.length} (Employee: ${assignedEmployee.name}, Team Leads: ${teamLeads.length})`,
        subject: message.subject,
        threadId: message.threadId,
        isReply: !!replyToMessageId,
        hasAttachments: message.attachments.length
      });

      // Populate the message with client and employee details
      const populated = await AssignmentMessage.findById(message._id).populate([
        { path: "sender", select: "_id clientName clientEmail" }, // Now populating client
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName clientEmail" },
        { path: "replyTo", select: "_id subject sender receiver" },
      ]);

      // 🔥 UPDATED: Send real-time notification using the exact same event as createMessage
      if (this.io) {
        // Prepare the emission data matching what createMessage sends
        const emissionData = {
          type: "email",
          message: populated,
          client: client.clientName,
          sender: client.clientName,
          senderType: "client",
          isReply: !!replyToMessageId,
          threadId: threadId,
          timestamp: new Date(),
          // Add additional fields to match createMessage
          isClientEmail: true,
          isFromClient: true,
          clientEmail: client.clientEmail,
          source: "email",
          emailMetadata: messageData.emailMetadata
        };

        // Emit to specific receivers only (matching your controller's pattern)
        await this.emitToSpecificReceivers(populated, emissionData);

        console.log(`📢 [EmailReceiver] Real-time notifications sent to ${receivers.length} receiver(s)`);
      }

      return populated;
    } catch (error) {
      console.error(
        "❌ [EmailReceiver] Error creating assignment message:",
        error
      );
      throw error;
    }
  }

  // 🔥 FIXED: Emit to specific receivers — emit populated message DIRECTLY
  // (matching assignmentMessageController.js pattern, not wrapped in emissionData)
  async emitToSpecificReceivers(message, emissionData) {
    try {
      if (!this.io) return;

      // Get actual recipients
      const actualRecipients = new Set();

      // Add sender
      const senderId = String(
        typeof message.sender === "string"
          ? message.sender
          : message.sender?._id
      );
      if (senderId && senderId !== "undefined") {
        actualRecipients.add(senderId);
      }

      // Add receivers from this specific message
      if (Array.isArray(message.receiver)) {
        message.receiver.forEach((receiver) => {
          const receiverId = String(
            typeof receiver === "string" ? receiver : receiver?._id
          );
          if (receiverId && receiverId !== "undefined") {
            actualRecipients.add(receiverId);
          }
        });
      }

      // 🔥 CRITICAL FIX: Emit the populated message DIRECTLY (not wrapped)
      // This matches what assignmentMessageController.js does at line 510:
      //   io.to(`employee_${recipientId}`).emit(eventName, populatedMessage);
      actualRecipients.forEach((recipientId) => {
        if (recipientId) {
          this.io.to(`employee_${recipientId}`).emit("new_assignment_message", message);
        }
      });
    } catch (error) {
      console.error("❌ [EmailReceiver] Error in emitToSpecificReceivers:", error);
      throw error;
    }
  }

  generateThreadId(client, subject) {
    const clientId = client._id.toString();
    // Clean the subject for thread ID
    const cleanSubject = this.cleanEmailSubject(subject);
    const normalizedSubject = (cleanSubject || "email")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .substring(0, 30);

    const timestamp = Date.now();
    return `client_${clientId}_${normalizedSubject}_${timestamp}`;
  }

  async manualCheck() {
    if (!this.isConnected) {
      console.log('❌ [EmailReceiver] IMAP not connected, attempting to connect...');
      this.connect();
      return false;
    }

    console.log('🔄 [EmailReceiver] Manually checking for new emails...');
    await this.checkForNewEmails();
    return true;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isProcessing: this.isProcessing,
      lastCheck: new Date(),
      processedCount: this.processedMessageIds.size
    };
  }

  disconnect() {
    if (this.imap) {
      this.imap.end();
      this.isConnected = false;
      console.log('🔌 [EmailReceiver] IMAP disconnected');
    }
  }

  // 🔥 NEW: Method to send auto-reply to client (if needed)
  async sendAutoReply(emailDetails, client, isReply = false) {
    try {
      // Only send auto-reply for new conversations, not replies
      if (isReply) return;

      // Configure nodemailer transporter
      if (!this.transporter) {
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.titan.email",
          port: process.env.SMTP_PORT || 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER || process.env.MAIL_USERNAME,
            pass: process.env.SMTP_PASS || process.env.MAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false,
          },
        });
      }

      const mailOptions = {
        from: process.env.SMTP_FROM || process.env.MAIL_USERNAME,
        to: emailDetails.from,
        subject: `Re: ${emailDetails.subject}`,
        text: `Thank you for your email. Your message has been received and assigned to our team. We'll get back to you soon.\n\nBest regards,\n${client.clientName} Support Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Thank you for your email</h2>
            <p>Your message has been received and assigned to our team. We'll get back to you soon.</p>
            <p>Best regards,<br>${client.clientName} Support Team</p>
          </div>
        `,
        inReplyTo: emailDetails.messageId,
        references: emailDetails.messageId,
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ [EmailReceiver] Auto-reply sent: ${info.messageId}`);

      return info;
    } catch (error) {
      console.error("❌ [EmailReceiver] Error sending auto-reply:", error);
      throw error;
    }
  }
}

module.exports = new EmailReceiverService();