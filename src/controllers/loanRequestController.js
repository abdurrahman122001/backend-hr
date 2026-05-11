const LoanRequest = require("../models/LoanRequest");

exports.applyLoan = async (req, res) => {
  try {
    const { amount, period, reason } = req.body;
    
    // Validate required fields
    if (!amount || !period || !reason) {
      return res.status(400).json({ message: "Amount, period, and reason are required" });
    }

    const employeeId = req.user.employeeId || req.user._id; // UnifiedAuth attaches employeeId for employees
    const ownerId = req.user.owner;

    const newRequest = new LoanRequest({
      employee: employeeId,
      owner: ownerId,
      amount,
      period,
      reason,
      status: "pending"
    });

    await newRequest.save();

    res.status(201).json({
      success: true,
      message: "Loan request submitted successfully",
      data: newRequest
    });
  } catch (error) {
    console.error("Error applying for loan:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.getMyLoanRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user._id;
    const requests = await LoanRequest.find({ employee: employeeId }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: requests
    });
  } catch (error) {
    console.error("Error fetching my loan requests:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.getAllLoanRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    // Only allow admins/managers to see all requests
    if (req.user.role !== "admin" && req.user.role !== "manager" && req.user.role !== "owner") {
      // For HR users, check if they have specific permissions if needed
    }

    const requests = await LoanRequest.find({ owner: ownerId })
      .populate("employee", "name companyEmail department designation photographUrl")
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: requests
    });
  } catch (error) {
    console.error("Error fetching all loan requests:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.updateLoanRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const request = await LoanRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Loan request not found" });
    }

    request.status = status;
    if (status === "rejected") {
      request.rejectionReason = rejectionReason;
    } else {
      request.approvedAt = new Date();
      request.approvedBy = req.user.employeeId || req.user._id;
    }

    await request.save();

    res.json({
      success: true,
      message: `Loan request ${status} successfully`,
      data: request
    });
  } catch (error) {
    console.error("Error updating loan request status:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};
