// controllers/bugController.js
const Bug = require("../models/Bug");
const Employee = require("../models/Employees");
const fs = require("fs");
const User = require("../models/Users");
const path = require("path");

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

    // Fetch employee to get department and owner
    const emp = await Employee.findById(req.employee._id).select(
      "department owner"
    );
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
      select: "name companyEmail department balance owner",
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
// GET BUGS - UPDATED WITH OWNER FILTERING
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
      viewType = "employee", // 'employee', 'owner', or 'all'
    } = req.query;

    const employeeId = req.employee._id;
    const emp = await Employee.findById(employeeId)
      .select("department owner role")
      .populate("owner", "name email");

    if (!emp) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    let query = {};
    let showOwnerBugs = false;

    // Determine view type
    if (viewType === "owner" && emp.owner) {
      // If user wants to see bugs of all employees they own
      showOwnerBugs = true;

      // Get all employees owned by this user
      const ownedEmployees = await Employee.find({
        owner: emp.owner._id,
      }).select("_id");

      const ownedEmployeeIds = ownedEmployees.map((e) => e._id);

      query.reportedBy = { $in: ownedEmployeeIds };
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
      // No specific query - show all
    } else {
      // Default: employee sees their own bugs
      // R&D sees all bugs
      if (
        emp.department === "Research & Development" ||
        emp.department === "Research and Development" ||
        emp.role === "admin"
      ) {
        // R&D/Admin sees all bugs in employee view
      } else {
        query.reportedBy = employeeId;
      }
    }

    // Apply filters
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
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Execute query
    const bugs = await Bug.find(query)
      .populate({
        path: "reportedBy",
        select: "name companyEmail department balance owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count
    const total = await Bug.countDocuments(query);

    // Get statistics
    const statusCounts = {
      open: await Bug.countDocuments({ ...query, status: "open" }),
      pending_approval: await Bug.countDocuments({
        ...query,
        status: "pending_approval",
      }),
      resolved: await Bug.countDocuments({ ...query, status: "resolved" }),
      total: total,
    };

    // Get owner statistics if viewing owner bugs
    let ownerStats = null;
    if (showOwnerBugs && emp.owner) {
      const ownedEmployees = await Employee.find({
        owner: emp.owner._id,
      }).select("name balance department");

      const totalBalance = ownedEmployees.reduce(
        (sum, emp) => sum + (emp.balance || 0),
        0
      );

      ownerStats = {
        ownerName: emp.owner.name,
        ownerEmail: emp.owner.email,
        totalEmployees: ownedEmployees.length,
        totalBugBountyBalance: totalBalance,
        employees: ownedEmployees.map((e) => ({
          name: e.name,
          department: e.department,
          balance: e.balance || 0,
        })),
      };
    }

    return res.json({
      status: "success",
      total,
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      statusCounts,
      ownerStats,
      viewType,
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
// controllers/bugController.js - Updated with pagination
exports.getBugsByOwner = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get current user's info
    const user = await User.findById(userId).select("name email role");

    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    // // Check if user has owner role or is admin
    // if (user.role !== "admin" && user.role !== "owner") {
    //   return res.status(403).json({
    //     status: "error",
    //     message: "You don't have permission to view owner bugs",
    //   });
    // }

    // Get all employees owned by this user
    const ownedEmployees = await Employee.find({ owner: userId }).select(
      "_id name companyEmail department balance"
    );

    if (!ownedEmployees || ownedEmployees.length === 0) {
      return res.status(200).json({
        status: "success",
        message: "No employees found for this owner",
        owner: {
          name: user.name,
          email: user.email,
          id: userId,
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

    // Get paginated bugs
    const bugs = await Bug.find(query)
      .populate({
        path: "reportedBy",
        select: "name companyEmail department balance",
        model: "Employee",
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Calculate statistics
    const totalBalance = ownedEmployees.reduce(
      (sum, emp) => sum + (emp.balance || 0),
      0
    );

    // Get bug counts for statistics
    const totalBugCount = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
    });
    const openBugCount = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "open",
    });
    const pendingBugCount = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "pending_approval",
    });
    const resolvedBugCount = await Bug.countDocuments({
      reportedBy: { $in: ownedEmployeeIds },
      status: "resolved",
    });

    const bugCounts = {
      total: totalBugCount,
      open: openBugCount,
      pending_approval: pendingBugCount,
      resolved: resolvedBugCount,
    };

    // Group bugs by employee
    const bugsByEmployee = {};
    ownedEmployees.forEach((emp) => {
      const employeeBugs = bugs.filter(
        (b) =>
          b.reportedBy &&
          b.reportedBy._id &&
          b.reportedBy._id.toString() === emp._id.toString()
      );

      bugsByEmployee[emp._id] = {
        employee: emp,
        bugs: employeeBugs,
        bugCount: employeeBugs.length,
      };
    });

    // Prepare employees with bugs data
    const employeesWithBugs = ownedEmployees
      .map((emp) => {
        const employeeBugCount = bugs.filter(
          (b) =>
            b.reportedBy &&
            b.reportedBy._id &&
            b.reportedBy._id.toString() === emp._id.toString()
        ).length;

        return {
          name: emp.name,
          department: emp.department,
          balance: emp.balance || 0,
          bugCount: employeeBugCount,
        };
      })
      .sort((a, b) => b.balance - a.balance);

    return res.json({
      status: "success",
      owner: {
        name: user.name,
        email: user.email,
        id: userId,
      },
      statistics: {
        totalEmployees: ownedEmployees.length,
        totalBugBountyBalance: totalBalance,
        bugCounts,
        employeesWithBugs,
      },
      bugs,
      totalBugs,
      totalPages,
      currentPage: page,
      bugsByEmployee,
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
      select: "name companyEmail department balance owner",
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
      select: "name companyEmail department balance owner",
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

// ---------------------
// RESOLVE BUG
// ---------------------
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

    // Reporter can resolve directly
    if (bug.reportedBy.toString() === employeeId.toString()) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;

      // Add reward if not already added
      if (!bug.rewardAdded) {
        await addRewardToReporter(bug.reportedBy);
        bug.rewardAdded = true;
      }

      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: "Bug resolved by reporter. Reward of 100 points added.",
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
      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance owner",
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
        await addRewardToReporter(bug.reportedBy);
        bug.rewardAdded = true;
      }

      await bug.save();

      await bug.populate({
        path: "reportedBy",
        select: "name companyEmail department balance owner",
        populate: {
          path: "owner",
          select: "name email",
        },
      });

      return res.json({
        status: "success",
        message: "Bug resolved by owner. Reward of 100 points added.",
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

// ---------------------
// APPROVE BUG
// ---------------------
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

    // Only reporter can approve
    if (bug.reportedBy.toString() !== employeeId.toString()) {
      return res.status(403).json({
        status: "error",
        message: "Only the original reporter can approve bug resolution",
      });
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

    // Add reward if not already added
    if (!bug.rewardAdded) {
      await addRewardToReporter(bug.reportedBy);
      bug.rewardAdded = true;
    }

    await bug.save();

    await bug.populate({
      path: "reportedBy",
      select: "name companyEmail department balance owner",
      populate: {
        path: "owner",
        select: "name email",
      },
    });

    return res.json({
      status: "success",
      message:
        "Bug approved and marked as resolved. Reward of 100 points added.",
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
      select: "name companyEmail department balance owner",
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

    // Get bug statistics for this employee
    const bugStats = {
      totalBugs: await Bug.countDocuments({ reportedBy: employee._id }),
      openBugs: await Bug.countDocuments({
        reportedBy: employee._id,
        status: "open",
      }),
      pendingBugs: await Bug.countDocuments({
        reportedBy: employee._id,
        status: "pending_approval",
      }),
      resolvedBugs: await Bug.countDocuments({
        reportedBy: employee._id,
        status: "resolved",
      }),
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
    const ownedEmployees = await Employee.find({ owner: ownerId })
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
        select: "name department",
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

    // Log the transaction (you might want to create a separate Transaction model)
    console.log(
      `Balance updated for ${targetEmployee.name}: ${message}. Reason: ${
        reason || "No reason provided"
      }`
    );

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

// ---------------------
// HELPER FUNCTION: Add Reward
// ---------------------
const addRewardToReporter = async (reporterId) => {
  try {
    const rewardAmount = 100;

    const reporter = await Employee.findById(reporterId);
    if (!reporter) {
      console.error("Reporter not found for reward");
      return;
    }

    // Update balance
    reporter.balance += rewardAmount;
    await reporter.save();

    console.log(
      `✅ Added ${rewardAmount} points to ${reporter.name}. New balance: ${reporter.balance}`
    );

    return reporter;
  } catch (error) {
    console.error("❌ Error adding reward:", error);
    throw error;
  }
};
