// src/routes/offerLetterRoutes.js
const express = require("express");
const router = express.Router();

const {
  generateOfferLetter,
  sendOfferLetter,
} = require("../controllers/offerLetterController");

router.post("/generate", generateOfferLetter);
router.post("/send", sendOfferLetter);

module.exports = router;
