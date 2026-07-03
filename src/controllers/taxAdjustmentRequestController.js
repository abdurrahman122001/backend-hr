const TaxAdjustmentRequest = require("../models/TaxAdjustmentRequest");
const { approvedFields } = require("../utils/requestAutoApproval");

exports.submitTaxAdjustmentRequest = async (req, res) => {
  try {
    const { reason, payrollMonth } = req.body;
    const employeeId = req.user.employeeId || req.user._id;
    const ownerId = req.user.owner;

    if (!reason || !payrollMonth) {
      return res.status(400).json({ message: "Reason and payroll month are required" });
    }

    const newRequest = new TaxAdjustmentRequest({
      employee: employeeId,
      owner: ownerId,
      reason,
      payrollMonth,
      attachmentUrl: req.file ? req.file.filename : undefined,
      ...approvedFields(req),
    });

    await newRequest.save();

    res.status(201).json({
      success: true,
      message: newRequest.status === "approved" ? "Tax adjustment request approved successfully" : "Tax adjustment request submitted successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Tax Adjustment Request Submit Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyTaxAdjustmentRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user._id;
    const requests = await TaxAdjustmentRequest.find({ employee: employeeId })
      .populate("employee", "name designation department employeeId")
      .sort({ createdAt: -1 });

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Tax Adjustment Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllTaxAdjustmentRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const requests = await TaxAdjustmentRequest.find({ owner: ownerId })
      .populate("employee", "name designation department employeeId photographUrl")
      .sort({ createdAt: -1 });

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Tax Adjustment Get All Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.updateTaxAdjustmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReason } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const reviewerId = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || req.user.id || req.user._id;
    const updateData = { status, adminReason, reviewedBy: reviewerId };
    if (status === "approved") {
      updateData.approvedBy = req.user.employeeId || req.user.id || req.user._id;
      updateData.approvedAt = new Date();
    }

    const request = await TaxAdjustmentRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    ).populate("employee");

    if (!request) {
      return res.status(404).json({ message: "Tax adjustment request not found" });
    }

    res.status(200).json({
      message: `Tax adjustment request ${status}`,
      data: request,
    });
  } catch (error) {
    console.error("Tax Adjustment Update Status Error:", error);
    res.status(500).json({ message: error.message });
  }
};
