// backend/controllers/onboardingController.js

const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip");
const { sendEmail } = require("../services/mailService");
const { encrypt } = require("../utils/encryption");

const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "HR@mavensadvisor.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+44 7451 285285";
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
        shifts = [],
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

      // Build SalarySlip data object (RAW)
      let slipData = {
        employee: null, // to be set below
        candidateName,
        candidateEmail,
        position,
        department,
        startDate,
        reportingTime,
        shifts,
        grossSalary: 0,
      };

      SALARY_COMPONENTS.forEach((field) => {
        if (field === "overtimeCompensation") {
          slipData[field] = Number(
            salaryBreakup.overtimeCompensation ||
              salaryBreakup.overtimeComp ||
              0
          );
        } else {
          slipData[field] = Number(salaryBreakup[field] || 0);
        }
      });

      slipData.grossSalary = SALARY_COMPONENTS.reduce(
        (sum, field) => sum + (Number(slipData[field]) || 0),
        0
      );

      // --- ENCRYPT all salary fields before saving SalarySlip ---
      SALARY_COMPONENTS.forEach((field) => {
        slipData[field] = encrypt(String(slipData[field] || 0));
      });
      slipData.grossSalary = encrypt(String(slipData.grossSalary || 0));

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
          salaryBreakup: slipData, // This now includes encrypted values
          shifts,
          owner: [ownerId], // <<----- SET OWNER (array)
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      slipData.employee = employee._id;

      await SalarySlip.create(slipData);

      // --- EMAIL HTML (Comic Sans, left-aligned, signature + disclaimer) ---
      const subject =
        "🚀 Hello from Your New HR AI Agent – Let’s Get You Officially Onboarded!";

      const html = `
        <div style="font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif; font-size: 16px; color: #212121; line-height: 1.7; text-align: left; margin:0; padding:0; max-width:600px;">
          <p>Dear <strong>${candidateName}</strong>,</p>
          <p>Welcome to the beginning of something amazing! 🌟</p>
          <p>
            I’m your new HR AI Agent here to make your onboarding experience smooth, seamless, and just a little more exciting!<br/>
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
            <em>🎯 Your data is safe with me always encrypted, confidential, and used only to make your experience better.</em>
          </p>
          <p>
            The sooner I get your info, the sooner I can start helping you settle in, track your progress, and celebrate your milestones!
          </p>
          <p>
            If you have any questions or feel stuck, I’m just a message away.
          </p>
          <p>
            Can’t wait to be part of your journey at <strong>${COMPANY_NAME}</strong>!
          </p>
          <br/>
          <div style="margin-bottom:16px;">
            With excitement,<br/><br/>
            Your HR AI Agent 🤖<br/>
            Powered by People. Driven by Purpose.
            <br/><br/>
            T &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; +44 7451 285285<br/>
            E &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; HR@mavensadvisor.com<br/>
            W &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; www.mavensadvisor.com<br/>
            <br/>
            Mavens Advisor LLC<br/>
            East Grand Boulevard, Detroit<br/>
            Michigan, United States
          </div>
          <div style="margin: 32px 0 0 0;">
            <div style="background:#f4f4f4; border-radius:7px; font-family:monospace; font-size:13px; color:#333; white-space:pre; padding:18px 12px; overflow-x:auto;">
*********************************************************************************

The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient of this message, please notify the sender by replying to this message and then delete the message and any copies from your system. Any use, dissemination, distribution, or reproduction of this message by unintended recipients is not authorized and may be unlawful.

*********************************************************************************
            </div>
          </div>
        </div>
      `;

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
