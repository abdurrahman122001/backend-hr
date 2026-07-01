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

/**
 * Extracts CNIC info directly from image using OpenAI Vision.
 * @param {string|Buffer} fileData - Path to image or Buffer.
 * @returns {Promise<Object>} - Parsed CNIC info as JSON.
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
  return info;
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

module.exports = { extractCNICUsingOpenAI, classifyEmailUsingOpenAI };
