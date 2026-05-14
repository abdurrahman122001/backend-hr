const LeaveCarryForwardRequest = require("../models/LeaveCarryForwardRequest");
const Employee = require("../models/Employees");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyLeaveCarryForward = async (req, res) => {
  try {
    const { days, year, reason } = req.body;
    const employeeId = getUserId(req);
    const ownerId = getOwnerId(req);

    if (!days || !year) {
      return res.status(400).json({ message: "Days and year are required" });
    }

    // Validate year format (4 digits)
    if (!/^\d{4}$/.test(year)) {
      return res.status(400).json({ message: "Year must be a 4-digit number" });
    }

    const newRequest = new LeaveCarryForwardRequest({
      employee: employeeId,
      owner: ownerId,
      days,
      year,
      reason,
    });

    await newRequest.save();
    res.status(201).json({ message: "Leave carry forward request submitted successfully", data: newRequest });
  } catch (error) {
    console.error("Leave Carry Forward Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = getUserId(req);
    const requests = await LeaveCarryForwardRequest.find({ employee: employeeId }).populate(
      "employee",
      "name designation department photographUrl"
    ).sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Leave Carry Forward Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    const requests = await LeaveCarryForwardRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Leave Carry Forward Get All Error:", error);
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

    const request = await LeaveCarryForwardRequest.findByIdAndUpdate(id, updateData, { new: true });
    if (!request) return res.status(404).json({ message: "Request not found" });

    if (status === "approved") {
      try {
      } catch (err) {
        console.error("Failed to apply leave carry forward to employee:", err);
      }
    }

    res.status(200).json({ message: `Leave carry forward request ${status}`, data: request });
  } catch (error) {
    console.error("Leave Carry Forward Update Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await LeaveCarryForwardRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Leave carry forward request deleted" });
  } catch (error) {
    console.error("Leave Carry Forward Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};