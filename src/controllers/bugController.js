const Bug = require("../models/Bug");
const Employee = require("../models/Employees");

// ---------------------
// CREATE BUG
// ---------------------
exports.createBug = async (req, res) => {
  try {
    const { title, description, priority } = req.body;

    if (!title || !description) {
      return res
        .status(400)
        .json({ status: "error", message: "Title and Description required" });
    }

    // Fetch employee to get department
    const emp = await Employee.findById(req.employee._id).select("department");

    if (!emp) {
      return res
        .status(404)
        .json({ status: "error", message: "Employee not found" });
    }

    const bug = await Bug.create({
      title,
      description,
      priority,
      reportedBy: req.employee._id,
      department: emp.department, // store department
    });

    return res.json({
      status: "success",
      message: "Bug reported successfully",
      bug,
    });
  } catch (err) {
    console.error("❌ Error creating bug:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
};

// ---------------------
// GET BUGS
// ---------------------
exports.getBugs = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("department");

    if (!emp) {
      return res
        .status(404)
        .json({ status: "error", message: "Employee not found" });
    }

    let bugs;

    if (emp.department === "Research and Development") {
      bugs = await Bug.find()
        .populate("reportedBy", "name companyEmail department")
        .sort({ createdAt: -1 }); // <<--- LATEST FIRST
    } else {
      bugs = await Bug.find({ reportedBy: req.employee._id })
        .populate("reportedBy", "name companyEmail department")
        .sort({ createdAt: -1 }); // <<--- LATEST FIRST
    }

    return res.json({
      status: "success",
      total: bugs.length,
      bugs,
    });
  } catch (err) {
    console.error("❌ Error fetching bugs:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
};
// ---------------------
// RESOLVE BUG
// ---------------------
exports.resolveBug = async (req, res) => {
  try {
    const { id } = req.params;

    const bug = await Bug.findById(id);
    if (!bug)
      return res.status(404).json({ status: "error", message: "Bug not found" });

    const emp = await Employee.findById(req.employee._id).select("department");

    // Reporter can resolve directly
    if (bug.reportedBy.toString() === req.employee._id.toString()) {
      bug.status = "resolved";
      bug.approvalRequired = false;
      bug.approvedByReporter = true;
      await bug.save();

      return res.json({
        status: "success",
        message: "Bug resolved by reporter",
        bug,
      });
    }

    // R&D department resolves → requires reporter approval
    if (emp.department === "Research and Development") {
      bug.status = "pending_approval";
      bug.approvalRequired = true;

      await bug.save();

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
    return res.status(500).json({ status: "error", message: "Server error" });
  }
};
exports.approveBug = async (req, res) => {
  try {
    const { id } = req.params;

    const bug = await Bug.findById(id);
    if (!bug)
      return res.status(404).json({ status: "error", message: "Bug not found" });

    // Only reporter can approve
    if (bug.reportedBy.toString() !== req.employee._id.toString()) {
      return res.status(403).json({
        status: "error",
        message: "Only the original reporter can approve",
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

    await bug.save();

    return res.json({
      status: "success",
      message: "Bug approved and marked as resolved",
      bug,
    });
  } catch (err) {
    console.error("❌ Error approving bug:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
};
exports.updatePriority = async (req, res) => {
  try {
    const { id } = req.params;
    const { priority } = req.body;

    if (!["low", "medium", "high"].includes(priority)) {
      return res.status(400).json({ status: "error", message: "Invalid priority value" });
    }

    const bug = await Bug.findById(id);
    if (!bug) return res.status(404).json({ message: "Bug not found" });

    bug.priority = priority;
    await bug.save();

    return res.json({ status: "success", message: "Priority updated", bug });
  } catch (err) {
    console.error("Priority update error:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
};
