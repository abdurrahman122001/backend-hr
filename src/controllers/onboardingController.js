require("dotenv").config();
const Employee = require("../models/Employees");
const Salaries = require("../models/Salaries");
const { sendEmail } = require("../services/mailService");
const { encrypt } = require("../utils/encryption");
const Signature = require("../models/Signature"); // add this to your requires

// Company info from ENV with fallbacks
const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "HR@mavensadvisor.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+92 312 3850846";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";

const SALARY_COMPONENTS = [
  "basic",
  "dearnessAllowance",
  "houseRentAllowance",
  "conveyanceAllowance",
  "medicalAllowance",
  "utilityAllowance",
  "overtimeCompensation",
  "dislocationAllowance",
  "leaveEncashment",
  "bonus",
  "arrears",
  "autoAllowance",
  "incentive",
  "fuelAllowance",
  "othersAllowances",
];

// --- Helper: Enforce Comic Sans everywhere except disclaimer block ---
function enforceComicSans(html) {
  const fontStyle =
    "font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif;";
  return html
    .replace(/<p(\s|>)/g, `<p style="${fontStyle}"$1`)
    .replace(/<ul(\s|>)/g, `<ul style="${fontStyle}"$1`)
    .replace(/<ol(\s|>)/g, `<ol style="${fontStyle}"$1`)
    .replace(/<li(\s|>)/g, `<li style="${fontStyle}"$1`)
    .replace(/<div(\s|>)/g, `<div style="${fontStyle}"$1`);
}

// --- Helper: Enforce <img> CSS everywhere ---
function enforceImgCss(html) {
  // Remove any existing style attr on <img>
  html = html.replace(/<img([^>]*?)style="[^"]*"/g, `<img$1`);
  // Add our enforced style
  html = html.replace(
    /<img([^>]*?)\/?>/g,
    `<img$1 style="height:200px;width:200px;object-fit:contain;display:inline-block;vertical-align:middle;max-width:200px;max-height:200px;" />`
  );
  return html;
}

module.exports = {
  async requestCnicAndCv(req, res) {
    try {
      const {
        candidateName,
        candidateEmail,
        position,
        department,
        startDate,
        reportingTime,
        salaryBreakup = {},
        shift, // might be a string (single shift id)
        shifts = [], // might be array (for future)
      } = req.body;

      if (
        !candidateName ||
        !candidateEmail ||
        !position ||
        !department ||
        !startDate ||
        !reportingTime
      ) {
        return res.status(400).json({ error: "Missing required fields." });
      }

      let ownerId = null;
      if (req.user && req.user._id) {
        ownerId = req.user._id;
      } else {
        return res.status(401).json({ error: "Unauthorized: owner not found" });
      }

      // ---- SHIFT HANDLING: always use an array ----
      let shiftArr = [];
      if (shift && typeof shift === "string" && shift.trim() !== "") {
        shiftArr = [shift];
      } else if (Array.isArray(shifts) && shifts.length > 0) {
        shiftArr = shifts;
      }

      // --- Encrypt salary fields with await ---
      const encryptedSalary = {};
      for (let field of SALARY_COMPONENTS) {
        let value;
        if (field === "overtimeCompensation") {
          value =
            salaryBreakup.overtimeCompensation ||
            salaryBreakup.overtimeComp ||
            0;
        } else {
          value = salaryBreakup[field] || 0;
        }
        encryptedSalary[field] = await encrypt(String(value));
      }

      // Calculate gross salary and encrypt
      let grossSalaryRaw = 0;
      for (let field of SALARY_COMPONENTS) {
        let val =
          salaryBreakup[field] ||
          (field === "overtimeCompensation"
            ? salaryBreakup.overtimeComp || 0
            : 0);
        grossSalaryRaw += Number(val || 0);
      }
      const encryptedGrossSalary = await encrypt(String(grossSalaryRaw));

      // Save/update employee
      const employee = await Employee.findOneAndUpdate(
        { email: candidateEmail },
        {
          name: candidateName,
          email: candidateEmail,
          designation: position,
          department,
          joiningDate: startDate,
          reportingTime,
          salaryBreakup: salaryBreakup, // not encrypted, for quick ref on employee
          shifts: shiftArr, // always array
          owner: [ownerId],
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Use startDate (employee joining date) or today if not available
      const baseDate = startDate ? new Date(startDate) : new Date();
      const monthName = baseDate.toLocaleString("en-US", { month: "long" }); // "July"
      const year = baseDate.getFullYear().toString();

      // Save Salaries with encrypted fields
      const slipData = {
        employee: employee._id,
        candidateName: await encrypt(candidateName),
        candidateEmail: await encrypt(candidateEmail),
        position: await encrypt(position),
        department: await encrypt(department),
        startDate: await encrypt(startDate),
        reportingTime: await encrypt(reportingTime),
        shifts: shiftArr, // always array
        ...encryptedSalary,
        grossSalary: encryptedGrossSalary,
        month: monthName,
        year: year,
        owner: ownerId, // Fix: Include owner field
        createdBy: ownerId, // Add createdBy for consistency with offerLetter.js
      };

      await Salaries.create(slipData);
      const signature = await Signature.findOne({ owner: ownerId });

      let signatureBlock = "";
      if (signature) {
        signatureBlock = `
        <div style="margin-top:32px;margin-bottom:12px;">
          ${
            signature.signatureImage
              ? `<img src="${process.env.SERVER_URL || ""}${
                  signature.signatureImage
                }" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
              : ""
          }
          <div style="text-align:left;">
            ${signature.signatureText}
          </div>
        </div>
      `;
      }
      // --- EMAIL HTML (Comic Sans, layout, logo, disclaimer, enforced CSS everywhere) ---
      const subject =
        "🚀 Hello from Your New HR AI Agent – Let's Get You Officially Onboarded!";

      let html = `
        <div style="font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif; font-size: 16px; color: #212121; line-height: 1.7; text-align: left; margin:0; padding:0; max-width:600px;">
          <p>Dear <strong>${candidateName}</strong>,</p>
          <p>Welcome to the beginning of something amazing! 🌟</p>
          <p>
            I'm your new HR AI Agent here to make your onboarding experience smooth, seamless, and just a little more exciting!<br/>
            While I might be powered by algorithms and data, my goal is simple: to help you feel connected, supported, and ready to thrive at <strong>${COMPANY_NAME}</strong>.
          </p>
          <p>
            As the first step to complete your profile, please reply with the following documents:
          </p>
          <ul style="margin:0 0 1em 2em;padding:0;">
            <li style="margin-bottom:4px;">✅ <strong>Copy of your CNIC</strong> (front & back, JPG or PNG format)</li>
            <li style="margin-bottom:4px;">✅ <strong>Your latest CV/Resume</strong> (PDF)</li>
          </ul>
          <p>
            <em>🎯 Your data is safe with me – always encrypted, confidential, and used only to make your experience better.</em>
          </p>
          <p>
            The sooner I get your info, the sooner I can start helping you settle in, track your progress, and celebrate your milestones!
          </p>
          <p>
            If you have any questions or feel stuck, I'm just a message away.
          </p>
          <p>
            Can't wait to be part of your journey at <strong>${COMPANY_NAME}</strong>!
          </p>
                ${signatureBlock}
        </div>
      `;

      // Enforce Comic Sans everywhere except disclaimer block
      html = enforceComicSans(html);
      // Enforce <img> CSS everywhere
      html = enforceImgCss(html);

      await sendEmail({
        to: candidateEmail,
        subject,
        html,
      });

      return res.json({
        success: true,
        message: "Request sent for CNIC and CV.",
      });
    } catch (err) {
      console.error("Error requesting CNIC & CV:", err);
      return res.status(500).json({ error: "Failed to send CNIC/CV request." });
    }
  },
};
