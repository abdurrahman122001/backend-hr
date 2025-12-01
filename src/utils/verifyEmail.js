const axios = require("axios");

async function verifyEmail(email) {
  try {
    // Log once to confirm env vars load correctly
    console.log("ZeroBounce URL:", process.env.ZEROBOUNCE_API_URL);
    console.log("ZeroBounce KEY:", process.env.ZEROBOUNCE_API_KEY?.slice(0, 4) + "****");

    const response = await axios.get(process.env.ZEROBOUNCE_API_URL, {
      params: {
        api_key: process.env.ZEROBOUNCE_API_KEY,
        email: email,
      },
      timeout: 10000, // prevent hanging
    });

    const result = response.data;
    console.log("ZeroBounce Response:", result);

    if (result.status === "valid" || result.status === "catch-all") {
      return true;
    }

    return false;
  } catch (err) {
    console.error("ZeroBounce Email Verification Error:", err.response?.data || err.message);

    // Do NOT block sending an offer when API fails
    return true;
  }
}

module.exports = verifyEmail;
