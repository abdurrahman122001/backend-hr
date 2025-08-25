require("dotenv").config();

const Imap = require("imap");
const { simpleParser } = require("mailparser");
const mongoose = require("mongoose");

const { sendEmail } = require("./services/mailService");
const Employee = require("./models/Employees");
const {
  generateAndSaveNda,
  generateAndSaveContract,
  generateAndSaveSalaryCertificate,
} = require("./services/ndaService");
const {
  extractCNICUsingOpenAI,
  // Optionally, if you want: classifyOfferWithOpenAI, analyzeWithOpenAI
} = require("./services/deepseekService");
const Signature = require("./models/Signature");

// IMAP Config
const imap = new Imap(require("./config/imapConfig"));

// Company Info
const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "hr@mavensadvisors.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+92 312 3850846";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";
const DEFAULT_OWNER_ID = process.env.DEFAULT_OWNER_ID || "6838b0b708e8629ffab534ee";

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

function parseStream(stream) {
  return new Promise((resolve, reject) => {
    simpleParser(stream, (err, parsed) => {
      if (err) reject(err);
      else resolve(parsed);
    });
  });
}

function classifyEmail(text) {
  if (!text) return "hr_related";
  const cleaned = text.toLowerCase().replace(/[\n\r]+/g, " ");
  if (
    /\b(reject|decline|regret|not accept|cannot accept|can't accept|won't accept|sorry.*(cannot|can't|won't|not able)|unfortunately.*(decline|not able|cannot|can't|won't))\b/.test(
      cleaned
    ) ||
    /\b(not interested|withdraw|not accepted|no longer|not joining|will not be able to join|don't want|do not want)\b/.test(
      cleaned
    )
  ) {
    return "offer_rejection";
  }
  if (
    /\b(accepted|accept|acceptance|i will join|happy to join|excited to join|looking forward to join|thank you for the offer)\b/.test(
      cleaned
    ) &&
    !/\b(not accept|cannot accept|can't accept|won't accept|don't accept|not going to accept|do not accept)\b/.test(
      cleaned
    ) &&
    !/\b(reject|decline|regret)\b/.test(cleaned)
  ) {
    return "offer_acceptance";
  }
  if (/\bapprove|approved|reject|rejected\b/.test(cleaned)) {
    return "approval_response";
  }
  if (
    /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/.test(cleaned) ||
    /\b(today|tomorrow|leave|vacation|holiday|day off|sick|absent)\b/.test(
      cleaned
    )
  ) {
    return "leave_request";
  }
  return "hr_related";
}

async function getSignatureBlock(ownerId) {
  const signature = await Signature.findOne({ owner: ownerId });
  if (!signature) return "";

  let signatureBlock = `
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
  return signatureBlock;
}

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
  await sendEmail({ to, subject, html });
}

async function ensureDocsGenerated(emp) {
  if (!emp) return;
  let updated = false;
  if (emp.name && emp.cnic) {
    const ndaPath = await generateAndSaveNda(emp);
    if (ndaPath && emp.ndaPath !== ndaPath) {
      emp.ndaPath = ndaPath;
      emp.ndaGenerated = true;
      updated = true;
    }
    const contractPath = await generateAndSaveContract(emp);
    if (contractPath && emp.contractPath !== contractPath) {
      emp.contractPath = contractPath;
      emp.contractGenerated = true;
      updated = true;
    }
    const salaryCertPath = await generateAndSaveSalaryCertificate(emp);
    if (salaryCertPath && emp.salaryCertificatePath !== salaryCertPath) {
      emp.salaryCertificatePath = salaryCertPath;
      emp.salaryCertificateGenerated = true;
      updated = true;
    }
    if (updated) await emp.save();
  }
}

async function processMessage(stream) {
  try {
    const parsed = await parseStream(stream);
    if (
      !parsed.from ||
      !parsed.from.value ||
      !parsed.from.value[0] ||
      !parsed.from.value[0].address
    ) {
      console.warn("Email missing from address");
      return;
    }

    const fromAddr = parsed.from.value[0].address.toLowerCase();
    const bodyText = (parsed.text || "").trim();

    let emp = await Employee.findOne({ email: fromAddr });
    let extractedName = "";
    let ownerId = emp?.owner || DEFAULT_OWNER_ID;

    let docSent = false;
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

    // --- If CNIC or CV attached ---
    if (parsed.attachments?.length) {
      for (const att of parsed.attachments) {
        const fname = (att.filename || "").toLowerCase();
        if (/\.(png|jpe?g)$/i.test(fname)) {
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
            console.log("CNIC extraction failed:", error);
          }
        }
      }

      // If docSent true, update Employee, send profile link, then RETURN
      if (docSent) {
        if (emp) {
          await Employee.updateOne(
            { email: fromAddr },
            {
              ...data,
              email: fromAddr,
              owner: ownerId,
            }
          );
        } else {
          emp = await Employee.create({
            ...data,
            email: fromAddr,
            owner: ownerId,
            name: extractedName,
          });
        }

        emp = await Employee.findOne({ email: fromAddr });
        await sendCompleteProfileLink(
          emp._id,
          fromAddr,
          emp.name,
          COMPANY_NAME,
          ownerId
        );
        return;
      }
    }

    // --- If NOT a CNIC/CV document email ---
    emp = await Employee.findOne({ email: fromAddr });
    if (emp) {
      ownerId = emp.owner || DEFAULT_OWNER_ID;
      await ensureDocsGenerated(emp);
    }

    // --- Email classification/replies ---
    const label = classifyEmail(bodyText);
    const signatureBlock = await getSignatureBlock(ownerId);

    if (label === "offer_acceptance") {
      let bestName = emp?.name || extractedName || "Candidate";
      await sendEmail({
        to: fromAddr,
        subject: "Welcome Aboard! Next Steps for Your Onboarding 🎉",
        html: `
          <div style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: #212121; width:100%;">
            <p>Dear <strong>${bestName}</strong>,</p>
            <p>
              We are absolutely delighted to receive your acceptance! 🎉<br>
              <br>
              <strong>Welcome to the ${COMPANY_NAME} family!</strong>
            </p>
            <p>
              Our team is looking forward to working with you and helping you grow in your new role.<br>
              We know that joining a new company can be both exciting and a little overwhelming but don't worry, we're here to guide you every step of the way.
            </p>
            <p>
              <strong>What's next?</strong>
              <ul style="margin:0 0 1em 2em;padding:0;">
                <li style="margin-bottom:4px;">Please reply to this email with clear images of your <strong>CNIC</strong> (front & back, JPG or PNG format).</li>
                <li style="margin-bottom:4px;">Attach your <strong>latest CV/Resume</strong> (PDF).</li>
                <li style="margin-bottom:4px;">Once we have your documents, you'll receive a special link to complete your digital employee profile online.</li>
              </ul>
            </p>
            <p>
              If you have any questions about your offer, role, or onboarding process, feel free to reach out. Your HR AI Agent (that's me!) is always ready to assist you.
            </p>
            <p>
              <strong>We're excited to see you thrive at ${COMPANY_NAME}. Let's make this journey unforgettable, together!</strong>
            </p>
            ${signatureBlock}
          </div>
        `,
      });
    } else if (label === "offer_rejection") {
      await sendEmail({
        to: fromAddr,
        subject: "Thank You for Your Response – Offer Not Accepted",
        html: `
          <div style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: #222; width:100%">
            <p>Dear <strong>${emp?.name || extractedName || "Candidate"}</strong>,</p>
            <p>
              Thank you for letting us know about your decision regarding the offer. While we're disappointed that you won't be joining us at this time, we truly appreciate your consideration and the time you spent during our hiring process.
            </p>
            <p>
              If you have any feedback on your experience or would like to share why you chose not to accept, we would be grateful for your thoughts&mdash;it helps us improve! Should circumstances change in the future, please feel free to reach out. We wish you the very best in your career ahead.
            </p>
            ${signatureBlock}
          </div>
        `,
      });
    } else if (label === "approval_response") {
      await sendEmail({
        to: fromAddr,
        subject: "Approval/Decision Recorded",
        html: `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: #212121; max-width:600px;">Thank you for your response. Your approval/rejection has been recorded. ${signatureBlock}</div>`,
      });
    } else if (label === "leave_request") {
      await sendEmail({
        to: fromAddr,
        subject: "Leave Request Received",
        html: `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: #212121; max-width:600px;">Your leave request has been received and will be reviewed. ${signatureBlock}</div>`,
      });
    } else {
      // AI-powered fallback
      // const aiReply = await analyzeWithOpenAI(bodyText);
      await sendEmail({
        to: fromAddr,
        subject: "Regarding Your Message",
        html: `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: #222; max-width:600px;"> ${signatureBlock}</div>`,
      });
    }
  } catch (error) {
    console.error("Error processing message:", error);
  }
}

function checkLatest() {
  imap.search(["UNSEEN"], (err, uids) => {
    if (err) {
      console.error("IMAP search error:", err);
      return;
    }
    if (!uids?.length) return;

    const fetcher = imap.fetch(uids, { bodies: [""], markSeen: true });
    fetcher.on("message", (msg) => {
      msg.on("body", (stream) => {
        processMessage(stream).catch((error) => {
          console.error("Error processing message stream:", error);
        });
      });
      msg.on("error", (error) => {
        console.error("Message stream error:", error);
      });
    });
    fetcher.once("error", (error) => {
      console.error("Fetch error:", error);
    });
    fetcher.once("end", () => console.log("Done processing new messages"));
  });
}

function startWatcher() {
  imap.once("ready", () => {
    imap.openBox("INBOX", false, (err) => {
      if (err) {
        console.error("IMAP openBox error:", err);
        return;
      }
      console.log("Watching for new emails...");
      imap.on("mail", checkLatest);
      checkLatest();
    });
  });

  imap.on("error", (err) => {
    console.error("IMAP connection error:", err);
  });

  imap.on("end", () => {
    console.log("IMAP connection ended");
  });

  imap.connect();

  process.on("SIGINT", () => {
    imap.end();
    mongoose.connection.close();
    process.exit();
  });
}

module.exports = { startWatcher };