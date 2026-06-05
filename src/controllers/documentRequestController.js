const DocumentRequest = require("../models/DocumentRequest");
const Employee = require("../models/Employees");
const Settings = require("../models/Settings");
const { generateSalaryCertificateForEmployee, generateSalarySlipForEmployee } = require("../routes/docs");

const getUserId = (req) => req.user?._id || req.employee?._id;
const getOwnerId = (req) => req.user?.owner || req.employee?.owner;

exports.applyDocumentRequest = async (req, res) => {
  try {
    const { documentType, monthMode, month, fromMonth, toMonth, purpose, purposeOther, copyType, reason } = req.body;
    const employeeId = req.employee?._id;
    const ownerId = getOwnerId(req);

    if (!documentType) return res.status(400).json({ message: "Document type is required" });
    if (!["salary-slip", "salary-certificate"].includes(documentType)) {
      return res.status(400).json({ message: "Invalid document type" });
    }

    // Validate copy type for both salary-slip and salary-certificate
    if (!["soft-copy", "attested"].includes(copyType)) {
      return res.status(400).json({ message: "Please specify how you'd like to receive the document (soft-copy or attested)" });
    }

    // Duplicate check
    if (documentType === "salary-slip") {
      // Salary slip: block if pending or approved request exists for the same month(s)
      const slipQuery = {
        employee: employeeId,
        documentType: "salary-slip",
        status: { $in: ["pending", "approved"] },
      };
      if (monthMode === "multiple") {
        slipQuery.monthMode = "multiple";
        slipQuery.fromMonth = fromMonth;
        slipQuery.toMonth = toMonth;
      } else {
        slipQuery.monthMode = monthMode || "single";
        slipQuery.month = month;
      }
      const existing = await DocumentRequest.findOne(slipQuery);
      if (existing) {
        return res.status(400).json({
          message: "A salary slip request already exists for the selected month(s).",
        });
      }
    } else if (documentType === "salary-certificate") {
      // Salary certificate: only block if there is already a PENDING request
      // Approved/rejected ones don't block — employee can re-request anytime
      const existing = await DocumentRequest.findOne({
        employee: employeeId,
        documentType: "salary-certificate",
        status: "pending",
      });
      if (existing) {
        return res.status(400).json({
          message: "You already have a pending salary certificate request. Please wait for it to be processed.",
        });
      }
    }

    // Check if soft-copy auto-generation is enabled for this owner
    const isSoftCopy = copyType === "soft-copy";
    let autoGenerate = false;
    if (isSoftCopy) {
      const ownerSettings = await Settings.findOne({ owner: ownerId }).lean();
      if (documentType === "salary-certificate") {
        autoGenerate = ownerSettings?.autoGenerateSalaryCertificate === true;
      } else if (documentType === "salary-slip") {
        autoGenerate = ownerSettings?.autoGenerateSalarySlip === true;
      }
    }

    const newRequest = new DocumentRequest({
      employee: employeeId,
      owner: ownerId,
      documentType,
      monthMode: documentType === "salary-slip" ? (monthMode || "single") : undefined,
      month: documentType === "salary-slip" && monthMode === "single" ? month : (documentType === "salary-certificate" ? month : undefined),
      fromMonth: documentType === "salary-slip" && monthMode === "multiple" ? fromMonth : undefined,
      toMonth: documentType === "salary-slip" && monthMode === "multiple" ? toMonth : undefined,
      purpose: purpose || undefined,
      purposeOther: purposeOther || undefined,
      copyType: copyType || undefined,
      reason: reason || undefined,
      // If auto-generate is on for soft-copy, approve immediately
      status: autoGenerate ? "approved" : "pending",
      approvedAt: autoGenerate ? new Date() : undefined,
    });

    await newRequest.save();

    // Salary certificate: Auto-generate PDF on backend (already working)
    if (autoGenerate && documentType === "salary-certificate") {
      try {
        const genResult = await generateSalaryCertificateForEmployee(String(employeeId), String(ownerId));
        if (genResult?.saveResult?.success) {
          newRequest.generatedDocUrl = genResult.saveResult.url;
          newRequest.referenceNumber = genResult.referenceNumber;
          await newRequest.save();
        }
      } catch (genErr) {
        console.error(`Auto-generation of salary-certificate failed:`, genErr.message);
      }
    }

    // Salary slip: Just save request, frontend will generate PDF from SalarySlipPDFContent
    // No backend PDF generation needed

    res.status(201).json({
      message: autoGenerate
        ? `${documentType === "salary-certificate" ? "Salary certificate" : "Salary slip"} generated automatically. You can download it now.`
        : "Document request submitted successfully",
      data: newRequest,
      autoGenerated: autoGenerate,
    });
  } catch (error) {
    console.error("DocumentRequest Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const filter = { employee: employeeId };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    const requests = await DocumentRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("DocumentRequest GetMy Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { status, documentType, month } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;
    if (documentType) filter.documentType = documentType;
    if (month) filter.month = month;

    const requests = await DocumentRequest.find(filter)
      .populate("employee", "name designation department photographUrl")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("DocumentRequest GetAll Error:", error);
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

    const request = await DocumentRequest.findByIdAndUpdate(id, updateData, { new: true })
      .populate("employee", "name designation department companyEmail");
    if (!request) return res.status(404).json({ message: "Request not found" });

    // Auto-generate salary certificate PDF on approval
    if (status === "approved" && request.documentType === "salary-certificate") {
      try {
        const { saveResult, referenceNumber } = await generateSalaryCertificateForEmployee(
          String(request.employee._id || request.employee),
          String(request.owner)
        );

        if (saveResult.success) {
          request.generatedDocUrl = saveResult.url;
          request.referenceNumber = referenceNumber;
          await DocumentRequest.findByIdAndUpdate(id, {
            generatedDocUrl: saveResult.url,
            referenceNumber,
          });
        }
      } catch (genErr) {
        console.error("Salary certificate generation failed:", genErr.message);
        // Don't fail the approval — just log and continue without a URL
      }
    }

    // Notify employee via socket
    const io = req.app.get("io");
    if (io) {
      const empId = String(request.employee._id || request.employee);
      io.to(`employee_${empId}`).emit("document_request_updated", {
        requestId: String(request._id),
        documentType: request.documentType,
        copyType: request.copyType || null,
        status,
        referenceNumber: request.referenceNumber || null,
        generatedDocUrl: request.generatedDocUrl || null,
        message: status === "approved"
          ? `Your salary certificate request has been approved.${request.generatedDocUrl ? " Your certificate is ready to download." : ""}`
          : `Your salary certificate request was rejected. ${adminReason || ""}`.trim(),
      });
    }

    res.status(200).json({ message: `Document request ${status}`, data: request });
  } catch (error) {
    console.error("DocumentRequest UpdateStatus Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.withdrawRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const request = await DocumentRequest.findOne({ _id: id, employee: employeeId });
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (request.status !== "pending") {
      return res.status(400).json({ message: "Only pending requests can be withdrawn" });
    }

    request.status = "cancelled";
    await request.save();

    res.status(200).json({ message: "Document request withdrawn successfully", data: request });
  } catch (error) {
    console.error("DocumentRequest Withdraw Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.editRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const request = await DocumentRequest.findOne({ _id: id, employee: employeeId });
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (request.status !== "pending") {
      return res.status(400).json({ message: "Only pending requests can be edited" });
    }

    const { monthMode, month, fromMonth, toMonth, purpose, purposeOther, copyType, reason } = req.body;

    if (request.documentType === "salary-slip") {
      request.monthMode = monthMode || request.monthMode;
      if (monthMode === "single" || request.monthMode === "single") {
        request.month = month || request.month;
        request.fromMonth = undefined;
        request.toMonth = undefined;
      } else {
        request.fromMonth = fromMonth || request.fromMonth;
        request.toMonth = toMonth || request.toMonth;
        request.month = undefined;
      }
    } else {
      // salary-certificate always uses single month
      request.month = month || request.month;
    }

    if (purpose !== undefined) request.purpose = purpose || undefined;
    if (purposeOther !== undefined) request.purposeOther = purposeOther || undefined;
    if (copyType !== undefined) {
      if (!["soft-copy", "attested"].includes(copyType)) {
        return res.status(400).json({ message: "Invalid copy type" });
      }
      request.copyType = copyType;
    }
    if (reason !== undefined) request.reason = reason || undefined;

    await request.save();
    res.status(200).json({ message: "Request updated successfully", data: request });
  } catch (error) {
    console.error("DocumentRequest Edit Error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = getOwnerId(req);
    const deleted = await DocumentRequest.findOneAndDelete({ _id: id, owner: ownerId });
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Document request deleted" });
  } catch (error) {
    console.error("DocumentRequest Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
