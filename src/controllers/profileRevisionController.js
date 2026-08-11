const ProfileRevision = require('../models/ProfileRevision');
const Employee = require('../models/Employees');
const User = require('../models/Users');
const mongoose = require('mongoose');
const { autoApprovalNote, getRequestUserId, hasRequestAutoApproval } = require('../utils/requestAutoApproval');
const {
  notifyRequestSubmitted,
  notifyRequestDecision,
} = require('../services/requestNotificationService');

// List of editable fields (all non-salary fields from EmployeeEdit)
const EDITABLE_FIELDS = [
  // Personal Tab
  'name',
  'fatherOrHusbandName',
  'dateOfBirth',
  'gender',
  'nationality',
  'maritalStatus',
  'religion',
  'status',
  'cnic',
  'cnicIssueDate',
  'cnicExpiryDate',
  'latestQualification',
  'fieldOfQualification',
  'photographUrl',
  // Contact Tab
  'phone',
  'email',
  'companyEmail',
  'presentAddress',
  'permanentAddress',
  'emergencyContactName',
  'emergencyContactRelation',
  'emergencyContactNumber',
  'nomineeName',
  'nomineeRelation',
  'nomineeCnic',
  'nomineeEmergencyNo',
  'bankName',
  'bankAccountNumber',
  // Employment Tab
  'joiningDate',
  'leavingDate',
  'role',
  'terminationDate',
  'noticePeriodEndDate',
  'resignationReason',
  'department',
  'designation',
  'shifts',
  'experiences',
  'cnicFrontUrl',
  'cnicBackUrl',
  'matricCertificateUrl',
  'interCertificateUrl',
  'graduateCertificateUrl',
  'mastersCertificateUrl',
];

async function applyRevisionChanges(revision) {
  const employeeUpdate = {};
  const documentUpdate = {};
  const certificateUpdates = [];

  const DOCUMENT_FIELDS = ['cnicFrontUrl', 'cnicBackUrl', 'resumeUrl'];
  const CERTIFICATE_FIELDS = {
    matricCertificateUrl: 'matric',
    interCertificateUrl: 'inter',
    graduateCertificateUrl: 'graduate',
    mastersCertificateUrl: 'masters',
  };

  revision.changes.forEach(change => {
    if (DOCUMENT_FIELDS.includes(change.fieldName)) {
      documentUpdate[change.fieldName] = change.newValue;
    } else if (CERTIFICATE_FIELDS[change.fieldName]) {
      certificateUpdates.push({
        type: CERTIFICATE_FIELDS[change.fieldName],
        fileUrl: change.newValue,
      });
    } else {
      employeeUpdate[change.fieldName] = change.newValue;
    }
  });

  if (Object.keys(employeeUpdate).length > 0) {
    await Employee.findByIdAndUpdate(revision.employee, employeeUpdate);
  }

  if (Object.keys(documentUpdate).length > 0) {
    const EmployeeDocument = require('../models/EmployeeDocument');
    await EmployeeDocument.findOneAndUpdate(
      { employee: revision.employee },
      { $set: documentUpdate },
      { upsert: true, new: true }
    );
  }

  if (certificateUpdates.length > 0) {
    const Certificate = require('../models/Certificate');
    for (const cert of certificateUpdates) {
      await Certificate.findOneAndUpdate(
        { employee: revision.employee, type: cert.type },
        { $set: { fileUrl: cert.fileUrl, uploadedAt: new Date() } },
        { upsert: true, new: true }
      );
    }
  }
}

/**
 * POST /emp-profile-revisions
 * Employee creates a profile revision request
 */
async function createRevision(req, res) {
  try {
    const employeeId = req.employee._id;
    const ownerId = req.employee.owner;
    const { changes, reason } = req.body;

    if (!changes || changes.length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    // Validate field names
    const invalidFields = changes.filter(c => !EDITABLE_FIELDS.includes(c.fieldName));
    if (invalidFields.length > 0) {
      return res.status(400).json({
        error: `Invalid fields for revision: ${invalidFields.map(c => c.fieldName).join(', ')}`,
      });
    }

    // Get current employee data
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Build changes with old and new values
    const processedChanges = changes.map(change => {
      let oldValue = employee[change.fieldName];
      let newValue = change.newValue;

      // Handle nested fields (e.g., leaveBalance.total)
      if (change.fieldName.includes('.')) {
        const parts = change.fieldName.split('.');
        let current = employee;
        for (const part of parts) {
          current = current?.[part];
        }
        oldValue = current;
      }

      return {
        fieldName: change.fieldName,
        oldValue: oldValue || null,
        newValue: newValue || null,
        fieldType: change.fieldType || 'text',
      };
    });

    const shouldAutoApprove = hasRequestAutoApproval(req);

    // Create revision request
    const revision = new ProfileRevision({
      employee: employeeId,
      owner: ownerId,
      changes: processedChanges,
      reason: reason.trim(),
      status: shouldAutoApprove ? 'approved' : 'pending',
      approvedBy: shouldAutoApprove ? getRequestUserId(req) : null,
      reviewedBy: shouldAutoApprove ? (req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || getRequestUserId(req)) : null,
      approvalDate: shouldAutoApprove ? new Date() : null,
      appliedAt: shouldAutoApprove ? new Date() : null,
      adminResponse: shouldAutoApprove ? autoApprovalNote : null,
    });

    await revision.save();
    if (shouldAutoApprove) {
      await applyRevisionChanges(revision);
    }

    // Into the approvers' notification bell and their System Announcements
    // inbox tab, like every other request type. An auto-approved revision needs
    // nobody's approval, so it announces nothing.
    if (!shouldAutoApprove) {
      await notifyRequestSubmitted({
        req,
        request: {
          _id: revision._id,
          status: 'pending',
          employee: employeeId,
          owner: ownerId,
        },
        requestType: 'profile',
        requestModel: 'ProfileRevision',
        actor: employeeId,
      });
    }

    console.log(`[PROFILE-REVISION] ${shouldAutoApprove ? "Auto-approved" : "Created"} revision by ${employeeId}: ${revision._id}`);

    return res.status(201).json({
      message: shouldAutoApprove ? 'Profile revision request approved successfully' : 'Profile revision request submitted successfully',
      revision: {
        _id: revision._id,
        status: revision.status,
        changesCount: revision.changes.length,
        reason: revision.reason,
        createdAt: revision.createdAt,
      },
    });
  } catch (err) {
    console.error('[PROFILE-REVISION-CREATE] Error:', err);
    return res.status(500).json({ error: 'Failed to create revision request' });
  }
}

/**
 * GET /emp-profile-revisions
 * Get employee's own revision requests
 */
async function getEmployeeRevisions(req, res) {
  try {
    const employeeId = req.employee._id;
    const { status, limit = 20, skip = 0 } = req.query;

    const filter = { employee: employeeId };
    if (status) {
      filter.status = status;
    }

    const revisions = await ProfileRevision.find(filter)
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .lean();

    const total = await ProfileRevision.countDocuments(filter);

    return res.json({
      revisions,
      pagination: {
        total,
        skip: Number(skip),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('[PROFILE-REVISION-GET] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch revisions' });
  }
}

/**
 * GET /admin/profile-revisions
 * Admin gets all revision requests for their organization
 */
async function getAdminRevisions(req, res) {
  try {
    const ownerId = req.user.owner;
    const { status, employeeId, limit = 20, skip = 0 } = req.query;

    const filter = { owner: ownerId };
    if (status) {
      filter.status = status;
    }
    if (employeeId) {
      filter.employee = employeeId;
    }

    const revisions = await ProfileRevision.find(filter)
      .populate('employee', 'name companyEmail')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .lean();

    const total = await ProfileRevision.countDocuments(filter);

    return res.json({
      revisions,
      pagination: {
        total,
        skip: Number(skip),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('[PROFILE-REVISION-ADMIN] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch revisions' });
  }
}

/**
 * GET /admin/profile-revisions/:revisionId
 * Get single revision details
 */
async function getRevisionDetail(req, res) {
  try {
    const { revisionId } = req.params;
    const ownerId = req.user.owner;

    const revision = await ProfileRevision.findOne({
      _id: revisionId,
      owner: ownerId,
    })
      .populate('employee', 'name companyEmail phone email')
      .populate('approvedBy', 'name email')
      .lean();

    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }

    return res.json({ revision });
  } catch (err) {
    console.error('[PROFILE-REVISION-DETAIL] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch revision' });
  }
}

/**
 * PATCH /admin/profile-revisions/:revisionId/approve
 * Admin approves and applies a revision
 */
async function approveRevision(req, res) {
  try {
    const { revisionId } = req.params;
    const { adminNotes } = req.body;
    const adminId = req.user.employeeId || req.user._id;
    const ownerId = req.user.owner;

    const revision = await ProfileRevision.findOne({
      _id: revisionId,
      owner: ownerId,
      status: 'pending',
    });

    if (!revision) {
      return res.status(404).json({ error: 'Revision not found or already processed' });
    }

    await applyRevisionChanges(revision);

    // Update revision status
    revision.status = 'approved';
    revision.approvedBy = adminId;
    revision.reviewedBy = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || adminId;
    revision.approvalDate = new Date();
    revision.appliedAt = new Date();
    revision.adminResponse = adminNotes || null;
    await revision.save();

    console.log(`✅ [PROFILE-REVISION] Approved revision ${revisionId} by admin ${adminId}`);

    await notifyRequestDecision({
      req,
      request: { _id: revision._id, employee: revision.employee },
      requestType: 'profile',
      requestModel: 'ProfileRevision',
      status: 'approved',
      actor: revision.reviewedBy,
      reason: adminNotes,
    });

    return res.json({
      message: 'Profile revision approved and applied',
      revision: {
        _id: revision._id,
        status: revision.status,
        appliedAt: revision.appliedAt,
      },
    });
  } catch (err) {
    console.error('[PROFILE-REVISION-APPROVE] Error:', err);
    return res.status(500).json({ error: 'Failed to approve revision' });
  }
}

/**
 * PATCH /admin/profile-revisions/:revisionId/reject
 * Admin rejects a revision
 */
async function rejectRevision(req, res) {
  try {
    const { revisionId } = req.params;
    const rejectionReason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const adminId = req.user.employeeId || req.user._id;
    const ownerId = req.user.owner;

    const revision = await ProfileRevision.findOne({
      _id: revisionId,
      owner: ownerId,
      status: 'pending',
    });

    if (!revision) {
      return res.status(404).json({ error: 'Revision not found or already processed' });
    }

    revision.status = 'rejected';
    revision.approvedBy = adminId;
    revision.reviewedBy = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || adminId;
    revision.approvalDate = new Date();
    revision.adminResponse = rejectionReason || undefined;
    await revision.save();

    console.log(`❌ [PROFILE-REVISION] Rejected revision ${revisionId} by admin ${adminId}`);

    await notifyRequestDecision({
      req,
      request: { _id: revision._id, employee: revision.employee },
      requestType: 'profile',
      requestModel: 'ProfileRevision',
      status: 'rejected',
      actor: revision.reviewedBy,
      reason: rejectionReason,
    });

    return res.json({
      message: 'Profile revision rejected',
      revision: {
        _id: revision._id,
        status: revision.status,
        rejectionReason: revision.adminResponse,
      },
    });
  } catch (err) {
    console.error('[PROFILE-REVISION-REJECT] Error:', err);
    return res.status(500).json({ error: 'Failed to reject revision' });
  }
}

/**
 * PATCH /emp-profile-revisions/:id/withdraw
 * Employee withdraws a pending revision
 */
async function withdrawRevision(req, res) {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const revision = await ProfileRevision.findOne({ _id: id, employee: employeeId });
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (revision.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be withdrawn' });
    }

    revision.status = 'cancelled';
    await revision.save();

    return res.json({ message: 'Profile revision withdrawn successfully' });
  } catch (err) {
    console.error('[PROFILE-REVISION-WITHDRAW] Error:', err);
    return res.status(500).json({ error: 'Failed to withdraw revision' });
  }
}

/**
 * PUT /emp-profile-revisions/:id
 * Employee edits a pending revision (changes array + reason)
 */
async function editRevision(req, res) {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;
    const { changes, reason } = req.body;

    const revision = await ProfileRevision.findOne({ _id: id, employee: employeeId });
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (revision.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be edited' });
    }

    if (!changes || changes.length === 0) {
      return res.status(400).json({ error: 'At least one change is required' });
    }
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const invalidFields = changes.filter(c => !EDITABLE_FIELDS.includes(c.fieldName));
    if (invalidFields.length > 0) {
      return res.status(400).json({
        error: `Invalid fields: ${invalidFields.map(c => c.fieldName).join(', ')}`,
      });
    }

    // Re-fetch employee to get fresh old values
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const processedChanges = changes.map(change => ({
      fieldName: change.fieldName,
      oldValue: employee[change.fieldName] ?? null,
      newValue: change.newValue ?? null,
      fieldType: change.fieldType || 'text',
    }));

    revision.changes = processedChanges;
    revision.reason = reason.trim();
    await revision.save();

    return res.json({ message: 'Profile revision updated successfully', revision });
  } catch (err) {
    console.error('[PROFILE-REVISION-EDIT] Error:', err);
    return res.status(500).json({ error: 'Failed to edit revision' });
  }
}

module.exports = {
  createRevision,
  getEmployeeRevisions,
  getAdminRevisions,
  getRevisionDetail,
  approveRevision,
  rejectRevision,
  withdrawRevision,
  editRevision,
  EDITABLE_FIELDS,
};
