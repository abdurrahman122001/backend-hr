const CommissionRequest = require("../models/CommissionRequest");
const { approvedFields } = require("../utils/requestAutoApproval");

exports.applyCommission = async (req, res) => {
  try {
    const { amount, month, reason } = req.body;
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const ownerId = req.user.owner;

    if (!amount || !month || !reason) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const newRequest = new CommissionRequest({
      employee: employeeId,
      owner: ownerId,
      amount,
      month,
      reason,
      ...approvedFields(req),
    });

    await newRequest.save();
    res.status(201).json({
      message: newRequest.status === "approved" ? "Commission request approved successfully" : "Commission request submitted successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Commission Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const requests = await CommissionRequest.find({ employee: employeeId })
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Commission Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const { status, month } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    if (month) filter.month = month;
    const requests = await CommissionRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Commission Get All Error:", error);
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

    const reviewerId = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || req.user.id || req.user._id;
    const updateData = { status, adminReason, reviewedBy: reviewerId };
    if (status === "approved") {
      updateData.approvedBy = req.user.employeeId || req.user.id || req.user._id;
      updateData.approvedAt = new Date();
    }

    const request = await CommissionRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    res.status(200).json({
      message: `Commission request ${status}`,
      data: request,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.owner;

    const deleted = await CommissionRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) {
      return res.status(404).json({ message: "Request not found" });
    }

    res.status(200).json({ message: "Commission request deleted" });
  } catch (error) {
    console.error("Commission Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
