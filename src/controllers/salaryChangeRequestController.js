const SalaryChangeRequest = require("../models/SalaryChangeRequest");
const Employee = require("../models/Employees");
const { approvedFields } = require("../utils/requestAutoApproval");

const applySalaryChangeToEmployee = (employeeId, proposedSalary) =>
  Employee.findByIdAndUpdate(employeeId, {
    basic: proposedSalary.basic,
    dearnessAllowance: proposedSalary.dearnessAllowance,
    houseRentAllowance: proposedSalary.houseRentAllowance,
    conveyanceAllowance: proposedSalary.conveyanceAllowance,
    medicalAllowance: proposedSalary.medicalAllowance,
    utilityAllowance: proposedSalary.utilityAllowance,
    overtimeCompensation: proposedSalary.overtimeCompensation,
    dislocationAllowance: proposedSalary.dislocationAllowance,
    leaveEncashment: proposedSalary.leaveEncashment,
    bonus: proposedSalary.bonus,
    arrears: proposedSalary.arrears,
    autoAllowance: proposedSalary.autoAllowance,
    incentive: proposedSalary.incentive,
    fuelAllowance: proposedSalary.fuelAllowance,
    othersAllowances: proposedSalary.othersAllowances,
    grossSalary: proposedSalary.grossSalary,
  });

// Employee submits a salary change request
exports.submitSalaryChangeRequest = async (req, res) => {
  try {
    const { currentSalary, proposedSalary, effectiveDate, payrollPeriod, reason } = req.body;
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const ownerId = req.user.owner;

    if (!proposedSalary || !effectiveDate || !payrollPeriod || !reason) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Get employee's current salary from their profile if not provided
    let employeeSalary = currentSalary;
    if (!employeeSalary) {
      const employee = await Employee.findById(employeeId);
      if (employee) {
        employeeSalary = {
          basic: employee.basic || "",
          dearnessAllowance: employee.dearnessAllowance || "",
          houseRentAllowance: employee.houseRentAllowance || "",
          conveyanceAllowance: employee.conveyanceAllowance || "",
          medicalAllowance: employee.medicalAllowance || "",
          utilityAllowance: employee.utilityAllowance || "",
          overtimeCompensation: employee.overtimeCompensation || "",
          dislocationAllowance: employee.dislocationAllowance || "",
          leaveEncashment: employee.leaveEncashment || "",
          bonus: employee.bonus || "",
          arrears: employee.arrears || "",
          autoAllowance: employee.autoAllowance || "",
          incentive: employee.incentive || "",
          fuelAllowance: employee.fuelAllowance || "",
          othersAllowances: employee.othersAllowances || "",
          grossSalary: employee.grossSalary || "",
        };
      }
    }

    const newRequest = new SalaryChangeRequest({
      employee: employeeId,
      owner: ownerId,
      currentSalary: employeeSalary,
      proposedSalary,
      effectiveDate,
      payrollPeriod,
      reason,
      ...approvedFields(req),
    });

    await newRequest.save();
    await applySalaryChangeToEmployee(employeeId, proposedSalary);

    res.status(201).json({
      message: "Salary change request approved successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Salary Change Request Submit Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Employee gets their own salary change requests
exports.getMySalaryChangeRequests = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user.id || req.user._id;
    const requests = await SalaryChangeRequest.find({ employee: employeeId })
      .populate("employee", "name designation department")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Salary Change Get My Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Admin gets all salary change requests
exports.getAllSalaryChangeRequests = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const requests = await SalaryChangeRequest.find({ owner: ownerId })
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Salary Change Get All Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Admin approves/rejects salary change request
exports.updateSalaryChangeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReason } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updateData = { status, adminReason };
    if (status === "approved") {
      updateData.approvedBy = req.user.employeeId || req.user.id || req.user._id;
      updateData.approvedAt = new Date();
    }

    const request = await SalaryChangeRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    ).populate("employee");

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    // If approved, update employee's salary
    if (status === "approved" && request.employee) {
      await applySalaryChangeToEmployee(request.employee._id, request.proposedSalary);
    }

    res.status(200).json({
      message: `Salary change request ${status}`,
      data: request,
    });
  } catch (error) {
    console.error("Salary Change Update Status Error:", error);
    res.status(500).json({ message: error.message });
  }
};
