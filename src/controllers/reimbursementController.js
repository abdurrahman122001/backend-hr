const ReimbursementRequest = require("../models/ReimbursementRequest");
const Employee = require("../models/Employees");

exports.applyReimbursement = async (req, res) => {
  try {
    const { amount, month, reason } = req.body;
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const ownerId = req.user.owner;

    if (!amount || !month || !reason) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const newRequest = new ReimbursementRequest({
      employee: employeeId,
      owner: ownerId,
      amount,
      month,
      reason,
    });

    await newRequest.save();
    res.status(201).json({
      message: "Reimbursement request submitted successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Reimbursement Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const requests = await ReimbursementRequest.find({ employee: employeeId }).sort({
      createdAt: -1,
    });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Reimbursement Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const requests = await ReimbursementRequest.find({ owner: ownerId })
      .populate("employee", "name designation department")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Reimbursement Get All Error:", error);
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

    const request = await ReimbursementRequest.findByIdAndUpdate(
      id,
      { status, adminReason },
      { new: true }
    );

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    res.status(200).json({
      message: `Reimbursement request ${status}`,
      data: request,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
