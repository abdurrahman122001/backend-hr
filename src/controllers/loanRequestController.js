const LoanRequest = require("../models/LoanRequest");
const { LOAN_CATEGORIES, CATEGORIES_WITH_PERIOD } = LoanRequest;
const { approvedFields } = require("../utils/requestAutoApproval");
const { notifyRequestDecision, notifyRequestSubmitted } = require("../services/requestNotificationService");
const { payrollRequestFilter, payrollScope } = require("../services/payrollRequestHierarchyService");

exports.applyLoan = async (req, res) => {
  try {
    const {
      amount,
      period,
      reason,
      loanCategory,
      loanAllowanceField,
      loanDeductionType,
      loanDeductionValue,
    } = req.body;

    // Which of the four kinds is being asked for decides what else is
    // required — see the comments on the LoanRequest schema.
    const category = LOAN_CATEGORIES.includes(loanCategory)
      ? loanCategory
      // Older clients never sent a category — carrying an allowance field was
      // what marked the request as the allowance kind.
      : loanAllowanceField
        ? "Loan Allowance"
        : "Personal Loan";
    const isAllowanceLoan = category === "Loan Allowance";
    const wantsPeriod = CATEGORIES_WITH_PERIOD.includes(category);

    if (!amount || !reason) {
      return res.status(400).json({ message: "Amount and reason are required" });
    }
    if (wantsPeriod && !period) {
      return res
        .status(400)
        .json({ message: "Repayment period is required for a " + category });
    }
    if (isAllowanceLoan && !loanAllowanceField) {
      return res
        .status(400)
        .json({ message: "Please select the allowance to deduct from" });
    }
    const deductionType = isAllowanceLoan
      ? loanDeductionType || "complete"
      : null;
    if (
      isAllowanceLoan &&
      deductionType !== "complete" &&
      !(Number(loanDeductionValue) > 0)
    ) {
      return res
        .status(400)
        .json({ message: "Please enter a deduction value" });
    }

    const employeeId = req.user.employeeId || req.user._id; // UnifiedAuth attaches employeeId for employees
    const ownerId = req.user.owner;

    const newRequest = new LoanRequest({
      employee: employeeId,
      owner: ownerId,
      amount,
      period: wantsPeriod ? period : undefined,
      reason,
      loanCategory: category,
      loanAllowanceField: isAllowanceLoan ? loanAllowanceField : null,
      loanDeductionType: deductionType,
      loanDeductionValue:
        isAllowanceLoan && deductionType !== "complete"
          ? Number(loanDeductionValue)
          : null,
      ...approvedFields(req),
    });

    await newRequest.save();
    await notifyRequestSubmitted({ req, request: newRequest, requestType: "loan", requestModel: "LoanRequest", actor: employeeId });

    res.status(201).json({
      success: true,
      message: "Loan request submitted successfully",
      // An admin's own request is auto-approved here, which is already the
      // last word — same signal the review route sends.
      isFinalApproval: newRequest.status === "approved",
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
    const filter = await payrollRequestFilter(req);
    const requests = await LoanRequest.find(filter)
      .populate("employee", "name companyEmail department designation employeeId photographUrl")
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

    // Tenant boundary check: Request owner must match logged-in user's company owner
    if (request.owner?.toString() !== req.user.owner?.toString()) {
      return res.status(403).json({ message: "Not authorized: Request does not belong to your company" });
    }

    const reviewerId = req.employee?._id || req.user.employeeId || req.user?.employeeInfo?.employeeId || req.user._id;

    request.status = status;
    request.reviewedBy = reviewerId;
    if (status === "rejected") {
      request.rejectionReason = rejectionReason;
    } else {
      request.approvedAt = new Date();
      request.approvedBy = reviewerId;
    }

    await request.save();

    await notifyRequestDecision({
      req, request, requestType: "loan", requestModel: "LoanRequest",
      status, actor: reviewerId, reason: rejectionReason,
    });

    // An admin sitting at the root of the Payroll Hierarchy (and the company
    // owner login) is the last word on a payroll request — nothing escalates
    // past them. The admin dashboard uses this to hand the approved loan
    // straight to the Loan Calculator so it only has to be saved.
    const scope = await payrollScope(req);
    const isFinalApproval =
      status === "approved" && !!(scope.isAdminRoot || scope.isOwnerLogin);

    res.json({
      success: true,
      message: `Loan request ${status} successfully`,
      isFinalApproval,
      data: request
    });
  } catch (error) {
    console.error("Error updating loan request status:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.deleteLoanRequest = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find the loan request
    const request = await LoanRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Loan request not found" });
    }

    // Check authorization: must be the owner of the request or an admin/manager
    const employeeId = req.user.employeeId || req.user._id;
    const isOwner = request.employee.toString() === employeeId.toString();
    const isAdminOrManager = ["admin", "manager", "owner"].includes(req.user.role);

    if (!isOwner && !isAdminOrManager) {
      return res.status(403).json({ message: "Not authorized to delete this request" });
    }

    // Tenant boundary check: Request owner must match logged-in user's company owner
    if (request.owner?.toString() !== req.user.owner?.toString()) {
      return res.status(403).json({ message: "Not authorized: Request does not belong to your company" });
    }

    // Cannot delete approved or rejected requests as a regular employee
    if (!isAdminOrManager && request.status !== "pending") {
      return res.status(400).json({ message: "Cannot delete a processed loan request" });
    }

    await LoanRequest.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Loan request deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting loan request:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};
