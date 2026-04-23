const EmailSignature = require("../models/EmailSignature");

const saveEmailSignature = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const owner = req.employee.owner;
    const { signatureText } = req.body;

    const signature = await EmailSignature.findOneAndUpdate(
      { employee: employeeId },
      { signatureText, owner },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(signature);
  } catch (err) {
    console.error("Save email signature error:", err);
    res.status(500).json({ error: "Failed to save signature" });
  }
};

const getEmailSignature = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const signature = await EmailSignature.findOne({ employee: employeeId });
    
    if (!signature) {
      return res.status(404).json({ error: "Signature not set" });
    }

    res.json(signature);
  } catch (err) {
    console.error("Get email signature error:", err);
    res.status(500).json({ error: "Failed to fetch signature" });
  }
};

module.exports = {
  saveEmailSignature,
  getEmailSignature,
};
