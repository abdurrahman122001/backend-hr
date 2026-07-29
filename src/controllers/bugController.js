// controllers/bugController.js
const Bug = require("../models/Bug");
const Employee = require("../models/Employees");
const fs = require("fs");
const User = require("../models/Users");
const path = require("path");
const { hasFeedbackAccess } = require("../utils/feedbackAccess");

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

    // Create bug
    const bug = await Bug.create({
      title: title.trim(),
      description: description.trim(),
      priority: bugPriority,
      reportedBy: req.employee._id,
      department: emp.department,
      images: images,
      rewardAdded: false, // Initially no reward added
      // Note: Owner is not stored in Bug model, it's referenced through Employee
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
          .sort({ createdAt: -1 })
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
      .sort({ createdAt: -1 })
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
    const emp = await Employee.findById(employeeId).select("department role isAdmin");
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    const isRAndD =
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin";

    if (!isReporter && !isRAndD) {
      // Check if user is owner of reporter
      const reporter = await Employee.findById(bug.reportedBy).select("owner");
      if (!reporter || reporter.owner.toString() !== employeeId.toString()) {
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

    const emp = await Employee.findById(employeeId).select("department role");

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

    // R&D department resolves → requires reporter approval
    if (
      emp.department === "Research and Development" ||
      emp.department === "Research & Development" ||
      emp.role === "admin"
    ) {
      bug.status = "pending_approval";
      bug.approvalRequired = true;
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
    if (emp?.isAdmin === true) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;

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
    const isReporter = bug.reportedBy.toString() === employeeId.toString();
    if (!isReporter) {
      const approver = await Employee.findById(employeeId)
        .select("isAdmin role")
        .lean();
      const approverRole = String(approver?.role || "").toLowerCase();
      const isAdminApprover =
        approver?.isAdmin === true ||
        ["owner", "admin", "super-admin"].includes(approverRole);

      if (!isAdminApprover) {
        return res.status(403).json({
          status: "error",
          message: "Only the reporter or an admin can approve bug resolution",
        });
      }
    }

    if (!bug.approvalRequired) {
      return res.status(400).json({
        status: "error",
        message: "No approval required for this bug",
      });
    }

    bug.status = "resolved";
    bug.approvalRequired = false;
    bug.approvedByReporter = true;

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
