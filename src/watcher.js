require("dotenv").config();

const Imap = require("imap");
const { simpleParser } = require("mailparser");
const mongoose = require("mongoose");
const verifyEmail = require("./utils/verifyEmail");

const { sendEmail } = require("./services/mailService");
const Employee = require("./models/Employees");
const {
  generateAndSaveNda,
  generateAndSaveContract,
  generateAndSaveSalaryCertificate,
} = require("./services/ndaService");
const { extractCNICUsingOpenAI } = require("./services/deepseekService");
const Signature = require("./models/Signature");
const User = require("./models/Users");

// IMAP Config
const imap = new Imap(require("./config/imapConfig"));

// Company Info
const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "hr@mavensadvisors.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+92 312 3850846";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";
const DEFAULT_OWNER_ID =
  process.env.DEFAULT_OWNER_ID || "6838b0b708e8629ffab534ee";

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// Track processed emails
const processedEmails = new Map();
const EMAIL_PROCESS_TTL = 24 * 60 * 60 * 1000;
const MAX_PROCESSED_EMAILS = 10000;

// Rate limiting
const emailRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const MAX_EMAILS_PER_HOUR = 50;

// Ignored senders to prevent loops
const IGNORED_SENDERS = [
  COMPANY_EMAIL.toLowerCase(),
  'noreply@',
  'no-reply@',
  'mailer-daemon@',
  'postmaster@'
];

// Cleanup function
function cleanupOldEntries() {
  const now = Date.now();
  
  // Clean processed emails
  if (processedEmails.size > MAX_PROCESSED_EMAILS) {
    const entries = Array.from(processedEmails.entries());
    entries.sort((a, b) => a[1] - b[1]);
    const toRemove = Math.floor(entries.length / 2);
    for (let i = 0; i < toRemove; i++) {
      processedEmails.delete(entries[i][0]);
    }
  }
  
  for (const [key, timestamp] of processedEmails.entries()) {
    if (now - timestamp > EMAIL_PROCESS_TTL) {
      processedEmails.delete(key);
    }
  }
  
  // Clean rate limit
  for (const [key, data] of emailRateLimit.entries()) {
    if (now - data.timestamp > RATE_LIMIT_WINDOW * 2) {
      emailRateLimit.delete(key);
    }
  }
}

setInterval(cleanupOldEntries, 30 * 60 * 1000);

// Parse stream helper
function parseStream(input) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(input)) {
      const { Readable } = require('stream');
      const stream = Readable.from(input);
      simpleParser(stream, (err, parsed) => {
        if (err) reject(err);
        else resolve(parsed);
      });
    } else {
      simpleParser(input, (err, parsed) => {
        if (err) reject(err);
        else resolve(parsed);
      });
    }
  });
}

// Email classification with error handling
function classifyEmail(text) {
  try {
    if (!text || typeof text !== 'string') return "hr_related";
    const cleaned = text.toLowerCase().replace(/[\n\r]+/g, " ").trim();
    if (!cleaned) return "hr_related";
    
    // Check for rejection
    const rejectionPatterns = [
      /\b(reject|decline|regret)\b/,
      /\b(not accept|cannot accept|can't accept|won't accept|do not accept)\b/,
      /\b(sorry.*(cannot|can't|won't|not able))\b/,
      /\b(unfortunately.*(decline|not able|cannot|can't|won't))\b/,
      /\b(not interested|withdraw|not accepted|no longer|not joining)\b/,
      /\b(will not be able to join|don't want|do not want)\b/
    ];
    
    for (const pattern of rejectionPatterns) {
      if (pattern.test(cleaned)) {
        return "offer_rejection";
      }
    }
    
    // Check for acceptance
    if (
      /\b(accepted|accept|acceptance|i will join|happy to join|excited to join|looking forward to join|thank you for the offer)\b/.test(cleaned) &&
      !/\b(not accept|cannot accept|can't accept|won't accept|don't accept|not going to accept|do not accept)\b/.test(cleaned) &&
      !/\b(reject|decline|regret)\b/.test(cleaned)
    ) {
      return "offer_acceptance";
    }
    
    if (/\bapprove|approved|reject|rejected\b/.test(cleaned)) {
      return "approval_response";
    }
    
    if (
      /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/.test(cleaned) ||
      /\b(today|tomorrow|leave|vacation|holiday|day off|sick|absent)\b/.test(cleaned)
    ) {
      return "leave_request";
    }
    
    return "hr_related";
  } catch (error) {
    console.error("Email classification error:", error);
    return "hr_related";
  }
}

// Get signature block
async function getSignatureBlock(ownerId) {
  try {
    const signature = await Signature.findOne({ owner: ownerId });
    if (!signature) return "";

    return `
      <div style="margin-top:32px;margin-bottom:12px;">
        ${
          signature.signatureImage
            ? `<img src="${process.env.SERVER_URL || ""}${
                signature.signatureImage
              }" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
            : ""
        }
        <div style="text-align:left;">
          ${signature.signatureText || ""}
        </div>
      </div>
    `;
  } catch (error) {
    console.error("Error getting signature block:", error);
    return "";
  }
}

// Validate owner ID
async function validateOwnerId(ownerId) {
  try {
    const owner = await User.findById(ownerId);
    return owner ? ownerId : DEFAULT_OWNER_ID;
  } catch (error) {
    console.error("Error validating owner:", error);
    return DEFAULT_OWNER_ID;
  }
}

// Safe email sender
async function sendSafeEmail({ to, subject, html, ownerId, type = 'general' }) {
  try {
    // Rate limiting
    const rateKey = `${to}_${type}`;
    const rateData = emailRateLimit.get(rateKey);
    if (rateData) {
      const timeDiff = Date.now() - rateData.timestamp;
      if (timeDiff < RATE_LIMIT_WINDOW && rateData.count >= MAX_EMAILS_PER_HOUR) {
        console.warn(`⚠️ Rate limit exceeded for ${to} (${type})`);
        return { success: false, reason: 'rate_limit' };
      }
      if (timeDiff > RATE_LIMIT_WINDOW) {
        emailRateLimit.set(rateKey, { count: 1, timestamp: Date.now() });
      } else {
        rateData.count += 1;
        emailRateLimit.set(rateKey, rateData);
      }
    } else {
      emailRateLimit.set(rateKey, { count: 1, timestamp: Date.now() });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      console.warn(`❌ Invalid email format: ${to}`);
      return { success: false, reason: 'invalid_format' };
    }

    // Skip ignored domains
    const bounceDomains = ['mailinator.com', 'tempmail.com', 'guerrillamail.com'];
    const domain = to.split('@')[1].toLowerCase();
    if (bounceDomains.includes(domain)) {
      console.warn(`⚠️ Skipping disposable email: ${to}`);
      return { success: false, reason: 'disposable_email' };
    }

    // Don't send to our own domain
    if (to.includes(process.env.COMPANY_EMAIL_DOMAIN || 'mavensadvisors.com')) {
      console.log(`ℹ️ Skipping internal email: ${to}`);
      return { success: false, reason: 'internal_email' };
    }

    console.log(`📧 Sending email to ${to} (${type})`);
    await sendEmail({ to, subject, html });
    
    console.log(`✅ Email sent successfully to ${to}`);
    return { success: true };
    
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, reason: error.message };
  }
}

// Send profile link
async function sendCompleteProfileLink(id, to, employeeName, companyName, ownerId) {
  const link = `${process.env.FRONTEND_BASE_URL}/complete-profile/${id}`;
  const subject = "🙌 Thank You! Help Me Finalize Your Profile 🚀";
  const signatureBlock = await getSignatureBlock(ownerId);

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
      <p>Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p>Thank you so much for sharing your CNIC and CV earlier your cooperation means the world to me! 💙</p>
      <p>As your HR AI Agent, I've been busy building a smarter, more connected system to support you better. 
      From payroll to perks, records to recognition it all starts with having the right information in the right place.</p>
      <p>To complete your employee profile and keep our records up to date, I kindly request you to take a moment to fill out a short form:</p>
      <p>
        📝 <strong>
          <a href="${link}" style="color: #0057b7; text-decoration: underline;">
            Click here to complete your profile
          </a>
        </strong>
      </p>
      <p>This will help me ensure:</p>
      <ul style="margin:0 0 1em 2em;padding:0;">
        <li style="margin-bottom:4px;">✅ Your salary info is processed correctly</li>
        <li style="margin-bottom:4px;">✅ Your benefits and contact details are accurate</li>
        <li style="margin-bottom:4px;">✅ You're ready for future updates, promotions, and recognitions 🎉</li>
      </ul>
      <p>It'll only take a few minutes and as always, your data will be handled with strict confidentiality and care.</p>
      <p>Let's make our workplace even more organized, connected, and ready for what's next. Thank you again for being such an important part of the <strong>${companyName}</strong> family. I'm here to make things smoother for you now and always.</p>
      ${signatureBlock}
    </div>
  `;
  
  return await sendSafeEmail({ 
    to, 
    subject, 
    html, 
    ownerId, 
    type: 'profile_completion' 
  });
}

// Generate docs
async function ensureDocsGenerated(emp) {
  if (!emp) return;
  try {
    let updated = false;
    if (emp.name && emp.cnic) {
      const [ndaPath, contractPath, salaryCertPath] = await Promise.all([
        generateAndSaveNda(emp),
        generateAndSaveContract(emp),
        generateAndSaveSalaryCertificate(emp)
      ]);
      
      if (ndaPath && emp.ndaPath !== ndaPath) {
        emp.ndaPath = ndaPath;
        emp.ndaGenerated = true;
        updated = true;
      }
      if (contractPath && emp.contractPath !== contractPath) {
        emp.contractPath = contractPath;
        emp.contractGenerated = true;
        updated = true;
      }
      if (salaryCertPath && emp.salaryCertificatePath !== salaryCertPath) {
        emp.salaryCertificatePath = salaryCertPath;
        emp.salaryCertificateGenerated = true;
        updated = true;
      }
      if (updated) await emp.save();
    }
  } catch (error) {
    console.error("Error generating documents:", error);
  }
}

// Process message with timeout
async function processMessage(stream, uid) {
  try {
    // Check if already processed
    const emailKey = `uid_${uid}`;
    if (processedEmails.has(emailKey)) {
      console.log(`⚠️ Skipping already processed email UID: ${uid}`);
      return;
    }

    const parsed = await parseStream(stream);
    
    if (!parsed.from?.value?.[0]?.address) {
      console.warn("Email missing from address");
      return;
    }

    const fromAddr = parsed.from.value[0].address.toLowerCase();
    const bodyText = (parsed.text || "").trim();
    const subject = parsed.subject || "No Subject";

    // Check ignored senders
    if (IGNORED_SENDERS.some(sender => fromAddr.includes(sender))) {
      console.log(`⏭️ Skipping email from ignored sender: ${fromAddr}`);
      return;
    }

    console.log(`📩 Processing email from ${fromAddr}, Subject: ${subject.substring(0, 50)}...`);
    processedEmails.set(emailKey, Date.now());

    // Email validation
    let emailIsValid = true;
    try {
      emailIsValid = await verifyEmail(fromAddr);
      if (!emailIsValid) {
        console.warn(`❌ Email validation failed for: ${fromAddr}`);
        return;
      }
    } catch (e) {
      console.error("Email verification failed:", e.message);
    }

    let emp = await Employee.findOne({ email: fromAddr });
    let extractedName = "";
    let ownerId = emp?.owner || DEFAULT_OWNER_ID;
    
    // Validate owner
    ownerId = await validateOwnerId(ownerId);

    let docSent = false;
    const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
    let data = {
      cnic: "",
      dateOfBirth: "",
      gender: "",
      nationality: "",
      cnicIssueDate: "",
      cnicExpiryDate: "",
      phone: "",
      fatherOrHusbandName: "",
      skills: [],
      education: [],
      experience: [],
    };

    // Process attachments
    if (parsed.attachments?.length) {
      console.log(`📎 Found ${parsed.attachments.length} attachment(s)`);
      
      for (const att of parsed.attachments) {
        const fname = (att.filename || "").toLowerCase();
        console.log(`📄 Processing attachment: ${fname}`);
        
        // Validate attachment
        if (att.size > MAX_ATTACHMENT_SIZE) {
          console.warn(`⚠️ Attachment too large: ${fname} (${att.size} bytes)`);
          continue;
        }
        
        if (/\.(png|jpe?g|pdf)$/i.test(fname)) {
          docSent = true;
          const buf = att.content;
          try {
            const cnic = await extractCNICUsingOpenAI(buf);
            Object.assign(data, {
              cnic: cnic.cnic || data.cnic,
              dateOfBirth: cnic.dateOfBirth || data.dateOfBirth,
              gender: cnic.gender || data.gender,
              nationality: cnic.nationality || data.nationality,
              cnicIssueDate: cnic.dateOfIssue || data.cnicIssueDate,
              cnicExpiryDate: cnic.dateOfExpiry || data.cnicExpiryDate,
              fatherOrHusbandName:
                cnic.fatherOrHusbandName || data.fatherOrHusbandName,
            });
            extractedName = cnic.name || "";
          } catch (error) {
            console.error(`❌ CNIC extraction failed for ${fname}:`, error);
          }
        }
      }

      // Handle document submission
      if (docSent) {
        console.log(`📝 Processing documents from ${fromAddr}`);
        
        // Use findOneAndUpdate to prevent race conditions
        const [updatedEmp] = await Promise.all([
          Employee.findOneAndUpdate(
            { email: fromAddr },
            {
              ...data,
              email: fromAddr,
              owner: ownerId,
              $setOnInsert: { 
                name: extractedName || parsed.from.value[0]?.name || "Candidate",
                status: "Document Submitted"
              }
            },
            { 
              upsert: true, 
              new: true,
              setDefaultsOnInsert: true 
            }
          ),
        ]);
        
        emp = updatedEmp;
        
        // Send profile link
        const sendResult = await sendCompleteProfileLink(
          emp._id,
          fromAddr,
          emp.name,
          COMPANY_NAME,
          ownerId
        );
        
        if (sendResult.success) {
          console.log(`✅ Profile link sent to ${fromAddr}`);
        } else {
          console.warn(`⚠️ Could not send profile link: ${sendResult.reason}`);
        }
        
        return;
      }
    }

    // Handle regular emails
    if (!emp) {
      emp = await Employee.findOne({ email: fromAddr });
    }
    
    if (emp) {
      ownerId = await validateOwnerId(emp.owner || DEFAULT_OWNER_ID);
      ensureDocsGenerated(emp).catch(err => 
        console.error("Background doc generation failed:", err)
      );
    }

    const label = classifyEmail(bodyText);
    const signatureBlock = await getSignatureBlock(ownerId);

    console.log(`🏷️ Email classified as: ${label}`);

    // Handle different email types
    const responseHandlers = {
      offer_acceptance: async () => {
        if (emp) {
          emp.status = "Onboarding";
          await emp.save();
        } else {
          emp = await Employee.create({
            email: fromAddr,
            owner: ownerId,
            name: parsed.from.value[0]?.name || "Candidate",
            status: "Onboarding",
          });
        }

        const bestName = emp?.name || "Candidate";
        
        // Send welcome email
        await sendSafeEmail({
          to: fromAddr,
          subject: "Welcome Aboard! Next Steps for Your Onboarding 🎉",
          html: `...`, // Your HTML here
          ownerId,
          type: 'offer_acceptance'
        });
        
        // Notify admins
        const admins = await User.find({
          role: { $in: ["admin", "super-admin"] },
          email: { $exists: true, $ne: "" }
        });
        
        for (const admin of admins) {
          await sendSafeEmail({
            to: admin.email,
            subject: `🎉 Offer Accepted: ${bestName}`,
            html: `...`, // Your HTML here
            ownerId,
            type: 'admin_notification'
          });
        }
      },
      
      offer_rejection: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Thank You for Your Response",
          html: `...`, // Your HTML here
          ownerId,
          type: 'offer_rejection'
        });
      },
      
      approval_response: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Approval/Decision Recorded",
          html: `...`, // Your HTML here
          ownerId,
          type: 'approval_response'
        });
      },
      
      leave_request: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Leave Request Received",
          html: `...`, // Your HTML here
          ownerId,
          type: 'leave_request'
        });
      },
      
      hr_related: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Thank You for Your Message",
          html: `...`, // Your HTML here
          ownerId,
          type: 'hr_general'
        });
      }
    };

    const handler = responseHandlers[label] || responseHandlers.hr_related;
    await handler();

    console.log(`✅ Successfully processed email from ${fromAddr}`);

  } catch (error) {
    console.error("❌ Error processing message:", error);
  }
}

// Process message with timeout wrapper
async function processMessageWithTimeout(stream, uid, timeout = 30000) {
  return Promise.race([
    processMessage(stream, uid),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Processing timeout after ${timeout}ms`)), timeout)
    )
  ]);
}

// IMAP processing
let isProcessing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function checkLatest() {
  if (isProcessing) {
    console.log("⚠️ Already processing, skipping...");
    return;
  }
  
  isProcessing = true;
  
  imap.search(["UNSEEN"], (err, uids) => {
    if (err) {
      console.error("IMAP search error:", err);
      isProcessing = false;
      return;
    }
    
    if (!uids?.length) {
      console.log("No new emails found");
      isProcessing = false;
      return;
    }

    console.log(`📬 Found ${uids.length} new email(s)`);
    
    const fetcher = imap.fetch(uids, { 
      bodies: [""], 
      markSeen: true,
      struct: true 
    });
    
    let processedCount = 0;
    
    fetcher.on("message", (msg, seqno) => {
      console.log(`Processing email ${++processedCount} of ${uids.length}`);
      
      msg.on("body", (stream) => {
        (async () => {
          try {
            await processMessageWithTimeout(stream, uids[seqno - 1], 30000);
          } catch (error) {
            console.error(`Error processing email ${seqno}:`, error);
          }
        })();
      });
      
      msg.on("error", (error) => {
        console.error(`Message stream error for email ${seqno}:`, error);
      });
    });
    
    fetcher.once("error", (error) => {
      console.error("Fetch error:", error);
      isProcessing = false;
    });
    
    fetcher.once("end", () => {
      console.log("✅ Done processing new messages");
      isProcessing = false;
    });
  });
}

// Start watcher
function startWatcher() {
  imap.once("ready", () => {
    reconnectAttempts = 0;
    
    imap.openBox("INBOX", false, (err, box) => {
      if (err) {
        console.error("IMAP openBox error:", err);
        return;
      }
      
      console.log(`📪 Connected to INBOX, ${box.messages.total} total messages`);
      console.log("👀 Watching for new emails...");
      
      imap.on("mail", () => {
        console.log("📩 New mail event detected");
        setTimeout(checkLatest, 1000);
      });
      
      checkLatest();
      setInterval(checkLatest, 30000);
    });
  });

  imap.on("error", (err) => {
    console.error("IMAP connection error:", err);
  });

  imap.on("end", () => {
    console.log("IMAP connection ended");
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("Max reconnection attempts reached. Exiting...");
      process.exit(1);
    }
    
    const delay = Math.min(30000 * Math.pow(2, reconnectAttempts), 300000);
    reconnectAttempts++;
    
    setTimeout(() => {
      console.log(`Attempting to reconnect (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      imap.connect();
    }, delay);
  });

  imap.connect();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("Shutting down gracefully...");
    imap.end();
    mongoose.connection.close();
    process.exit(0);
  });
}

module.exports = { startWatcher };