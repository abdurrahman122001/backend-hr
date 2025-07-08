// backend/src/routes/sendSlipEmail.js
const express = require("express");
const router = express.Router();

const sendSlipEmail = require("../api/send-slip-email");

router.post("/", sendSlipEmail);

module.exports = router;