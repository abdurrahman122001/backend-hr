const DocumentRequest = require("../models/DocumentRequest");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyDocumentRequest = async (req, res) => {
  try {
    const { documentType, month, purpose, reason } = req.body;
    const employeeId = req.employee?._id;
    const ownerId = getOwnerId(req);

    if (!documentType) return res.status(400).json({ message: "Document type is required" });
    if (!["salary-slip", "salary-certificate"].includes(documentType)) {
      return res.status(400).json({ message: "Invalid document type" });
    }

    const newRequest = new DocumentRequest({
      employee: employeeId,
      owner: ownerId,
      documentType,
      month: month || undefined,
      purpose: purpose || undefined,
      reason: reason || undefined,
    });

    await newRequest.save();
    res.status(201).json({ message: "Document request submitted successfully", data: newRequest });
  } catch (error) {
    console.error("DocumentRequest Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const filter = { employee: employeeId };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    const requests = await DocumentRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("DocumentRequest GetMy Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status, documentType, month } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    if (documentType) filter.documentType = documentType;
    if (month) filter.month = month;

    const requests = await DocumentRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("DocumentRequest GetAll Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReason } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updateData = { status, adminReason };
    if (status === "approved") {
      updateData.approvedBy = getUserId(req);
      updateData.approvedAt = new Date();
    }

    const request = await DocumentRequest.findByIdAndUpdate(id, updateData, { new: true });
    if (!request) return res.status(404).json({ message: "Request not found" });

    res.status(200).json({ message: `Document request ${status}`, data: request });
  } catch (error) {
    console.error("DocumentRequest UpdateStatus Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await DocumentRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Document request deleted" });
  } catch (error) {
    console.error("DocumentRequest Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
