require("dotenv").config();

const Imap = require("imap");
const { simpleParser } = require("mailparser");
const mongoose = require("mongoose");
const verifyEmail = require("./utils/verifyEmail");
const { removeSignatureParagraphMargins } = require("./utils/removeSignatureParagraphMargins");

const { sendEmail } = require("./services/mailService");
const Employee = require("./models/Employees");
const {
  generateAndSaveNda,
  generateAndSaveContract,
  generateAndSaveSalaryCertificate,
} = require("./services/ndaService");
const { extractCNICUsingOpenAI, classifyEmailUsingOpenAI } = require("./services/deepseekService");
const Signature = require("./models/Signature");
const User = require("./models/Users");
const CompanyProfile = require("./models/CompanyProfile");
const ClientInfo = require("./models/ClientInfo");

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

// Email classification is now handled by the LLM (classifyEmailUsingOpenAI in
// deepseekService.js). The model reads the email and decides the intent label,
// which drives which reply is sent below — replacing the old regex keyword
// matching.

// Get signature block
// Resolve the company variables used in signature/email templates. Mirrors
// getCompanyContext() in offerLetterController: address/phone come from the
// documentation branch (or first branch), name/email/website from the top level.
async function getCompanyVars(ownerId) {
  const fallback = {
    companyName: COMPANY_NAME,
    companyEmail: COMPANY_EMAIL,
    companyPhone: COMPANY_CONTACT,
    companyWebsite: "",
    companyAddress: "",
  };
  try {
    const doc = await CompanyProfile.findOne({ owner: ownerId })
      .select("name email website branches")
      .lean();
    if (!doc) return fallback;

    let branch = null;
    if (doc.branches && doc.branches.length > 0) {
      branch = doc.branches.find((b) => b.useForDocumentation === true) || doc.branches[0];
    }

    return {
      companyName: doc.name || fallback.companyName,
      companyEmail: branch?.email || doc.email || fallback.companyEmail,
      companyPhone: branch?.phone || fallback.companyPhone,
      companyWebsite: doc.website || fallback.companyWebsite,
      companyAddress: branch?.address || fallback.companyAddress,
    };
  } catch (error) {
    console.error("Error resolving company vars:", error);
    return fallback;
  }
}

// Replace {{companyName}}, {{companyPhone}}, {{companyEmail}}, {{companyWebsite}},
// {{companyAddress}} placeholders with their resolved values.
function fillCompanyVars(text, vars) {
  return String(text || "").replace(
    /\{\{\s*(companyName|companyPhone|companyEmail|companyWebsite|companyAddress)\s*\}\}/g,
    (_, key) => vars[key] ?? ""
  );
}

async function getSignatureBlock(ownerId) {
  try {
    const signature = await Signature.findOne({ owner: ownerId });
    if (!signature) return "";

    const companyVars = await getCompanyVars(ownerId);
    const signatureText = fillCompanyVars(signature.signatureText || "", companyVars);

    return `
      <div style="margin-top:32px;margin-bottom:12px;font-size:15px !important;line-height:1.7;">
        ${signature.signatureImage
        ? `<img src="${process.env.SERVER_URL || ""}${signature.signatureImage}" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
        : ""
      }
        <div style="text-align:left;font-size:15px !important;line-height:1.7;">
          ${removeSignatureParagraphMargins(signatureText)}
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
      <p style ="font-size:15px; line-height:1.7;">Dear <strong>${employeeName || "Employee"}</strong>,</p>
      <p style ="font-size:15px; line-height:1.7;">Thank you so much for sharing your CNIC and CV earlier your cooperation means the world to me! 💙</p>
      <p style ="font-size:15px; line-height:1.7;">As your HR AI Agent, I've been busy building a smarter, more connected system to support you better. 
      From payroll to perks, records to recognition it all starts with having the right information in the right place.</p>
      <p style ="font-size:15px; line-height:1.7;">To complete your employee profile and keep our records up to date, I kindly request you to take a moment to fill out a short form:</p>
      <p style ="font-size:15px; line-height:1.7;">
        📝 <strong>
          <a href="${link}" style="color: #0057b7; text-decoration: underline;">
            Click here to complete your profile
          </a>
        </strong>
      </p>
      <p style ="font-size:15px; line-height:1.7;">This will help me ensure:</p>
      <ul style="margin:0 0 1em 2em;padding:0;">
        <li style="margin-bottom:4px;">✅ Your salary info is processed correctly</li>
        <li style="margin-bottom:4px;">✅ Your benefits and contact details are accurate</li>
        <li style="margin-bottom:4px;">✅ You're ready for future updates, promotions, and recognitions 🎉</li>
      </ul>
      <p style ="font-size:15px; line-height:1.7;">It'll only take a few minutes and as always, your data will be handled with strict confidentiality and care.</p>
      <p style ="font-size:15px; line-height:1.7;">Let's make our workplace even more organized, connected, and ready for what's next. Thank you again for being such an important part of the <strong>${companyName}</strong> family. I'm here to make things smoother for you now and always.</p>
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
    // Prefer the plain-text part; fall back to stripping the HTML body so
    // HTML-only replies still produce text for classification.
    let bodyText = (parsed.text || "").trim();
    if (!bodyText && parsed.html) {
      bodyText = String(parsed.html)
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    const subject = parsed.subject || "No Subject";

    // Check ignored senders
    if (IGNORED_SENDERS.some(sender => fromAddr.includes(sender))) {
      console.log(`⏭️ Skipping email from ignored sender: ${fromAddr}`);
      return;
    }

    // Client emails are handled exclusively by emailReceiverService (client →
    // assigned employee flow). The HR bot must never auto-reply to them, even
    // though both watchers share the same inbox. Checked before the expensive
    // verification/LLM steps so client mail costs nothing here.
    try {
      const isClientSender = await ClientInfo.exists({
        $or: [
          { clientEmail: fromAddr },
          { "companyEmployees.email": fromAddr },
        ],
      });
      if (isClientSender) {
        console.log(`⏭️ Skipping client email from ${fromAddr} — handled by client email receiver`);
        return;
      }
    } catch (clientCheckErr) {
      console.error("Client sender check failed:", clientCheckErr.message);
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
        const ctype = (att.contentType || "").toLowerCase();
        console.log(`📄 Attachment: name="${fname || "(none)"}" type="${ctype}" disposition="${att.contentDisposition || ""}" size=${att.size}`);

        // Validate attachment
        if (att.size > MAX_ATTACHMENT_SIZE) {
          console.warn(`⚠️ Attachment too large: ${fname} (${att.size} bytes)`);
          continue;
        }

        // Accept by content-type too — pasted/inline CNIC images often have no
        // filename (or a non-standard one), so a filename-extension check alone
        // misses them and the CNIC flow never triggers.
        const isImageOrPdf =
          /\.(png|jpe?g|pdf)$/i.test(fname) ||
          /^image\/(png|jpe?g|jpg|webp)$/.test(ctype) ||
          ctype === "application/pdf";

        if (isImageOrPdf) {
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
              status: "Document Submitted",
              $setOnInsert: {
                name: extractedName || parsed.from.value[0]?.name || "Candidate",
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

    // Classify on subject + body so short replies like "Subject: Accepted" are
    // detected even when the body is sparse.
    const classifyText = `Subject: ${subject}\n\n${bodyText}`.trim();
    console.log(`📝 Body for classification (${bodyText.length} chars): ${bodyText.slice(0, 160).replace(/\s+/g, " ")}`);

    const label = await classifyEmailUsingOpenAI(classifyText);
    const signatureBlock = await getSignatureBlock(ownerId);

    console.log(`🏷️ Email classified as: ${label} → sending "${label}" reply to ${fromAddr}`);

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

        // Send acceptance acknowledgement asking the candidate to reply with their
        // CNIC (front & back) and CV. Their reply with those attachments triggers
        // the document-processing path below (CNIC extraction → DB update →
        // complete-profile link).
        await sendSafeEmail({
          to: fromAddr,
          subject: `Welcome to ${COMPANY_NAME}! 🎉 Next Step: Share Your Documents`,
          html: `
            <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
              <p style="font-size:15px; line-height:1.7;">Dear <strong>${bestName}</strong>,</p>
              <p style="font-size:15px; line-height:1.7;">We are absolutely delighted to receive your acceptance! 🎉</p>
              <p style="font-size:15px; line-height:1.7;">Welcome to the <strong>${COMPANY_NAME}</strong> family!</p>
              <p style="font-size:15px; line-height:1.7;">Our team is looking forward to working with you and helping you grow in your new role. We know that joining a new company can be both exciting and a little overwhelming — but don't worry, we're here to guide you every step of the way.</p>
              <p style="font-size:15px; line-height:1.7;"><strong>What's next?</strong></p>
              <ul style="margin:0 0 1em 2em;padding:0;">
                <li style="margin-bottom:6px;">Please <strong>reply to this email</strong> with clear images of your <strong>CNIC (front &amp; back, JPG or PNG format)</strong>.</li>
                <li style="margin-bottom:6px;">Attach your latest <strong>CV/Resume (PDF)</strong>.</li>
                <li style="margin-bottom:6px;">Once we have your documents, you'll receive a special link to complete your digital employee profile online.</li>
              </ul>
              <p style="font-size:15px; line-height:1.7;">If you have any questions about your offer, role, or onboarding process, feel free to reach out. Your HR AI Agent (that's me!) is always ready to assist you.</p>
              <p style="font-size:15px; line-height:1.7;">We're excited to see you thrive at ${COMPANY_NAME}. Let's make this journey unforgettable, together!</p>
              <p style="font-size:15px; line-height:1.7;">With excitement,</p>
              ${signatureBlock}
            </div>
          `,
          ownerId,
          type: 'offer_acceptance'
        });

        // Notify only the relevant owner (the account that owns this candidate),
        // not every admin across all tenants.
        const owner = await User.findById(ownerId);
        if (owner?.email) {
          await sendSafeEmail({
            to: owner.email,
            subject: `🎉 Offer Accepted: ${bestName}`,
            html: `
              <div style="font-family: Arial, Helvetica, sans-serif;font-size:15px;line-height:1.7;color:#212121;">
                <p style="font-size:15px; line-height:1.7;">Good news! 🎉</p>
                <p style="font-size:15px; line-height:1.7;"><strong>${bestName}</strong> (${fromAddr}) has <strong>accepted</strong> the offer and has been moved to <strong>Onboarding</strong>.</p>
                <p style="font-size:15px; line-height:1.7;">You can review their progress and onboarding documents from your dashboard.</p>
              </div>
            `,
            ownerId,
            type: 'admin_notification'
          });
        } else {
          console.warn(`⚠️ Owner ${ownerId} has no email on file; skipping owner notification`);
        }
      },

      offer_rejection: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Thank You for Your Response",
          html: `
            <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
              <p style="font-size:15px; line-height:1.7;">Thank you for taking the time to let us know your decision.</p>
              <p style="font-size:15px; line-height:1.7;">We completely respect your choice and truly appreciate the opportunity to have connected with you. While we're sorry it didn't work out this time, we wish you the very best in your career and hope our paths cross again in the future.</p>
              <p style="font-size:15px; line-height:1.7;">Warm regards,</p>
              ${signatureBlock}
            </div>
          `,
          ownerId,
          type: 'offer_rejection'
        });
      },

      approval_response: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Your Response Has Been Recorded",
          html: `
            <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
              <p style="font-size:15px; line-height:1.7;">Thank you — your response has been received and recorded.</p>
              <p style="font-size:15px; line-height:1.7;">If any further action is required, our team will follow up with you shortly. Feel free to reply to this email if you have any questions.</p>
              <p style="font-size:15px; line-height:1.7;">Best regards,</p>
              ${signatureBlock}
            </div>
          `,
          ownerId,
          type: 'approval_response'
        });
      },

      leave_request: async () => {
        await sendSafeEmail({
          to: fromAddr,
          subject: "Leave Request Received",
          html: `
            <div style="font-family: Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#212121;width:100%">
              <p style="font-size:15px; line-height:1.7;">We've received your leave request and it has been forwarded to the relevant approver for review.</p>
              <p style="font-size:15px; line-height:1.7;">You'll be notified by email once a decision has been made. If you need to add any details, simply reply to this message.</p>
              <p style="font-size:15px; line-height:1.7;">Best regards,</p>
              ${signatureBlock}
            </div>
          `,
          ownerId,
          type: 'leave_request'
        });
      },

      // Catch-all: generic/unclassified emails get NO auto-reply. The old
      // "Thank you for reaching out" template also fired for client emails and
      // anything else that landed in the shared inbox, confusing recipients.
      hr_related: async () => {
        console.log(`ℹ️ Unclassified/general email from ${fromAddr} — no auto-reply sent`);
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
// Highest UID processed so far. We track by UID instead of the \Seen flag so an
// email already marked read (by webmail preview or another client) is still
// picked up. Initialised at openBox to the current newest UID so existing mail
// isn't reprocessed.
let lastProcessedUid = 0;

function checkLatest() {
  if (isProcessing) {
    console.log("⚠️ Already processing, skipping...");
    return;
  }

  isProcessing = true;

  // Search by UID range rather than the \Seen flag. Note: an IMAP `start:*`
  // range can return the newest UID even when start > newest, so we filter
  // explicitly to keep only UIDs strictly greater than the last processed one.
  imap.search([["UID", `${lastProcessedUid + 1}:*`]], (err, found) => {
    if (err) {
      console.error("IMAP search error:", err);
      isProcessing = false;
      return;
    }

    const uids = (found || []).filter((u) => u > lastProcessedUid);
    if (!uids.length) {
      console.log("No new emails found");
      isProcessing = false;
      return;
    }

    console.log(`📬 Found ${uids.length} new email(s) (UIDs: ${uids.join(", ")})`);

    const fetcher = imap.fetch(uids, {
      bodies: [""],
      markSeen: true,
      struct: true
    });

    let maxUid = lastProcessedUid;
    const pending = [];

    fetcher.on("message", (msg) => {
      let uid = 0;
      let buffer = "";
      msg.on("attributes", (attrs) => { uid = attrs.uid; });
      msg.on("body", (stream) => {
        stream.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
      });
      msg.once("end", () => {
        pending.push((async () => {
          try {
            // 90s — CNIC vision extraction on a reasoning model plus the DB
            // update and outbound email can exceed the old 30s budget.
            await processMessageWithTimeout(buffer, uid, 90000);
            if (uid > maxUid) maxUid = uid;
          } catch (error) {
            console.error(`Error processing email UID ${uid}:`, error);
            // Still advance past a failing email so it doesn't wedge the queue.
            if (uid > maxUid) maxUid = uid;
          }
        })());
      });
      msg.on("error", (error) => {
        console.error(`Message stream error:`, error);
      });
    });

    fetcher.once("error", (error) => {
      console.error("Fetch error:", error);
      isProcessing = false;
    });

    fetcher.once("end", async () => {
      await Promise.allSettled(pending);
      lastProcessedUid = Math.max(lastProcessedUid, maxUid);
      console.log(`✅ Done processing new messages (lastProcessedUid=${lastProcessedUid})`);
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

      // Start tracking from the current newest UID so the existing inbox isn't
      // reprocessed; only mail that arrives from now on (UID greater than this)
      // is handled — regardless of its read/unread state. Derive it from an ALL
      // search (reliable everywhere); fall back to uidnext-1.
      const armWatch = () => {
        console.log(`👀 Watching for new emails (UID > ${lastProcessedUid})...`);
        // Re-arm the listener fresh each connection so reconnects don't stack
        // duplicate handlers.
        imap.removeAllListeners("mail");
        imap.on("mail", () => {
          console.log("📩 New mail event detected");
          setTimeout(checkLatest, 1000);
        });
        checkLatest();
        setInterval(checkLatest, 30000);
      };

      imap.search(["ALL"], (searchErr, allUids) => {
        if (!searchErr && allUids && allUids.length) {
          lastProcessedUid = Math.max(...allUids);
        } else if (box.uidnext) {
          lastProcessedUid = box.uidnext - 1;
        }
        armWatch();
      });
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