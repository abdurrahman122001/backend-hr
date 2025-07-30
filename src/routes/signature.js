const express = require("express");
const {
  uploadSignatureMiddleware,
  saveSignature,
  getMySignature,
} = require("../controllers/signatureController");
const auth = require("../middleware/auth"); // JWT middleware

const router = express.Router();

router.post("/", auth, uploadSignatureMiddleware, saveSignature);
router.get("/", auth, getMySignature);

module.exports = router;
