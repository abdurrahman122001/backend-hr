const fs = require("fs");
const { OpenAI } = require("openai"); // openai v4.x

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
If any field is missing or unclear, leave it as an empty string.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o", // or "gpt-4-vision-preview"
    max_tokens: 300,
    temperature: 0,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUri } }
        ]
      }
    ]
  });

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

module.exports = { extractCNICUsingOpenAI };
