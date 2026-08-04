// controllers/bugController.js
const Bug = require("../models/Bug");
const Employee = require("../models/Employees");
const fs = require("fs");
const User = require("../models/Users");
const path = require("path");
const {
  hasFeedbackAccess,
  getFeedbackAccess,
} = require("../utils/feedbackAccess");
const { nextFeedbackTicketNumber } = require("../utils/feedbackTicketNumber");

// ---------------------
// CREATE BUG
// ---------------------
exports.createBug = async (req, res) => {
  try {
    const { title, description, priority } = req.body;

    // Validation
    if (!title || !description) {
      // Clean up uploaded files if validation fails
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      return res.status(400).json({
        status: "error",
        message: "Title and description are required",
      });
    }

    // Validate priority
    const validPriorities = ["low", "medium", "high"];
    const bugPriority = validPriorities.includes(priority)
      ? priority
      : "medium";

    // Fetch employee to get department and owner. Admin/HR Users (no Employee
    // doc) can also report feedback — fall back to a fixed department for them.
    let emp = await Employee.findById(req.employee._id).select(
      "department owner"
    );
    if (!emp) {
      const adminUser = await User.findById(req.employee._id).select("_id");
      if (adminUser) {
        emp = { department: "Admin", owner: req.employee._id };
      }
    }
    if (!emp) {
      // Clean up uploaded files if employee not found
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    // Process uploaded images - store only filename
    const images = req.files
      ? req.files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          path: file.filename, // Store just filename
          mimetype: file.mimetype,
          size: file.size,
        }))
      : [];

    // Permanent, per-company serial. Reserved before the insert so the number
    // is fixed at creation and never derived from list position.
    const owner = emp.owner || null;
    const ticketNumber = await nextFeedbackTicketNumber(owner);

    // Create bug
    const bug = await Bug.create({
      title: title.trim(),
      description: description.trim(),
      priority: bugPriority,
      reportedBy: req.employee._id,
      department: emp.department,
      images: images,
      rewardAdded: false, // Initially no reward added
      owner,
      ticketNumber,
    });

    // Populate reporter info for response
    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    return res.status(201).json({
      status: "success",
      message: "Bug reported successfully",
      bug: bug,
    });
  } catch (err) {
    // Clean up uploaded files on error
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    console.error("❌ Error creating bug:", err);

    if (err.name === "ValidationError") {
      return res.status(400).json({
        status: "error",
        message: "Validation error",
        errors: Object.values(err.errors).map((e) => e.message),
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while creating bug",
    });
  }
};

// ---------------------
// GET BUGS - FIXED WITH PROPER PAGINATION
// ---------------------
exports.getBugs = async (req, res) => {
  try {
    const {
      status,
      priority,
      department,
      startDate,
      endDate,
      search,
      page = 1,
      limit = 10,
      viewType = "employee",
      sort,
    } = req.query;

    const employeeId = req.employee._id;
    const emp = await Employee.findById(employeeId)
      .select("department role owner")
      .populate("owner", "name email");

    if (!emp) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    // Create base query for current user's view
    let baseQuery = {};

    // Determine view type
    if (viewType === "owner" && emp.owner) {
      // Owner view - get bugs from all owned employees
      const ownedEmployees = await Employee.find({
        owner: emp.owner._id,
      }).select("_id");
      const ownedEmployeeIds = ownedEmployees.map((e) => e._id);
      baseQuery.reportedBy = { $in: ownedEmployeeIds };
    } else if (viewType === "all") {
      // Admin/R&D can see all bugs
      if (
        emp.department !== "Research & Development" &&
        emp.department !== "Research and Development" &&
        emp.role !== "admin"
      ) {
        return res.status(403).json({
          status: "error",
          message: "Not authorized to view all bugs",
        });
      }
      // No restriction for all view
    } else {
      // Employee view
      if (
        emp.department === "Research & Development" ||
        emp.department === "Research and Development" ||
        emp.role === "admin"
      ) {
        // R&D/Admin sees all bugs in employee view
      } else {
        // Regular employee sees only their bugs
        baseQuery.reportedBy = employeeId;
      }
    }

    // Create filtered query for paginated results
    let query = { ...baseQuery };

    // Apply status filter
    if (status && status !== "all") {
      query.status = status;
    }

    if (priority && priority !== "all") {
      query.priority = priority;
    }

    if (department && department !== "all") {
      query.department = department;
    }

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    // Search filter
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Run the paginated list, its total, and the status-count stats in ONE
    // parallel batch instead of 6 sequential round trips. .lean() skips Mongoose
    // document hydration (the imageUrls virtual isn't used by the client).
    const [total, bugs, baseTotal, openCount, pendingCount, resolvedCount] =
      await Promise.all([
        Bug.countDocuments(query),
        Bug.find(query)
          .populate({
            path: "reportedBy",
            select: "name companyEmail department balance photographUrl owner",
            populate: {
              path: "owner",
              select: "name email",
            },
          })
          .sort(resolveBugSort(sort))
          .skip(skip)
          .limit(limitNum)
          .lean(),
        Bug.countDocuments(baseQuery),
        Bug.countDocuments({ ...baseQuery, status: "open" }),
        Bug.countDocuments({ ...baseQuery, status: "pending_approval" }),
        Bug.countDocuments({ ...baseQuery, status: "resolved" }),
      ]);

    // Calculate total pages
    const totalPages = Math.ceil(total / limitNum);

    // Overall statistics for the base query (without status filter)
    const statusCounts = {
      total: baseTotal,
      open: openCount,
      pending_approval: pendingCount,
      resolved: resolvedCount,
    };

    return res.json({
      status: "success",
      total,
      currentPage: pageNum,
      totalPages,
      statusCounts,
      bugs,
    });
  } catch (err) {
    console.error("❌ Error fetching bugs:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching bugs",
    });
  }
};

exports.getBugsByOwner = async (req, res) => {
  try {
    // This returns EVERY feedback in the organisation, so it is gated. Owners
    // and isAdmin employees qualify implicitly; anyone else needs an explicit
    // FeedbackAccess grant. requireAuth alone is not enough — a plain employee
    // token also satisfies it, which would have exposed the whole org.
    const canSeeAll = await hasFeedbackAccess({
      _id: req.user._id,
      isAdmin: req.user.role === "admin" || req.user.role === "super-admin",
      role: req.user.role,
      owner: req.user.owner,
    });
    if (!canSeeAll) {
      return res.status(403).json({
        success: false,
        message: "You don't have access to all feedbacks.",
      });
    }

    // Use the effective owner id, NOT req.user._id. For an isAdmin employee token
    // (requireAuth employee-fallback), req.user._id is the EMPLOYEE id and there is
    // no matching User record — keying off it returned a false 404 "User not found".
    // req.user.owner resolves to the real owner id for both real User owners and
    // employee-admin tokens.
    const ownerId = req.user.owner || req.user._id;

    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get owner display info. The record may live in the User collection (real owner)
    // or be an isAdmin employee acting as owner — fall back to token info instead of 404.
    let user = await User.findById(ownerId).select("name email role");
    if (!user) {
      user = {
        _id: ownerId,
        name: req.user.employeeName || req.user.name || "Owner",
        email: req.user.companyEmail || "",
      };
    }

    // Get all employees owned by this owner
    const ownedEmployees = await Employee.find({
      owner: ownerId,
      status: "active",
    }).select("_id name companyEmail department balance");

    if (!ownedEmployees || ownedEmployees.length === 0) {
      return res.status(200).json({
        status: "success",
        message: "No employees found for this owner",
        owner: {
          name: user.name,
          email: user.email,
          id: ownerId,
        },
        bugs: [],
        totalBugs: 0,
        totalPages: 0,
        currentPage: page,
        statistics: {
          totalEmployees: 0,
          totalBugBountyBalance: 0,
          bugCounts: {
            total: 0,
            open: 0,
            pending_approval: 0,
            resolved: 0,
          },
        },
      });
    }

    const ownedEmployeeIds = ownedEmployees.map((e) => e._id);

    // Build query for bugs
    const query = { reportedBy: { $in: ownedEmployeeIds } };

    // Apply filters if provided
    if (req.query.status && req.query.status !== "all") {
      query.status = req.query.status;
    }

    if (req.query.priority && req.query.priority !== "all") {
      query.priority = req.query.priority;
    }

    if (req.query.employeeId && req.query.employeeId !== "all") {
      query.reportedBy = req.query.employeeId;
    }

    // Get total count for pagination
    const totalBugs = await Bug.countDocuments(query);
    const totalPages = Math.ceil(totalBugs / limit);

    // Get paginated bugs with ALL fields including approvedByReporter
    const bugs = await Bug.find(query)
      .populate({
        path: "reportedBy",
        select: "name companyEmail department balance photographUrl",
        model: "Employee",
      })
      // This endpoint is the access-gated All Feedbacks view. Keep resolver
      // identity out of ordinary employee feedback responses.
      .populate({ path: "resolvedBy", select: Bug.ASSIGNEE_FIELDS })
      .sort(resolveBugSort(req.query.sort))
      .skip(skip)
      .limit(limit);

    // Calculate total reward per employee from their approved+resolved bugs.
    // One grouped aggregation instead of a Bug.find per owned employee (N+1).
    const employeeTotalRewards = {};
    for (const employee of ownedEmployees) {
      employeeTotalRewards[employee._id.toString()] = 0;
    }

    const rewardAgg = await Bug.aggregate([
      {
        $match: {
          reportedBy: { $in: ownedEmployeeIds },
          status: "resolved",
          approvedByReporter: true,
        },
      },
      {
        $group: {
          _id: "$reportedBy",
          // Mirror the old `rewardAmount || 100`: fall back to 100 when missing/zero.
          total: {
            $sum: {
              $cond: [{ $gt: ["$rewardAmount", 0] }, "$rewardAmount", 100],
            },
          },
        },
      },
    ]);

    for (const row of rewardAgg) {
      employeeTotalRewards[row._id.toString()] = row.total;
    }

    // Process bugs to show appropriate data
    const bugsWithRewards = bugs.map((bug) => {
      const bugData = bug.toObject();
      
      // IMPORTANT: Include the approvedByReporter field
      bugData.approvedByReporter = bug.approvedByReporter || false;
      
      // Only show reward if bug is resolved AND approved by reporter
      if (bugData.status === "resolved" && bugData.approvedByReporter === true) {
        bugData.rewardAmount = bugData.rewardAmount || 100;
        bugData.rewardAdded = true;
      } else {
        // No reward for unapproved bugs
        bugData.rewardAmount = 0;
        bugData.rewardAdded = false;
      }
      
      // Add employee total from all approved bugs to the populated employee object
      if (bugData.reportedBy && bugData.reportedBy._id) {
        bugData.reportedBy.totalFromBugs = employeeTotalRewards[bugData.reportedBy._id.toString()] || 0;
      }
      
      return bugData;
    });

    // Calculate statistics - total from approved bugs only
    let totalFromAllBugs = 0;
    Object.values(employeeTotalRewards).forEach(amount => {
      totalFromAllBugs += amount;
    });

    // Get bug counts for statistics (run in parallel)
    const [totalBugCount, openBugCount, pendingBugCount, resolvedBugCount] =
      await Promise.all([
        Bug.countDocuments({ reportedBy: { $in: ownedEmployeeIds } }),
        Bug.countDocuments({
          reportedBy: { $in: ownedEmployeeIds },
          status: "open",
        }),
        Bug.countDocuments({
          reportedBy: { $in: ownedEmployeeIds },
          status: "pending_approval",
        }),
        Bug.countDocuments({
          reportedBy: { $in: ownedEmployeeIds },
          status: "resolved",
        }),
      ]);

    const bugCounts = {
      total: totalBugCount,
      open: openBugCount,
      pending_approval: pendingBugCount,
      resolved: resolvedBugCount,
    };

    // Prepare employees with bugs data
    const employeesWithBugs = ownedEmployees
      .map((emp) => {
        const employeeBugs = bugsWithRewards.filter(
          (b) =>
            b.reportedBy &&
            b.reportedBy._id &&
            b.reportedBy._id.toString() === emp._id.toString()
        );

        const employeeTotalRewardsFromBugs = employeeTotalRewards[emp._id.toString()] || 0;

        return {
          name: emp.name,
          department: emp.department,
          balance: employeeTotalRewardsFromBugs, // Use total from approved bugs
          bugCount: employeeBugs.length,
          totalRewards: employeeTotalRewardsFromBugs,
        };
      })
      .sort((a, b) => b.balance - a.balance);

    return res.json({
      status: "success",
      owner: {
        name: user.name,
        email: user.email,
        id: ownerId,
      },
      statistics: {
        totalEmployees: ownedEmployees.length,
        totalBugBountyBalance: totalFromAllBugs,
        bugCounts,
        employeesWithBugs,
      },
      bugs: bugsWithRewards,
      totalBugs,
      totalPages,
      currentPage: page,
    });
  } catch (err) {
    console.error("❌ Error fetching bugs by owner:", err);
    console.error("Error details:", err.message);
    console.error("Stack trace:", err.stack);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching bugs by owner",
      error: err.message,
    });
  }
};
// ---------------------
// ASSIGNMENT
// ---------------------

// Sort options offered by the Feedbacks pages. Sorting has to happen in the
// DB, not on the client: the list is paginated, so ordering just the current
// page would shuffle rows within a page while leaving the pages themselves in
// creation order. `_id` is the tiebreaker so equal keys keep a stable order
// across pages instead of drifting between queries.
// Plain indexed fields only, so the existing find().populate().lean() path is
// kept. Sorting by priority is deliberately absent: "high > medium > low" is
// not the lexical order of the stored strings, so it would need an aggregation
// with a computed rank — and priority is already a filter on these pages.
const BUG_SORTS = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  recently_updated: { updatedAt: -1, _id: -1 },
  reward_high: { rewardAmount: -1, createdAt: -1, _id: -1 },
  reward_low: { rewardAmount: 1, createdAt: -1, _id: -1 },
};
const DEFAULT_BUG_SORT = "newest";

// Unknown values fall back to the default rather than 400-ing: a stale client
// sending a retired option should still get a sensible list.
const resolveBugSort = (sort) =>
  BUG_SORTS[String(sort || "")] || BUG_SORTS[DEFAULT_BUG_SORT];

const isRndDepartment = (department) =>
  /^research\s*(&|and)\s*development$/i.test(String(department || "").trim());

/**
 * Who this caller is allowed to assign feedback to.
 *
 * Assigning is an R&D-only action: they work the feedback queue, so they route
 * items among themselves — within their OWN department, never across it. The
 * control is not shown to anyone outside R&D, admins included.
 *
 * Seeing WHO holds an item is wider: admins and anyone with access to all
 * feedback can read the assignee even though they cannot change it.
 */
const getAssignmentScope = async (reqEmployee) => {
  const emp = await Employee.findById(reqEmployee._id)
    .select("_id isAdmin role owner department")
    .lean();
  const subject = emp || reqEmployee;

  const { hasAccess, canResolve, isAdmin } = await getFeedbackAccess(subject);
  const role = String(subject.role || "").toLowerCase();
  const privileged =
    isAdmin ||
    subject.isAdmin === true ||
    reqEmployee.isAdmin === true ||
    ["owner", "admin", "super-admin"].includes(role) ||
    canResolve;

  const isRnd = isRndDepartment(subject.department);

  return {
    subject,
    ownerId: subject.owner || reqEmployee.owner || reqEmployee._id,
    department: subject.department,
    privileged,
    isRnd,
    canReopen: hasAccess,
    canAssign: isRnd,
    canSeeAssignee: hasAccess || privileged || isRnd,
    // May approve/close out ANY employee's feedback, not just their own.
    // isAdmin employees and holders of organisation-wide feedback access
    // qualify — otherwise a resolution waiting on an absent reporter sits in
    // "pending approval" forever with nobody able to finish it.
    canResolveAny: hasAccess || privileged,
  };
};

// The assignable pool for a given scope: R&D teammates, and nobody otherwise.
// The caller is always in it — taking an item yourself is the common case — and
// is returned first so "assign to me" is the top of the list. They are also
// added back explicitly if the department query misses them (a non-"active"
// status on their own record must not stop them picking up work).
const findAssigneesForScope = async (scope) => {
  if (!scope.isRnd) return [];

  const team = await Employee.find({
    owner: scope.ownerId,
    status: "active",
    department: scope.department,
  })
    .select(Bug.ASSIGNEE_FIELDS)
    .sort({ name: 1 })
    .lean();

  const meId = String(scope.subject._id);
  let me = team.find((e) => String(e._id) === meId);
  if (!me) {
    me = await Employee.findById(meId).select(Bug.ASSIGNEE_FIELDS).lean();
  }

  return me
    ? [me, ...team.filter((e) => String(e._id) !== meId)]
    : team;
};


// GET /api/bugs/assignees — the dropdown source for the Feedbacks pages.
// Returns the caller's own rights alongside the list so the UI needs one call
// to decide between the picker, a read-only chip, and showing nothing.
exports.getAssignees = async (req, res) => {
  try {
    const scope = await getAssignmentScope(req.employee);
    const assignees = await findAssigneesForScope(scope);
    return res.json({
      status: "success",
      assignees,
      // So the UI can mark the caller's own entry "(You)" — self-assignment is
      // allowed and is the first row of the list.
      meId: String(scope.subject._id),
      canAssign: scope.canAssign,
      canReopen: scope.canReopen,
      canSeeAssignee: scope.canSeeAssignee,
      canResolveAny: scope.canResolveAny,
    });
  } catch (err) {
    console.error("❌ Error fetching assignees:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching assignees",
    });
  }
};

// PATCH /api/bugs/:id/assign  { assignedTo: <employeeId> | null }
// Sending null (or an empty string) unassigns.
exports.assignBug = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    // R&D only, and only within their own department. This is the same line
    // the Feedbacks pages use to decide whether to render the control at all.
    const scope = await getAssignmentScope(req.employee);
    if (!scope.canAssign) {
      return res.status(403).json({
        status: "error",
        message: "Only Research & Development can assign feedback",
      });
    }

    const bug = await Bug.findById(id);
    if (!bug) {
      return res
        .status(404)
        .json({ status: "error", message: "Bug not found" });
    }

    // Unassign
    if (!assignedTo) {
      bug.assignedTo = null;
      bug.assignedBy = null;
      bug.assignedAt = null;
      await bug.save();
      return res.json({
        status: "success",
        message: "Feedback unassigned",
        bug: bug.toObject(),
      });
    }

    // Assign — the target must be in the caller's own assignable pool, not just
    // any employee. This is what keeps an R&D assigner inside their department.
    const eligible = await findAssigneesForScope(scope);
    const target = eligible.find((e) => String(e._id) === String(assignedTo));
    if (!target) {
      return res.status(400).json({
        status: "error",
        message: `You can only assign feedback within ${scope.department || "your department"}.`,
      });
    }

    bug.assignedTo = target._id;
    bug.assignedBy = req.employee._id;
    bug.assignedAt = new Date();
    await bug.save();

    const populated = bug.toObject();
    populated.assignedTo = target;

    return res.json({
      status: "success",
      message: `Feedback assigned to ${target.name}`,
      bug: populated,
    });
  } catch (err) {
    console.error("❌ Error assigning bug:", err);

    if (err.name === "CastError") {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid bug or employee ID" });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while assigning feedback",
    });
  }
};

// ---------------------
// GET BUG BY ID
// ---------------------
exports.getBugById = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id).populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check if user has permission to view this bug
    const emp = await Employee.findById(employeeId).select(
      "department role owner"
    );

    const isReporter =
      bug.reportedBy && bug.reportedBy._id.toString() === employeeId.toString();
    const isRAndD =
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin";

    // Check if user is the owner of the reporter
    const isOwnerOfReporter =
      bug.reportedBy &&
      bug.reportedBy.owner &&
      bug.reportedBy.owner._id.toString() === emp.owner?.toString();

    if (!isReporter && !isRAndD && !isOwnerOfReporter) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to view this bug",
      });
    }

    return res.json({
      status: "success",
      bug,
      permissions: {
        canEdit: isReporter || isRAndD,
        canDelete: isReporter || isRAndD,
        canResolve: isReporter || isRAndD,
        isOwnerView: isOwnerOfReporter && !isReporter,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching bug:", err);

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while fetching bug",
    });
  }
};

// ---------------------
// UPDATE BUG
// ---------------------
exports.updateBug = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, priority } = req.body;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id);
    if (!bug) {
      // cleanup new uploads
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      }
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions
    const emp = await Employee.findById(employeeId).select(
      "department role isAdmin owner",
    );
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    const isRAndD =
      emp?.department === "Research and Development" ||
      emp?.department === "Research & Development" ||
      emp?.role === "admin";
    const { hasAccess: canManageAllFeedback } = await getFeedbackAccess(
      emp || req.employee,
    );
    const reporter = await Employee.findById(bug.reportedBy).select("owner");
    const isOwnerOfReporter =
      reporter?.owner?.toString() === employeeId.toString();

    if (!isReporter && !isRAndD && !isOwnerOfReporter && !canManageAllFeedback) {
      // cleanup new uploads
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      }
      return res.status(403).json({
        status: "error",
        message: "Not authorized to update this bug",
      });
    }

    // Update fields if provided
    if (typeof title === "string" && title.trim()) {
      bug.title = title.trim();
    }

    if (typeof description === "string" && description.trim()) {
      bug.description = description.trim();
    }

    if (priority && ["low", "medium", "high"].includes(priority)) {
      bug.priority = priority;
    }

    // Marked-up screenshots arrive as a new upload plus the id of the image
    // they replace. Multer keeps bracketed field names literally, while some
    // clients normalize them, so accept both forms.
    const rawDeleteIds =
      req.body.deleteImages ?? req.body["deleteImages[]"] ?? [];
    const requestedDeleteIds = new Set(
      (Array.isArray(rawDeleteIds) ? rawDeleteIds : [rawDeleteIds])
        .filter(Boolean)
        .map(String),
    );
    const removedImages = [];
    if (requestedDeleteIds.size > 0) {
      bug.images = bug.images.filter((image) => {
        const shouldRemove = requestedDeleteIds.has(image._id.toString());
        if (shouldRemove) removedImages.push(image.toObject?.() || image);
        return !shouldRemove;
      });
    }

    // Append new images (do not delete existing)
    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((file) => ({
        filename: file.filename,
        originalName: file.originalname,
        path: file.filename,
        mimetype: file.mimetype,
        size: file.size,
      }));

      bug.images.push(...newImages);
    }

    await bug.save();

    // Delete old files only after MongoDB accepted the replacement, so a
    // failed save never destroys the user's original screenshot.
    removedImages.forEach((image) => {
      const storedName = path.basename(image.filename || image.path || "");
      if (!storedName) return;
      const candidates = new Set([
        path.join(process.cwd(), "uploads", storedName),
        path.join(__dirname, "../uploads", storedName),
      ]);
      candidates.forEach((imagePath) => {
        try {
          if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        } catch (fileError) {
          console.warn("Could not remove replaced feedback image:", fileError.message);
        }
      });
    });

    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    return res.json({
      status: "success",
      message: "Bug updated successfully",
      bug,
    });
  } catch (err) {
    console.error("❌ Error updating bug:", err);

    // cleanup new uploads on error
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    }

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while updating bug",
    });
  }
};

// ---------------------
// DELETE IMAGE
// ---------------------
exports.deleteImage = async (req, res) => {
  try {
    const { id, imageId } = req.params;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions
    const emp = await Employee.findById(employeeId).select("department role");
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    const isRAndD =
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin";

    if (!isReporter && !isRAndD) {
      // Check if user is owner of reporter
      const reporter = await Employee.findById(bug.reportedBy).select("owner");
      if (!reporter || reporter.owner.toString() !== employeeId.toString()) {
        return res.status(403).json({
          status: "error",
          message: "Not authorized to delete images from this bug",
        });
      }
    }

    // Find the image
    const imageIndex = bug.images.findIndex(
      (img) => img._id.toString() === imageId
    );

    if (imageIndex === -1) {
      return res.status(404).json({
        status: "error",
        message: "Image not found",
      });
    }

    const image = bug.images[imageIndex];

    // Delete physical file
    const imagePath = path.join(__dirname, "../uploads", image.filename);
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    // Remove image from bug
    bug.images.splice(imageIndex, 1);
    await bug.save();

    return res.json({
      status: "success",
      message: "Image deleted successfully",
    });
  } catch (err) {
    console.error("❌ Error deleting image:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while deleting image",
    });
  }
};

exports.resolveBug = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // isAdmin is REQUIRED here — the branch below keys off it, and without it in
    // the projection it read as undefined and every isAdmin employee fell
    // through to the 403.
    const emp = await Employee.findById(employeeId).select(
      "department role isAdmin owner",
    );

    // Granted right to resolve anyone's feedback (Settings → Access → Feedback).
    const { canResolve: canResolveAnyFeedback } = await getFeedbackAccess(
      emp || req.employee,
    );

    // Calculate reward based on priority
    const calculateReward = (priority) => {
      switch (priority) {
        case "high":
          return 100;
        case "medium":
          return 100;
        case "low":
          return 100;
        default:
          return 100;
      }
    };

    const rewardAmount = calculateReward(bug.priority);

    // Reporter can resolve directly
    if (bug.reportedBy.toString() === employeeId.toString()) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;
      bug.resolvedBy = employeeId;
      bug.resolvedAt = new Date();

      // Add reward if not already added
      if (!bug.rewardAdded) {
        await addRewardToReporter(bug.reportedBy, rewardAmount);
        bug.rewardAdded = true;
        bug.rewardAmount = rewardAmount; // Store the reward amount
      }

      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance photographUrl owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: `Bug resolved by reporter. Reward of ${rewardAmount} points added.`,
        bug,
      });
    }

    // R&D department resolves → requires reporter approval.
    //
    // Skipped for an admin or a holder of the feedback resolve grant: the grant
    // says "close any employee's feedback", so routing a grantee who happens to
    // sit in R&D back through reporter approval contradicts the right they were
    // given. They fall through to the outright-resolve branch below.
    if (
      !(emp?.isAdmin === true || canResolveAnyFeedback) &&
      (emp.department === "Research and Development" ||
        emp.department === "Research & Development" ||
        emp.role === "admin")
    ) {
      bug.status = "pending_approval";
      bug.approvalRequired = true;
      bug.approvedByReporter = false;
      bug.resolvedBy = employeeId;
      bug.resolvedAt = null;
      bug.rewardAmount = rewardAmount; // Store the reward amount even if pending
      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance photographUrl owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: "Bug marked as pending approval by reporter",
        bug,
      });
    }

    // Owner can also resolve bugs of their employees
    const reporter = await Employee.findById(bug.reportedBy).select("owner");
    if (
      reporter &&
      reporter.owner &&
      reporter.owner.toString() === employeeId.toString()
    ) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;
      bug.resolvedBy = employeeId;
      bug.resolvedAt = new Date();

      if (!bug.rewardAdded) {
        await addRewardToReporter(bug.reportedBy, rewardAmount);
        bug.rewardAdded = true;
        bug.rewardAmount = rewardAmount;
      }

      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance photographUrl owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: `Bug resolved by owner. Reward of ${rewardAmount} points added.`,
        bug,
      });
    }

    // isAdmin employees close feedback outright, like the owner branch above.
    // The R&D branch keys off `emp.role === "admin"` — the role STRING — which
    // an isAdmin employee does not have (their role stays Employee/Manager and
    // the admin rights live on the isAdmin flag), so they fell through to the
    // 403 below and could not resolve anything. Resolving directly rather than
    // parking it in pending_approval is deliberate: the same person is now
    // allowed to approve, so the extra round trip would be theatre.
    // Same for an employee holding the "resolve" feedback right: they were given
    // it precisely so they can close other people's feedback.
    if (emp?.isAdmin === true || canResolveAnyFeedback) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;
      bug.resolvedBy = employeeId;
      bug.resolvedAt = new Date();

      if (!bug.rewardAdded) {
        await addRewardToReporter(bug.reportedBy, rewardAmount);
        bug.rewardAdded = true;
        bug.rewardAmount = rewardAmount;
      }

      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance photographUrl owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: `Bug resolved by admin. Reward of ${rewardAmount} points added.`,
        bug,
      });
    }

    return res.status(403).json({
      status: "error",
      message: "Not authorized to resolve this bug",
    });
  } catch (err) {
    console.error("❌ Error resolving bug:", err);

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while resolving bug",
    });
  }
};
exports.approveBug = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // The reporter can approve their own, and so can an admin — otherwise a
    // resolution sits in "pending approval" forever whenever the reporter is
    // away, and nobody else is able to close it out.
    //
    // An employee granted the feedback "resolve" right can approve any
    // employee's pending resolution too: that grant exists precisely so someone
    // other than an admin can close feedback out across the organisation, and
    // being able to resolve but not to approve leaves them stuck at the last
    // step of the very workflow they were given.
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    if (!isReporter) {
      const approver = await Employee.findById(employeeId)
        .select("isAdmin role owner")
        .lean();
      const approverRole = String(approver?.role || "").toLowerCase();
      const isAdminApprover =
        approver?.isAdmin === true ||
        ["owner", "admin", "super-admin"].includes(approverRole);

      // hasAccess, not just canResolve: organisation-wide feedback access is
      // the right that lets someone close out other people's feedback, and a
      // holder who can see every pending resolution but cannot sign any of
      // them off is stuck at the last step of that workflow.
      const { canResolve, hasAccess } = await getFeedbackAccess(
        approver || req.employee
      );

      if (!isAdminApprover && !canResolve && !hasAccess) {
        return res.status(403).json({
          status: "error",
          message:
            "Only the reporter, an admin, or someone with feedback access can approve bug resolution",
        });
      }
    }

    // Anything sitting in pending_approval is approvable, even if the
    // approvalRequired flag was never set (older rows, and any row whose
    // resolution path set the status without the flag). Refusing those left
    // feedback that shows an Approve button but answers 400 to it.
    if (!bug.approvalRequired && bug.status !== "pending_approval") {
      return res.status(400).json({
        status: "error",
        message: "No approval required for this bug",
      });
    }

    bug.status = "resolved";
    bug.approvalRequired = false;
    bug.approvedByReporter = true;
    // Preserve the R&D employee who initiated the pending resolution. For
    // legacy pending rows without attribution, fall back to the approver.
    bug.resolvedBy = bug.resolvedBy || employeeId;
    bug.resolvedAt = new Date();

    // Calculate reward if not already set
    const calculateReward = (priority) => {
      switch (priority) {
        case "high":
          return 1000;
        case "medium":
          return 500;
        case "low":
          return 100;
        default:
          return 100;
      }
    };

    const rewardAmount = bug.rewardAmount || calculateReward(bug.priority);

    // Add reward if not already added
    if (!bug.rewardAdded) {
      await addRewardToReporter(bug.reportedBy, rewardAmount);
      bug.rewardAdded = true;
      bug.rewardAmount = rewardAmount;
    }

    await bug.save();

    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    return res.json({
      status: "success",
      message: `Bug approved and marked as resolved. Reward of ${rewardAmount} points added.`,
      bug,
    });
  } catch (err) {
    console.error("❌ Error approving bug:", err);

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while approving bug",
    });
  }
};

// Reopen a resolved (or pending-approval) feedback item. Any employee who can
// access the organisation-wide feedback queue may do this; the same helper
// also grants owners and isAdmin employees implicitly.
exports.reopenBug = async (req, res) => {
  try {
    const { id } = req.params;
    const access = await getFeedbackAccess(req.employee);

    if (!access.hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "Feedback access is required to reopen feedback",
      });
    }

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({ status: "error", message: "Bug not found" });
    }

    if (bug.status === "open") {
      return res.status(400).json({ status: "error", message: "Feedback is already open" });
    }

    bug.status = "open";
    bug.approvalRequired = false;
    bug.approvedByReporter = false;
    bug.resolvedBy = null;
    bug.resolvedAt = null;
    await bug.save();

    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: { path: "owner", select: "name email" },
    });

    return res.json({ status: "success", message: "Feedback reopened", bug });
  } catch (err) {
    console.error("Error reopening bug:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ status: "error", message: "Invalid bug ID" });
    }
    return res.status(500).json({
      status: "error",
      message: "Server error while reopening feedback",
    });
  }
};

// ---------------------
// UPDATE PRIORITY
// ---------------------
exports.updatePriority = async (req, res) => {
  try {
    const { id } = req.params;
    const { priority } = req.body;
    const employeeId = req.employee._id;

    if (!["low", "medium", "high"].includes(priority)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid priority value. Must be: low, medium, or high",
      });
    }

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions
    const emp = await Employee.findById(employeeId).select("department role");
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    const isRAndD =
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin";

    if (!isReporter && !isRAndD) {
      // Check if user is owner of reporter
      const reporter = await Employee.findById(bug.reportedBy).select("owner");
      if (!reporter || reporter.owner.toString() !== employeeId.toString()) {
        return res.status(403).json({
          status: "error",
          message: "Not authorized to update priority for this bug",
        });
      }
    }

    bug.priority = priority;
    await bug.save();

    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance photographUrl owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    return res.json({
      status: "success",
      message: "Priority updated successfully",
      bug,
    });
  } catch (err) {
    console.error("❌ Priority update error:", err);

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while updating priority",
    });
  }
};

// ---------------------
// DELETE BUG
// ---------------------
exports.deleteBug = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions
    const emp = await Employee.findById(employeeId).select("department role");
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    const isRAndD =
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin";

    if (!isReporter && !isRAndD) {
      // Check if user is owner of reporter
      const reporter = await Employee.findById(bug.reportedBy).select("owner");
      if (!reporter || reporter.owner.toString() !== employeeId.toString()) {
        return res.status(403).json({
          status: "error",
          message: "Not authorized to delete this bug",
        });
      }
    }

    // Delete associated images
    if (bug.images && bug.images.length > 0) {
      bug.images.forEach((image) => {
        const imagePath = path.join(__dirname, "../uploads", image.filename);
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      });
    }

    await Bug.findByIdAndDelete(id);

    return res.json({
      status: "success",
      message: "Bug deleted successfully",
    });
  } catch (err) {
    console.error("❌ Error deleting bug:", err);

    if (err.name === "CastError") {
      return res.status(400).json({
        status: "error",
        message: "Invalid bug ID",
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Server error while deleting bug",
    });
  }
};

// ---------------------
// GET EMPLOYEE BALANCE WITH OWNER INFO
// ---------------------
exports.getEmployeeBalance = async (req, res) => {
  try {
    const employee = await Employee.findById(req.employee._id)
      .select("name companyEmail department balance owner")
      .populate("owner", "name email");

    if (!employee) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    // Get bug statistics for this employee. Run the counts and the earnings
    // aggregation in parallel — the frontend previously computed earnings by
    // fetching up to 1000 fully-populated bugs client-side, which was the main
    // cause of the slow "Feedbacks" load. Summing in the DB is far cheaper.
    const [totalBugs, openBugs, pendingBugs, resolvedBugs, earningsAgg] =
      await Promise.all([
        Bug.countDocuments({ reportedBy: employee._id }),
        Bug.countDocuments({ reportedBy: employee._id, status: "open" }),
        Bug.countDocuments({
          reportedBy: employee._id,
          status: "pending_approval",
        }),
        Bug.countDocuments({ reportedBy: employee._id, status: "resolved" }),
        Bug.aggregate([
          {
            $match: {
              reportedBy: employee._id,
              status: "resolved",
              approvedByReporter: true,
              rewardAdded: true,
            },
          },
          {
            $group: {
              _id: null,
              // Mirror the old client logic (`rewardAmount || 100`): fall back to
              // 100 when rewardAmount is missing or zero.
              total: {
                $sum: {
                  $cond: [{ $gt: ["$rewardAmount", 0] }, "$rewardAmount", 100],
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

    const bugStats = {
      totalBugs,
      openBugs,
      pendingBugs,
      resolvedBugs,
      // Total points earned from resolved + reporter-approved bugs, plus how
      // many such bugs — consumed directly by the Feedbacks dashboard.
      totalFromBugs: earningsAgg[0]?.total || 0,
      resolvedApprovedCount: earningsAgg[0]?.count || 0,
    };

    return res.json({
      status: "success",
      balance: employee.balance || 0,
      employee: {
        name: employee.name,
        companyEmail: employee.companyEmail,
        department: employee.department,
        owner: employee.owner
          ? {
              name: employee.owner.name,
              email: employee.owner.email,
            }
          : null,
      },
      bugStats,
    });
  } catch (err) {
    console.error("❌ Error fetching balance:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching balance",
    });
  }
};

// ---------------------
// GET OWNER DASHBOARD STATS
// ---------------------
exports.getOwnerDashboard = async (req, res) => {
  try {
    const employeeId = req.employee._id;

    // Get current employee's owner info
    const currentEmployee = await Employee.findById(employeeId)
      .select("owner")
      .populate("owner", "name email");

    if (!currentEmployee || !currentEmployee.owner) {
      return res.status(400).json({
        status: "error",
        message: "You are not an owner or don't own any employees",
      });
    }

    const ownerId = currentEmployee.owner._id;

    // Get all employees owned by this user
    const ownedEmployees = await Employee.find({ owner: ownerId, status: "active" })
      .select("name companyEmail department designation balance status")
      .sort({ balance: -1 });

    // Get bug statistics
    const ownedEmployeeIds = ownedEmployees.map((e) => e._id);

    const totalBugs = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
    });

    const openBugs = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "open",
    });

    const pendingBugs = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "pending_approval",
    });

    const resolvedBugs = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "resolved",
    });

    // Calculate total balance
    const totalBalance = ownedEmployees.reduce(
      (sum, emp) => sum + (emp.balance || 0),
      0
    );

    // Get recent bugs
    const recentBugs = await Bug.find({
      reportedBy: { $in: ownedEmployeeIds },
    })
      .populate({
        path: "reportedBy",
        select: "name department photographUrl",
        model: "Employee",
      })
      .sort({ createdAt: -1 })
      .limit(10);

    // Get top performers
    const topPerformers = ownedEmployees
      .filter((emp) => emp.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 5);

    return res.json({
      status: "success",
      owner: {
        name: currentEmployee.owner.name,
        email: currentEmployee.owner.email,
        id: ownerId,
      },
      dashboard: {
        totalEmployees: ownedEmployees.length,
        activeEmployees: ownedEmployees.filter((e) => e.status === "active")
          .length,
        totalBugBountyBalance: totalBalance,
        bugStatistics: {
          total: totalBugs,
          open: openBugs,
          pending_approval: pendingBugs,
          resolved: resolvedBugs,
        },
      },
      employees: ownedEmployees,
      topPerformers,
      recentBugs,
    });
  } catch (err) {
    console.error("❌ Error fetching owner dashboard:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching owner dashboard",
    });
  }
};

// ---------------------
// UPDATE EMPLOYEE BALANCE (Owner can update)
// ---------------------
exports.updateEmployeeBalance = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { amount, action, reason } = req.body; // action: 'add', 'subtract', 'set'
    const currentEmployeeId = req.employee._id;

    // Check if current user is owner of the employee
    const targetEmployee = await Employee.findById(employeeId).select(
      "owner name balance"
    );

    if (!targetEmployee) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    const currentEmployee = await Employee.findById(currentEmployeeId).select(
      "owner role"
    );

    // Check permissions: owner can update their employees' balance
    const isOwner =
      targetEmployee.owner &&
      targetEmployee.owner.toString() === currentEmployeeId.toString();

    const isAdmin = currentEmployee.role === "admin";
    const isRAndD =
      currentEmployee.department === "Research and Development" ||
      currentEmployee.department === "Research & Development";

    if (!isOwner && !isAdmin && !isRAndD) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to update this employee's balance",
      });
    }

    // Validate amount
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid amount. Must be a positive number",
      });
    }

    // Update balance based on action
    let newBalance = targetEmployee.balance || 0;
    let message = "";

    switch (action) {
      case "add":
        newBalance += numericAmount;
        message = `Added ${numericAmount} points to balance`;
        break;
      case "subtract":
        if (numericAmount > newBalance) {
          return res.status(400).json({
            status: "error",
            message: `Insufficient balance. Current balance: ${newBalance}`,
          });
        }
        newBalance -= numericAmount;
        message = `Subtracted ${numericAmount} points from balance`;
        break;
      case "set":
        newBalance = numericAmount;
        message = `Set balance to ${numericAmount} points`;
        break;
      default:
        return res.status(400).json({
          status: "error",
          message: "Invalid action. Must be: add, subtract, or set",
        });
    }

    // Update employee balance
    targetEmployee.balance = newBalance;
    await targetEmployee.save();

    return res.json({
      status: "success",
      message,
      employee: {
        name: targetEmployee.name,
        oldBalance:
          targetEmployee.balance -
          (action === "add"
            ? -numericAmount
            : action === "subtract"
            ? numericAmount
            : 0),
        newBalance: targetEmployee.balance,
        change: action === "set" ? "set" : `${action}ed ${numericAmount}`,
      },
    });
  } catch (err) {
    console.error("❌ Error updating employee balance:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while updating employee balance",
    });
  }
};

// ---------------------
// GET ALL EMPLOYEES WITH BALANCES (Admin/R&D/Owner)
// ---------------------
exports.getAllEmployeeBalances = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const currentEmployee = await Employee.findById(employeeId).select(
      "department role owner"
    );

    let query = {};
    let viewType = "all";

    // Determine view permissions
    if (
      currentEmployee.role === "admin" ||
      currentEmployee.department === "Research and Development" ||
      currentEmployee.department === "Research & Development"
    ) {
      // Admin/R&D can see all employees
      viewType = "all";
    } else if (currentEmployee.owner) {
      // Owner can see only their employees
      query.owner = currentEmployee.owner._id;
      viewType = "owner";
    } else {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to view employee balances",
      });
    }

    const employees = await Employee.find(query)
      .select("name companyEmail department designation balance status owner")
      .populate("owner", "name email")
      .sort({ balance: -1 });

    const totalRewards = employees.reduce(
      (sum, emp) => sum + (emp.balance || 0),
      0
    );
    const activeEmployees = employees.filter((emp) => emp.status === "active");

    return res.json({
      status: "success",
      viewType,
      totalEmployees: employees.length,
      activeEmployees: activeEmployees.length,
      totalRewardsDistributed: totalRewards,
      employees,
      statistics: {
        averageBalance:
          employees.length > 0 ? totalRewards / employees.length : 0,
        highestBalance: employees.length > 0 ? employees[0].balance : 0,
        lowestBalance:
          employees.length > 0 ? employees[employees.length - 1].balance : 0,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching employee balances:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching employee balances",
    });
  }
};

const addRewardToReporter = async (reporterId, rewardAmount = 100) => {
  try {
    const reporter = await Employee.findById(reporterId);
    if (!reporter) {
      console.error("Reporter not found for reward");
      return;
    }

    // Update balance
    reporter.balance += rewardAmount;
    await reporter.save();

    return reporter;
  } catch (error) {
    console.error("❌ Error adding reward:", error);
    throw error;
  }
};
