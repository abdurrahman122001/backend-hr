const express = require("express");
const {
  saveEmailSignature,
  getEmailSignature,
} = require("../controllers/emailSignatureController");
const empAuth = require("../middleware/empAuth");

const router = express.Router();

router.post("/", empAuth, saveEmailSignature);
router.get("/", empAuth, getEmailSignature);

module.exports = router;
