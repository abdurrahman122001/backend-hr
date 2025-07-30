const Signature = require("../models/Signature");
const multer = require("multer");
const path = require("path");

// Multer setup for image upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/signatures/");
  },
  filename: function (req, file, cb) {
    cb(null, "signature_" + req.user._id + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// POST /api/signature (create or update)
const saveSignature = async (req, res) => {
  try {
    const owner = req.user._id;
    const { signatureText } = req.body; // will be HTML string from Quill
    let signatureImage;
    if (req.file) {
      signatureImage = "/uploads/signatures/" + req.file.filename;
    }
    const data = { signatureText };
    if (signatureImage) data.signatureImage = signatureImage;
    const signature = await Signature.findOneAndUpdate(
      { owner },
      data,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json(signature);
  } catch (err) {
    res.status(500).json({ error: "Signature save failed" });
  }
};

// GET /api/signature
const getMySignature = async (req, res) => {
  try {
    const owner = req.user._id;
    const signature = await Signature.findOne({ owner });
    if (!signature)
      return res.status(404).json({ error: "Signature not set yet" });
    res.json(signature);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch signature" });
  }
};

module.exports = {
  uploadSignatureMiddleware: upload.single("signatureImage"),
  saveSignature,
  getMySignature,
};
