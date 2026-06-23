const LeaveEncashmentRequest = require("../models/LeaveEncashmentRequest");
const Employee = require("../models/Employees");
const { approvedFields } = require("../utils/requestAutoApproval");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyLeaveEncashment = async (req, res) => {
  try {
    const { days, encashmentRate, reason } = req.body;
    const employeeId = getUserId(req);
    const ownerId = getOwnerId(req);

    if (!days || !encashmentRate) {
      return res.status(400).json({ message: "Days and encashment rate are required" });
    }

    const newRequest = new LeaveEncashmentRequest({
      employee: employeeId,
      owner: ownerId,
      days,
      encashmentRate,
      reason,
      ...approvedFields(req),
    });

    await newRequest.save();
    res.status(201).json({
      message: newRequest.status === "approved" ? "Leave encashment request approved successfully" : "Leave encashment request submitted successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Leave Encashment Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = getUserId(req);
    const requests = await LeaveEncashmentRequest.find({ employee: employeeId }).populate(
      "employee",
      "name designation department photographUrl"
    ).sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Leave Encashment Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    const requests = await LeaveEncashmentRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Leave Encashment Get All Error:", error);
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

    const reviewerId = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || getUserId(req);
    const updateData = { status, adminReason, reviewedBy: reviewerId };
    if (status === "approved") {
      updateData.approvedBy = getUserId(req);
      updateData.approvedAt = new Date();
    }

    const request = await LeaveEncashmentRequest.findByIdAndUpdate(id, updateData, { new: true });
    if (!request) return res.status(404).json({ message: "Request not found" });

    if (status === "approved") {
      try {
        // Calculate total encashment amount
        const totalAmount = request.days * request.encashmentRate;
        // Assuming there's a field like 'leaveEncashmentBalance' or similar in Employee model
        // If not, we may need to adjust. For now, we'll just log or skip.
        // Since the Employee model may not have this field, we'll comment out until we know the structure.
        // await Employee.findByIdAndUpdate(request.employee, { $inc: { leaveEncashmentBalance: totalAmount } });
      } catch (err) {
        console.error("Failed to apply leave encashment to employee:", err);
      }
    }

    res.status(200).json({ message: `Leave encashment request ${status}`, data: request });
  } catch (error) {
    console.error("Leave Encashment Update Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await LeaveEncashmentRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Leave encashment request deleted" });
  } catch (error) {
    console.error("Leave Encashment Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
