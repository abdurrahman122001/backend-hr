const BonusRequest = require("../models/BonusRequest");
const Employee = require("../models/Employees");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyBonus = async (req, res) => {
  try {
    const { amount, month, reason } = req.body;
    const employeeId = getUserId(req);
    const ownerId = getOwnerId(req);

    if (!amount) return res.status(400).json({ message: "Amount is required" });

    const newRequest = new BonusRequest({
      employee: employeeId,
      owner: ownerId,
      amount,
      month,
      reason,
    });

    await newRequest.save();
    res.status(201).json({ message: "Bonus request submitted successfully", data: newRequest });
  } catch (error) {
    console.error("Bonus Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = getUserId(req);
    const requests = await BonusRequest.find({ employee: employeeId }).populate(
      "employee",
      "name designation department photographUrl"
    ).sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Bonus Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status, month } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    if (month) filter.month = month;
    const requests = await BonusRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Bonus Get All Error:", error);
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

    const request = await BonusRequest.findByIdAndUpdate(id, updateData, { new: true });
    if (!request) return res.status(404).json({ message: "Request not found" });

    if (status === "approved") {
      try {
        await Employee.findByIdAndUpdate(request.employee, { $inc: { bonusCash: request.amount } });
      } catch (err) {
        console.error("Failed to apply bonus to employee:", err);
      }
    }

    res.status(200).json({ message: `Bonus request ${status}`, data: request });
  } catch (error) {
    console.error("Bonus Update Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await BonusRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Bonus request deleted" });
  } catch (error) {
    console.error("Bonus Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const actor = req.user || req.employee;
    const employeeId = actor?.employeeId || actor?._id;

    const requests = await BonusRequest.find({ employee: employeeId })
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Bonus Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user._id;

    const requests = await BonusRequest.find({ employee: employeeId })
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Bonus Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner; // ✅ fixed: was req.employee.owner
    const { status, month } = req.query;

    const filter = { owner: ownerId };
    if (status) filter.status = status;
    if (month) filter.month = month;

    const requests = await BonusRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Bonus Get All Error:", error);
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
      updateData.approvedBy = req.user.employeeId || req.user._id; // ✅ fixed
      updateData.approvedAt = new Date();
    }

    const request = await BonusRequest.findByIdAndUpdate(id, updateData, { new: true });
    if (!request) return res.status(404).json({ message: "Request not found" });

    if (status === "approved") {
      try {
        await Employee.findByIdAndUpdate(request.employee, {
          $inc: { bonusCash: request.amount },
        });
      } catch (err) {
        console.error("Failed to apply bonus to employee:", err);
      }
    }

    res.status(200).json({ message: `Bonus request ${status}`, data: request });
  } catch (error) {
    console.error("Bonus Update Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.owner; // ✅ fixed: was req.employee.owner

    const deleted = await BonusRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });

    res.status(200).json({ message: "Bonus request deleted" });
  } catch (error) {
    console.error("Bonus Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};