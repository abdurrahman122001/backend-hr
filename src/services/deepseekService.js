const fs = require("fs");
const { OpenAI } = require("openai"); // openai v4.x

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Latest model used for vision/classification. Overridable via env so the model
// can be bumped without a code change. Falls back to gpt-4o if the primary
// model id isn't available on the account (prevents a hard failure).
const PRIMARY_MODEL = process.env.OPENAI_CNIC_MODEL || "gpt-5.5";
const FALLBACK_MODEL = "gpt-4o";

// Once the primary model proves unusable (e.g. model_not_found), stop retrying
// it on every call — switch to the fallback for the rest of the process.
let primaryModelUsable = true;
function buildChatParams(model, messages, maxTokens) {
  const isReasoning = /^(gpt-5|o\d)/i.test(model);
  if (isReasoning) {
    return {
      model,
      messages,
      max_completion_tokens: Math.max(maxTokens, 2500),
    };
  }
  return { model, messages, temperature: 0, max_tokens: maxTokens };
}

// Single entry point for chat completions with automatic model fallback.
async function createChat(messages, maxTokens) {
  const model = primaryModelUsable ? PRIMARY_MODEL : FALLBACK_MODEL;
  try {
    return await openai.chat.completions.create(buildChatParams(model, messages, maxTokens));
  } catch (err) {
    if (model === PRIMARY_MODEL && PRIMARY_MODEL !== FALLBACK_MODEL) {
      primaryModelUsable = false;
      console.warn(
        `OpenAI model "${PRIMARY_MODEL}" unavailable (${err.message}); falling back to "${FALLBACK_MODEL}"`
      );
      return openai.chat.completions.create(buildChatParams(FALLBACK_MODEL, messages, maxTokens));
    }
    throw err;
  }
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Normalise a date read off a CNIC into the ISO `YYYY-MM-DD` the rest of the
 * system stores and the complete-profile form parses.
 *
 * Pakistani CNICs print dates as `DD.MM.YYYY` (e.g. "24.01.2030"). That dotted
 * form was being written to the database verbatim, and complete-profile's
 * date parser only accepts `/` and `-` separators — so the issue/expiry pickers
 * came up blank. Handles dots, slashes, dashes, already-ISO values, and the
 * "24 Jan 2030" style some cards use.
 *
 * Day-first is assumed when ambiguous, which is the CNIC convention.
 *
 * @returns {string} `YYYY-MM-DD`, or "" when the value can't be understood.
 */
function toIsoDate(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  // Already ISO
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildIso(+iso[1], +iso[2], +iso[3]);

  // DD.MM.YYYY | DD/MM/YYYY | DD-MM-YYYY  (also YYYY.MM.DD)
  const parts = value.match(/^(\d{1,4})[.\-/\s](\d{1,2})[.\-/\s](\d{1,4})$/);
  if (parts) {
    let a = +parts[1], b = +parts[2], c = +parts[3];
    if (String(parts[1]).length === 4) return buildIso(a, b, c); // YYYY.MM.DD
    if (c < 100) c += c < 50 ? 2000 : 1900;                      // 2-digit year
    // a=day, b=month unless that is impossible (a<=12 && b>12 => month-first)
    if (a <= 12 && b > 12) return buildIso(c, a, b);
    return buildIso(c, b, a);
  }

  // 24 Jan 2030 / 24-January-2030
  const named = value.match(/^(\d{1,2})[.\-/\s]*([A-Za-z]{3,})[.\-/\s]*(\d{2,4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month) {
      let year = +named[3];
      if (year < 100) year += year < 50 ? 2000 : 1900;
      return buildIso(year, month, +named[1]);
    }
  }

  return "";
}

function buildIso(year, month, day) {
  if (!year || !month || !day) return "";
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * CNICs print sex as a single letter. Store the full word so the
 * complete-profile Gender select matches it without the employee re-picking.
 */
function toFullGender(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  if (value === "M" || value === "MALE") return "Male";
  if (value === "F" || value === "FEMALE") return "Female";
  if (value === "X" || value === "O" || value === "OTHER") return "Other";
  return "";
}

/**
 * Convert the raw model output into the shapes the database and the
 * complete-profile form expect. Unparseable values become "" rather than
 * garbage, so the employee is asked to fill them in instead of being shown
 * something wrong.
 */
function normalizeCnicInfo(info = {}) {
  return {
    ...info,
    gender: toFullGender(info.gender),
    dateOfBirth: toIsoDate(info.dateOfBirth),
    dateOfIssue: toIsoDate(info.dateOfIssue),
    dateOfExpiry: toIsoDate(info.dateOfExpiry),
  };
}

/**
 * Extracts CNIC info directly from image using OpenAI Vision.
 * @param {string|Buffer} fileData - Path to image or Buffer.
 * @returns {Promise<Object>} - Parsed CNIC info as JSON (dates ISO-normalised).
 */
async function extractCNICUsingOpenAI(fileData) {
  const imageBuffer = Buffer.isBuffer(fileData) ? fileData : fs.readFileSync(fileData);

  // Base64-encode the image
  const base64 = imageBuffer.toString('base64');
  const dataUri = `data:image/jpeg;base64,${base64}`;

  // Compose Vision prompt
  const prompt = `
You are a professional Pakistani CNIC parser.
Given a photo/scan of a Pakistani CNIC (identity card), **extract** and return **EXACTLY** this JSON (no explanation, no extra text):

{
  "name": "",
  "fatherOrHusbandName": "",
  "cnic": "",
  "gender": "",
  "nationality": "",
  "dateOfBirth": "",
  "dateOfIssue": "",
  "dateOfExpiry": ""
}
Read the CNIC number carefully — it is exactly 13 digits. Return "cnic" formatted as XXXXX-XXXXXXX-X (5 digits, dash, 7 digits, dash, 1 digit).
If any field is missing or unclear, leave it as an empty string.
`;

  const res = await createChat(
    [
      { role: "system", content: "You are a helpful assistant." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
    300
  );

  // Try to parse JSON from output
  const content = res.choices?.[0]?.message?.content || "";
  let info = {};
  try {
    info = JSON.parse(content);
  } catch {
    // Try to extract JSON object from messy output
    const match = content.match(/\{[\s\S]*?\}/);
    if (match) {
      info = JSON.parse(match[0]);
    } else {
      throw new Error("OpenAI did not return JSON!");
    }
  }
  return normalizeCnicInfo(info);
}

// Allowed intent labels — must match the response handlers in watcher.js.
const EMAIL_LABELS = [
  "offer_acceptance",
  "offer_rejection",
  "approval_response",
  "leave_request",
  "hr_related",
];

/**
 * Classifies an incoming email's intent using the LLM (replaces the old regex
 * keyword matching). The model decides which kind of reply should be sent.
 * @param {string} text - Plain-text email body.
 * @returns {Promise<string>} - One of EMAIL_LABELS (defaults to "hr_related").
 */
async function classifyEmailUsingOpenAI(text) {
  if (!text || typeof text !== "string" || !text.trim()) return "hr_related";

  const systemPrompt = `You are an email intent classifier for an HR/recruiting system.
Read the email and decide the sender's intent. Respond with EXACTLY ONE of these labels and nothing else:

- offer_acceptance: the candidate is accepting a job offer / confirming they will join.
- offer_rejection: the candidate is declining/rejecting the offer, withdrawing, or not joining.
- approval_response: an approval or decision reply (approving/rejecting some request).
- leave_request: the sender is requesting leave / time off / vacation / sick day.
- hr_related: any other general HR message that doesn't fit the above.

Output only the label (e.g. "offer_acceptance").`;

  try {
    const res = await createChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: text.slice(0, 4000) },
      ],
      10
    );
    const out = (res.choices?.[0]?.message?.content || "").toLowerCase();
    const match = EMAIL_LABELS.find((label) => out.includes(label));
    return match || "hr_related";
  } catch (err) {
    console.error("Email classification failed:", err.message);
    return "hr_related";
  }
}

module.exports = {
  extractCNICUsingOpenAI,
  classifyEmailUsingOpenAI,
  // exported for reuse / tests
  normalizeCnicInfo,
  toIsoDate,
  toFullGender,
};
