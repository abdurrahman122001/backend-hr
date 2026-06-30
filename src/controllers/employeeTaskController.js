// controllers/workspaceController.js
const Workspace = require("../models/Workspace");
const TaskSpace = require("../models/TaskSpace");
const Task = require("../models/Task");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");
const TASK_STATUSES = ["pending", "in_progress", "review_approved", "closed"];
const normalizeTaskStatus = (status) => {
  switch (String(status || "").toLowerCase()) {
    case "in_progress":
      return "in_progress";
    case "review_approved":
    case "pending_review":
    case "review":
      return "review_approved";
    case "closed":
    case "complete":
    case "done":
      return "closed";
    case "pending":
    case "todo":
    default:
      return "pending";
  }
};


/* =========================
   ADMIN ACCESS HELPERS
   Admins (isAdmin employees or admin/HR users) bypass membership and
   space-visibility restrictions and can see/manage every workspace, space and
   task within their company (still scoped by owner). Regular employees remain
   restricted to workspaces they belong to and spaces shared with them.
========================= */

// Workspace membership clause — empty for admins so they match every workspace.
function workspaceMemberClause(req) {
  return req.employee.isAdmin ? {} : { "members.employee": req.employee._id };
}

// Space visibility clause — empty for admins so they match every space.
function spaceVisibilityClause(req) {
  return req.employee.isAdmin
    ? {}
    : { $or: [{ visibleTo: req.employee._id }, { visibleTo: { $size: 0 } }] };
}

/* =========================
   WORKSPACES
========================= */

exports.getMyWorkspaces = async (req, res) => {
  try {
    // Admins are auto-enrolled as a member of every company workspace, so they
    // show up as an assignable member of every space without manual adding.
    if (req.employee.isAdmin) {
      await Workspace.updateMany(
        {
          owner: req.employee.owner,
          "members.employee": { $ne: req.employee._id },
        },
        {
          $push: { members: { employee: req.employee._id, role: "admin" } },
        }
      );
    }

    const workspaces = await Workspace.find({
      owner: req.employee.owner,
      ...workspaceMemberClause(req),
      isArchived: false,
    }).select("_id name");

    res.json(workspaces);
  } catch (err) {
    console.error("getMyWorkspaces:", err);
    res.status(500).json({ message: "Failed to load workspaces" });
  }
};

/* =========================
   SPACES
========================= */

exports.getMySpaces = async (req, res) => {
  const { workspaceId } = req.params;

  try {
    // First verify workspace access
    const workspace = await Workspace.findOne({
      _id: workspaceId,
      owner: req.employee.owner,
      ...workspaceMemberClause(req),
    });

    if (!workspace) {
      return res.status(403).json({ message: "Access denied to workspace" });
    }

    // Get spaces visible to the employee in this workspace (admins see all)
    const spaces = await TaskSpace.find({
      workspace: workspaceId,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
      isArchived: false,
    }).select("_id name status isArchived createdAt updatedAt");

    res.json(spaces);
  } catch (err) {
    console.error("getMySpaces:", err);
    res.status(500).json({ message: "Failed to load spaces" });
  }
};

/* =========================
   TASKS
========================= */

// Get tasks in a space
exports.getMyTasks = async (req, res) => {
  const { spaceId } = req.params;

  try {
    // Verify space access
    const space = await TaskSpace.findOne({
      _id: spaceId,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
      isArchived: false,
    });

    if (!space) {
      return res.status(403).json({ message: "Access denied to space" });
    }

    // Get tasks in this space
    const tasks = await Task.find({
      space: spaceId,
      owner: req.employee.owner,
      workspace: space.workspace,
    })
      .populate("assignees", "name companyEmail avatar photographUrl photoUrl")
      .populate("createdBy", "name companyEmail")
      .sort({ createdAt: -1 });

    res.json(tasks);
  } catch (err) {
    console.error("getMyTasks:", err);
    res.status(500).json({ message: "Failed to load tasks" });
  }
};

// Create a new task
exports.createTask = async (req, res) => {
  const { spaceId, title, description, priority, assignees, status, dueDate } =
    req.body;

  try {
    if (!req.employee || !req.employee.owner) {
      return res.status(400).json({
        message: "Employee or owner context missing",
      });
    }

    // Verify space access
    const space = await TaskSpace.findOne({
      _id: spaceId,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
      isArchived: false,
    });

    if (!space) {
      return res.status(403).json({
        message: "No access to this space",
      });
    }

    // Validate assignees if provided
    let taskAssignees = [];
    if (assignees && Array.isArray(assignees) && assignees.length > 0) {
      // Check if all assignees are in the workspace
      const workspaceMembers = await Workspace.findOne({
        _id: space.workspace,
        owner: req.employee.owner,
      }).select("members.employee");

      if (!workspaceMembers) {
        return res.status(404).json({
          message: "Workspace not found",
        });
      }

      const memberIds = workspaceMembers.members.map((m) =>
        m.employee.toString()
      );

      // Verify all assignees are workspace members
      const invalidAssignees = assignees.filter(
        (assigneeId) => !memberIds.includes(assigneeId.toString())
      );

      if (invalidAssignees.length > 0) {
        return res.status(403).json({
          message: "Some assignees are not workspace members",
        });
      }

      taskAssignees = assignees;
    } else {
      // Default to current employee if no assignees specified
      taskAssignees = [req.employee._id];
    }

    // Create the task using Task model
    const task = await Task.create({
      owner: req.employee.owner,
      workspace: space.workspace,
      space: spaceId,
      title,
      description,
      priority: priority || "medium",
      status: normalizeTaskStatus(status),
      assignees: taskAssignees,
      createdBy: req.employee._id,
      dueDate: dueDate || null,
    });

    // Populate the response
    const populatedTask = await Task.findById(task._id)
      .populate("assignees", "name companyEmail avatar photographUrl photoUrl")
      .populate("createdBy", "name companyEmail");

    res.status(201).json(populatedTask);
  } catch (err) {
    console.error("createTask:", err);
    res.status(500).json({
      message: "Failed to create task",
      error: err.message,
    });
  }
};

exports.updateTaskAssignee = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { assignedTo, assignees } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ error: "Invalid task ID" });
    }

    // 1️⃣ Find task (no restrictions)
    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    // 2️⃣ Normalize assignees
    let newAssignees = [];

    if (Array.isArray(assignees)) {
      newAssignees = assignees;
    } else if (assignedTo !== undefined) {
      newAssignees = assignedTo ? [assignedTo] : [];
    }

    // 3️⃣ Validate employees exist (ONLY existence, no permission)
    if (newAssignees.length > 0) {
      const count = await Employee.countDocuments({
        _id: { $in: newAssignees },
      });

      if (count !== newAssignees.length) {
        return res.status(400).json({
          error: "One or more assignees not found",
        });
      }
    }

    // 4️⃣ Update assignees
    task.assignees = newAssignees;
    await task.save();

    // 5️⃣ Populate response
    await task.populate({
      path: "assignees",
      select: "_id name companyEmail avatar photographUrl photoUrl",
    });

    res.json({
      message: "Task assignees updated successfully",
      task: {
        _id: task._id,
        assignees: task.assignees,
        assignedTo: task.assignees[0] || null,
        updatedAt: task.updatedAt,
      },
    });
  } catch (error) {
    console.error("Update task assignee error:", error);
    res.status(500).json({ error: "Failed to update task assignees" });
  }
};

// Get employees available for a space (workspace members)
exports.getEmployeesForSpace = async (req, res) => {
  const { spaceId } = req.params;

  try {
    // 1. Check space access - More flexible query
    const space = await TaskSpace.findOne({
      _id: spaceId,
      owner: req.employee.owner,
    });

    if (!space) {
      return res.status(403).json({
        message: "Space not found or access denied",
      });
    }

    // 2. Get workspace members - More robust population
    const workspace = await Workspace.findOne({
      _id: space.workspace,
      owner: req.employee.owner,
    }).populate({
      path: "members.employee",
      select: "_id name companyEmail avatar photographUrl photoUrl isActive status",
      model: "Employee",
    });

    if (!workspace) {
      return res.status(404).json({
        message: "Workspace not found",
      });
    }
    // 3. Filter active employees - Handle null employee references
    const activeEmployees = workspace.members
      .filter((member) => {
        // Check if employee exists and is active
        return (
          member.employee &&
          member.employee.isActive !== false &&
          member.employee.status === "active"
        );
      })
      .map((member) => member.employee);

    // If still no employees, check direct employee access
    if (activeEmployees.length === 0) {
      const allEmployees = await Employee.find({
        owner: req.employee.owner,
        isActive: true,
        status: "active",
      }).select("_id name companyEmail avatar photographUrl photoUrl isActive status");

      return res.json(allEmployees);
    }

    res.json(activeEmployees);
  } catch (err) {
    console.error("getEmployeesForSpace error:", err);
    res.status(500).json({
      message: "Failed to load employees for space",
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// Update task details
exports.updateTask = async (req, res) => {
  const { taskId } = req.params;
  const { status, title, description, priority, dueDate } = req.body;

  // Allowed statuses (from Task model)
  const ALLOWED_STATUSES = TASK_STATUSES;

  try {
    // Find the task
    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Check if user has access to the task's space
    const space = await TaskSpace.findOne({
      _id: task.space,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
    });

    if (!space) {
      return res.status(403).json({ message: "No access to this task" });
    }

    // Update fields if provided
    if (status !== undefined) {
      const normalizedStatus = normalizeTaskStatus(status);
      if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({
          message:
            "Invalid task status. Allowed: pending, in_progress, review_approved, closed",
        });
      }
      task.status = normalizedStatus;
    }

    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (priority !== undefined) {
      if (!["low", "medium", "high", "urgent"].includes(priority)) {
        return res.status(400).json({
          message: "Invalid priority. Allowed: low, medium, high, urgent",
        });
      }
      task.priority = priority;
    }
    if (dueDate !== undefined) {
      task.dueDate =
        dueDate === "" || dueDate === null ? null : new Date(dueDate);
    }

    await task.save();

    // Get updated task with populated fields
    const updatedTask = await Task.findById(task._id)
      .populate("assignees", "name companyEmail avatar photographUrl photoUrl")
      .populate("createdBy", "name companyEmail");

    res.json({
      message: "Task updated successfully",
      task: updatedTask,
    });
  } catch (err) {
    console.error("updateTask:", err);
    res.status(500).json({
      message: "Failed to update task",
      error: err.message,
    });
  }
};

// Delete task (soft delete by archiving)
exports.deleteTask = async (req, res) => {
  const { taskId } = req.params;

  try {
    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Check if user has access to the task's space
    const space = await TaskSpace.findOne({
      _id: task.space,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
    });

    if (!space) {
      return res.status(403).json({ message: "No access to this task" });
    }

    // Note: The Task model doesn't have isArchived field.
    // You can either add it to the Task model or do a hard delete.
    // For now, I'll do a hard delete since the model doesn't have isArchived.

    await Task.deleteOne({ _id: taskId });

    res.json({
      message: "Task deleted successfully",
    });
  } catch (err) {
    console.error("deleteTask:", err);
    res.status(500).json({
      message: "Failed to delete task",
      error: err.message,
    });
  }
};

// Get task statistics for dashboard
exports.getTaskStats = async (req, res) => {
  const { spaceId } = req.params;

  try {
    // Verify space access
    const space = await TaskSpace.findOne({
      _id: spaceId,
      owner: req.employee.owner,
      ...spaceVisibilityClause(req),
      isArchived: false,
    });

    if (!space) {
      return res.status(403).json({ message: "Access denied to space" });
    }

    // Get task statistics
    const stats = await Task.aggregate([
      {
        $match: {
          space: space._id,
          owner: req.employee.owner,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Format the stats
    const formattedStats = {
      pending: 0,
      in_progress: 0,
      review_approved: 0,
      closed: 0,
      total: 0,
    };

    stats.forEach((stat) => {
      if (stat._id in formattedStats) {
        formattedStats[stat._id] = stat.count;
        formattedStats.total += stat.count;
      }
    });

    res.json(formattedStats);
  } catch (err) {
    console.error("getTaskStats:", err);
    res.status(500).json({
      message: "Failed to load task statistics",
      error: err.message,
    });
  }
};

// Create a new space
exports.createSpace = async (req, res) => {
  const { workspaceId, name, visibleTo } = req.body;

  try {
    // Verify workspace access (admins can add spaces to any workspace)
    const workspace = await Workspace.findOne({
      _id: workspaceId,
      owner: req.employee.owner,
      ...workspaceMemberClause(req),
    });

    if (!workspace) {
      return res.status(403).json({ message: "Access denied to workspace" });
    }

    // Create the space
    const space = await TaskSpace.create({
      owner: req.employee.owner,
      workspace: workspaceId,
      name,
      visibleTo: visibleTo || [],
      status: "pending",
      isArchived: false,
    });

    res.status(201).json({
      message: "Space created successfully",
      space: {
        _id: space._id,
        name: space.name,
        status: space.status,
        createdAt: space.createdAt,
      },
    });
  } catch (err) {
    console.error("createSpace:", err);
    res.status(500).json({
      message: "Failed to create space",
      error: err.message,
    });
  }
};

