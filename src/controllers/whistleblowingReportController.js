const WhistleblowingReport = require("../models/WhistleblowingReport");
const { resolvedFields } = require("../utils/requestAutoApproval");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyReport = async (req, res) => {
  try {
    const {
      reportType,
      incidentDate,
      location,
      description,
      involvedParties,
      witnessInfo,
      isAnonymous,
      attachmentUrl,
    } = req.body;

    const employeeId = req.employee?._id;
    const ownerId = getOwnerId(req);

    if (!reportType || !incidentDate || !description) {
      return res.status(400).json({ message: "Required fields: reportType, incidentDate, description" });
    }

    const newReport = new WhistleblowingReport({
      employee: employeeId,
      owner: ownerId,
      reportType,
      incidentDate,
      location,
      description,
      involvedParties,
      witnessInfo,
      isAnonymous,
      attachmentUrl,
      ...resolvedFields(req),
    });

    await newReport.save();
    res.status(201).json({
      message: newReport.status === "resolved" ? "Whistleblowing report resolved successfully" : "Whistleblowing report submitted successfully",
      data: newReport,
    });
  } catch (error) {
    console.error("Whistleblowing Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyReports = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const reports = await WhistleblowingReport.find({ employee: employeeId })
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: reports });
  } catch (error) {
    console.error("Whistleblowing GetMy Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllReports = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status, reportType } = req.query;
    const filter = { owner: ownerId };

    if (status) filter.status = status;
    if (reportType) filter.reportType = reportType;

    const reports = await WhistleblowingReport.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: reports });
  } catch (error) {
    console.error("Whistleblowing GetAll Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;

    if (!["pending", "under-review", "resolved", "dismissed"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updateData = { status, adminNote };
    if (status === "resolved" || status === "dismissed") {
      updateData.reviewedBy = getUserId(req);
      updateData.reviewedAt = new Date();
    }

    const report = await WhistleblowingReport.findByIdAndUpdate(id, updateData, { new: true });
    if (!report) return res.status(404).json({ message: "Report not found" });

    res.status(200).json({ message: `Whistleblowing report marked as ${status}`, data: report });
  } catch (error) {
    console.error("Whistleblowing UpdateStatus Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await WhistleblowingReport.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Report not found" });
    res.status(200).json({ message: "Whistleblowing report deleted" });
  } catch (error) {
    console.error("Whistleblowing Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
