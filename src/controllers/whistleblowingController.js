const WhistleblowingReport = require("../models/WhistleblowingReport");
const path = require("path");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.submitReport = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const ownerId = getOwnerId(req);

    const {
      reportType, incidentDate, location,
      description, involvedParties, witnessInfo, isAnonymous,
    } = req.body;

    if (!reportType) return res.status(400).json({ message: "Report type is required" });
    if (!incidentDate) return res.status(400).json({ message: "Incident date is required" });
    if (!description) return res.status(400).json({ message: "Description is required" });

    const validTypes = ["misconduct", "fraud", "harassment", "safety-violation", "policy-breach", "discrimination", "other"];
    if (!validTypes.includes(reportType)) return res.status(400).json({ message: "Invalid report type" });

    let attachmentUrl;
    if (req.file) {
      attachmentUrl = req.file.path || req.file.filename;
    }

    const report = new WhistleblowingReport({
      employee: employeeId,
      owner: ownerId,
      reportType,
      incidentDate: new Date(incidentDate),
      location: location || undefined,
      description,
      involvedParties: involvedParties || undefined,
      witnessInfo: witnessInfo || undefined,
      isAnonymous: isAnonymous === true || isAnonymous === "true",
      attachmentUrl,
    });

    await report.save();
    res.status(201).json({ message: "Whistleblowing report submitted successfully", data: report });
  } catch (error) {
    console.error("Whistleblowing Submit Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyReports = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const reports = await WhistleblowingReport.find({ employee: employeeId })
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
      .populate("employee", "name designation department employeeId photographUrl")
      .populate("reviewedBy", "name")
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

    const validStatuses = ["pending", "under-review", "resolved", "dismissed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updateData = { status, adminNote };
    if (status === "resolved" || status === "dismissed" || status === "under-review") {
      updateData.reviewedBy = getUserId(req);
      updateData.reviewedAt = new Date();
    }

    const report = await WhistleblowingReport.findByIdAndUpdate(id, updateData, { new: true });
    if (!report) return res.status(404).json({ message: "Report not found" });

    res.status(200).json({ message: `Report status updated to ${status}`, data: report });
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
