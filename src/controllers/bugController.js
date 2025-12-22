// controllers/bugController.js
const Bug = require("../models/Bug");
const Employee = require("../models/Employees");
const fs = require("fs");
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
    const bugPriority = validPriorities.includes(priority) ? priority : "medium";

    // Fetch employee to get department
    const emp = await Employee.findById(req.employee._id).select("department");
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
    });

    // Populate reporter info for response
    await bug.populate("reportedBy", "name companyEmail department balance");

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
// GET BUGS
// ---------------------
exports.getBugs = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("department");
    if (!emp) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    let bugs;

    // R&D can see all bugs, others only see their own
    if (emp.department === "Research & Development" || emp.department === "Research and Development") {
      bugs = await Bug.find()
        .populate("reportedBy", "name companyEmail department balance")
        .sort({ createdAt: -1 });
    } else {
      bugs = await Bug.find({ reportedBy: req.employee._id })
        .populate("reportedBy", "name companyEmail department balance")
        .sort({ createdAt: -1 });
    }

    return res.json({
      status: "success",
      total: bugs.length,
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

// ---------------------
// GET BUG BY ID
// ---------------------
exports.getBugById = async (req, res) => {
  try {
    const { id } = req.params;

    const bug = await Bug.findById(id).populate(
      "reportedBy",
      "name companyEmail department balance"
    );

    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check if user has permission to view this bug
    const emp = await Employee.findById(req.employee._id).select("department");
    if (
      emp.department !== "Research and Development" && 
      emp.department !== "Research & Development" &&
      bug.reportedBy._id.toString() !== req.employee._id.toString()
    ) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to view this bug",
      });
    }

    return res.json({
      status: "success",
      bug,
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

    // Check permissions - only reporter or R&D
    const emp = await Employee.findById(req.employee._id).select("department");
    const isReporter =
      bug.reportedBy.toString() === req.employee._id.toString();
    const isRAndD = emp?.department === "Research and Development" || emp?.department === "Research & Development";

    if (!isReporter && !isRAndD) {
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
    await bug.populate("reportedBy", "name companyEmail department balance");

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

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions - only reporter or R&D can delete images
    const emp = await Employee.findById(req.employee._id).select("department");
    const isReporter =
      bug.reportedBy.toString() === req.employee._id.toString();
    const isRAndD = emp.department === "Research and Development" || emp.department === "Research & Development";

    if (!isReporter && !isRAndD) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to delete images from this bug",
      });
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

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    const emp = await Employee.findById(req.employee._id).select("department");

    // Reporter can resolve directly
    if (bug.reportedBy.toString() === req.employee._id.toString()) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;
      
      // Add reward if not already added
      if (!bug.rewardAdded) {
        await addRewardToReporter(bug.reportedBy);
        bug.rewardAdded = true;
      }
      
      await bug.save();

      await bug.populate("reportedBy", "name companyEmail department balance");

      return res.json({
        status: "success",
        message: "Bug resolved by reporter. Reward of 100 points added.",
        bug,
      });
    }

    // R&D department resolves → requires reporter approval
    if (emp.department === "Research and Development" || emp.department === "Research & Development") {
      bug.status = "pending_approval";
      bug.approvalRequired = true;
      await bug.save();

      await bug.populate("reportedBy", "name companyEmail department balance");

      return res.json({
        status: "success",
        message: "Bug marked as pending approval by reporter",
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

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Only reporter can approve
    if (bug.reportedBy.toString() !== req.employee._id.toString()) {
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

    await bug.populate("reportedBy", "name companyEmail department balance");

    return res.json({
      status: "success",
      message: "Bug approved and marked as resolved. Reward of 100 points added.",
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

    // Check permissions - only reporter or R&D can update priority
    const emp = await Employee.findById(req.employee._id).select("department");
    const isReporter =
      bug.reportedBy.toString() === req.employee._id.toString();
    const isRAndD = emp.department === "Research and Development" || emp.department === "Research & Development";

    if (!isReporter && !isRAndD) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to update priority for this bug",
      });
    }

    bug.priority = priority;
    await bug.save();

    await bug.populate("reportedBy", "name companyEmail department balance");

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

    const bug = await Bug.findById(id);
    if (!bug) {
      return res.status(404).json({
        status: "error",
        message: "Bug not found",
      });
    }

    // Check permissions - only reporter or R&D can delete
    const emp = await Employee.findById(req.employee._id).select("department");
    const isReporter =
      bug.reportedBy.toString() === req.employee._id.toString();
    const isRAndD = emp.department === "Research and Development" || emp.department === "Research & Development";

    if (!isReporter && !isRAndD) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to delete this bug",
      });
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
    
    console.log(`✅ Added ${rewardAmount} points to ${reporter.name}. New balance: ${reporter.balance}`);
    
    return reporter;
  } catch (error) {
    console.error("❌ Error adding reward:", error);
    throw error;
  }
};

// ---------------------
// GET EMPLOYEE BALANCE
// ---------------------
exports.getEmployeeBalance = async (req, res) => {
  try {
    const employee = await Employee.findById(req.employee._id).select("name companyEmail department balance");
    
    if (!employee) {
      return res.status(404).json({
        status: "error",
        message: "Employee not found",
      });
    }

    return res.json({
      status: "success",
      balance: employee.balance,
      employee: {
        name: employee.name,
        companyEmail: employee.companyEmail,
        department: employee.department,
      },
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
// GET ALL EMPLOYEES WITH BALANCES (Admin/R&D only)
// ---------------------
exports.getAllEmployeeBalances = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("department");
    
    // Only R&D can see all balances
    if (emp.department !== "Research and Development" && emp.department !== "Research & Development") {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to view all employee balances",
      });
    }

    const employees = await Employee.find()
      .select("name companyEmail department designation balance")
      .sort({ balance: -1 }); // Sort by highest balance first

    const totalRewards = employees.reduce((sum, emp) => sum + emp.balance, 0);

    return res.json({
      status: "success",
      totalEmployees: employees.length,
      totalRewardsDistributed: totalRewards,
      employees,
    });
  } catch (err) {
    console.error("❌ Error fetching employee balances:", err);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching employee balances",
    });
  }
};