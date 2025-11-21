const Signature = require("../models/Signature");
const CompanyProfile = require("../models/CompanyProfile");
const multer = require("multer");
const path = require("path");

// Fallback Data
const FALLBACKS = {
  name: "Mavens",
  email: "HR@mavensadvisor.com",
  phone: "+92 312 3850846",
  website: "www.mavensadvisor.com",
  address: "GULSHAN-E-MAYMAR, KARACHI",
};

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

/* --------------------------------------------------------
   Helper: Get Company Context (same logic as main backend)
-------------------------------------------------------- */
async function getCompanyContext(ownerId) {
  try {
    const companyDoc = await CompanyProfile.findOne(
      { owner: ownerId },
      { name: 1, email: 1, website: 1, branches: 1 }
    ).lean();

    if (!companyDoc) return FALLBACKS;

    let selectedBranch = null;

    if (companyDoc.branches && companyDoc.branches.length > 0) {
      selectedBranch = companyDoc.branches.find(
        (b) => b.useForDocumentation === true || b.useForDocumentation === "true"
      );

      if (!selectedBranch) selectedBranch = companyDoc.branches[0];
    }

    const address = selectedBranch?.address || FALLBACKS.address;
    const phone = selectedBranch?.phone || FALLBACKS.phone;
    const email = selectedBranch?.email || companyDoc.email || FALLBACKS.email;

    return {
      name: companyDoc.name || FALLBACKS.name,
      email,
      phone,
      website: companyDoc.website || FALLBACKS.website,
      address,
    };
  } catch (err) {
    return FALLBACKS;
  }
}

/* --------------------------------------------------------
   POST /api/signature (create or update)
-------------------------------------------------------- */
const saveSignature = async (req, res) => {
  try {
    const owner = req.user._id;
    const { signatureText } = req.body; // HTML string from Quill

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

    // Also return company details
    const companyDetails = await getCompanyContext(owner);

    res.json({
      ...signature.toObject(),
      companyDetails,
    });

  } catch (err) {
    res.status(500).json({ error: "Signature save failed" });
  }
};

/* --------------------------------------------------------
   GET /api/signature (GET SIGNATURE + COMPANY DETAILS)
-------------------------------------------------------- */
const getMySignature = async (req, res) => {
  try {
    const owner = req.user._id;

    const signature = await Signature.findOne({ owner });
    if (!signature)
      return res.status(404).json({ error: "Signature not set yet" });

    const companyDetails = await getCompanyContext(owner);

    res.json({
      ...signature.toObject(),
      companyDetails, // <-- FIX: return actual branch/company info
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch signature" });
  }
};

module.exports = {
  uploadSignatureMiddleware: upload.single("signatureImage"),
  saveSignature,
  getMySignature,
};
