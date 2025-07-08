const fs = require("fs");
const Tesseract = require("tesseract.js");
const axios = require("axios");

const DEEPSEEK_MODEL = "deepseek/deepseek-r1-0528:free";

// OCR extraction from image
async function extractTextFromImage(fileData) {
  const imageBuffer = Buffer.isBuffer(fileData)
    ? fileData
    : fs.readFileSync(fileData);

  const { data: { text } } = await Tesseract.recognize(imageBuffer, "eng", {
    logger: (m) => console.log(m.status, m.progress),
  });

  return text;
}

// Use DeepSeek to extract CNIC info from OCR text
async function extractCNICWithDeepSeek(ocrText) {
  const prompt = `
You are a professional Pakistani CNIC parser.
Given the following raw OCR text of a CNIC card, extract the information and return **EXACTLY** this JSON (no explanation, no extra text):

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

Text:
"""${ocrText}"""
`;

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 512,
    },
    {
      headers: {
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = res.data.choices?.[0]?.message?.content || "";

  let info = {};
  try {
    info = JSON.parse(content);
  } catch {
    // Try to extract JSON object from messy output
    const jsonText = content.match(/\{[\s\S]*?\}/);
    if (jsonText) {
      try {
        info = JSON.parse(jsonText[0]);
      } catch (e2) {
        throw new Error("DeepSeek did not return valid JSON!");
      }
    } else {
      throw new Error("DeepSeek did not return JSON!");
    }
  }
  return info;
}

// AI classifier for offer response (accept, reject, or other)
async function classifyOfferWithDeepSeek(text) {
  const prompt = `
You are an HR assistant. Given the following email text from a candidate, classify if the candidate is:
- "accept" (accepting/joining the offer),
- "reject" (not accepting or rejecting the offer),
- or "other" (none of the above).

Respond with exactly one word: "accept", "reject", or "other". No explanation.

Email:
"""${text}"""
`;

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 8,
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const output = res.data.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (output && (output === "accept" || output === "reject" || output === "other")) {
      return output;
    }
    return "other";
  } catch (err) {
    console.error("DeepSeek offer classification failed:", err);
    return "other";
  }
}

// HR summarizer/fallback reply generator
async function analyzeWithDeepSeek(text) {
  const prompt = `
You are an HR assistant. Analyze the following employee email and give a concise summary in simple English. Suggest a friendly, helpful next action.

Email:
"""${text}"""
`;

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 256,
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return res.data.choices?.[0]?.message?.content || "Thank you for your message. We have received your response.";
  } catch (err) {
    console.error("DeepSeek analysis failed:", err);
    return "Thank you for your message. We have received your response.";
  }
}

// Fallback: Manual Regex extractor (if DeepSeek fails)
function fallbackCNICExtractor(ocrText) {
  const name = (ocrText.match(/Name\s*[:\-]?\s*([A-Z ]+)/i) || [])[1] || "";
  const fatherOrHusbandName = (ocrText.match(/Father(?:'s)? Name\s*[:\-]?\s*([A-Z ]+)/i) || [])[1] || "";
  const cnic = (ocrText.match(/\b\d{5}-\d{7}-\d{1}\b/) || [])[0] || "";
  const gender = (ocrText.match(/Gender\s*[:\-]?\s*(Male|Female)/i) || [])[1] || "";
  const nationality = (ocrText.match(/Nationality\s*[:\-]?\s*([A-Z ]+)/i) || [])[1] || "";
  const dateOfBirth = (ocrText.match(/Date of Birth\s*[:\-]?\s*([\d\/\-]+)/i) || [])[1] || "";
  const dateOfIssue = (ocrText.match(/Date of Issue\s*[:\-]?\s*([\d\/\-]+)/i) || [])[1] || "";
  const dateOfExpiry = (ocrText.match(/Date of Expiry\s*[:\-]?\s*([\d\/\-]+)/i) || [])[1] || "";

  return {
    name: name.trim(),
    fatherOrHusbandName: fatherOrHusbandName.trim(),
    cnic: cnic.trim(),
    gender: gender.trim(),
    nationality: nationality.trim(),
    dateOfBirth: dateOfBirth.trim(),
    dateOfIssue: dateOfIssue.trim(),
    dateOfExpiry: dateOfExpiry.trim(),
  };
}

// Main CNIC OCR and parser
async function extractCNICUsingOCR(fileData) {
  const ocrText = await extractTextFromImage(fileData);
  console.log("OCR Result:\n", ocrText);

  try {
    const info = await extractCNICWithDeepSeek(ocrText);
    return {
      name: info.name || "",
      fatherOrHusbandName: info.fatherOrHusbandName || "",
      cnic: info.cnic || "",
      gender: info.gender || "",
      nationality: info.nationality || "",
      dateOfBirth: info.dateOfBirth || "",
      dateOfIssue: info.dateOfIssue || "",
      dateOfExpiry: info.dateOfExpiry || "",
    };
  } catch (err) {
    console.error("DeepSeek extraction failed, falling back to manual regex:", err);
    return fallbackCNICExtractor(ocrText);
  }
}

module.exports = {
  extractCNICUsingOCR,
  classifyOfferWithDeepSeek,
  analyzeWithDeepSeek,
};
