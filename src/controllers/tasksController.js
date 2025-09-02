const Task = require("../models/Task");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");

/**
 * Manager: list all clients under their owner (for the select dropdown)
 * GET /api/tasks/manager/clients
 */
exports.clientsForManager = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager") return res.status(403).json({ error: "Only Managers allowed" });

    const clients = await ClientInfo.find({ owner: me.owner })
      .select("_id clientName companyLocation industry assignedTo owner")
      .populate("assignedTo", "_id name companyEmail");

    res.json(clients);
  } catch (err) {
    console.error("clientsForManager error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Manager: create task for a client (auto-assign to client's assigned employee)
 * POST /api/tasks
 * body: { clientId, title, description?, priority?, dueDate? }
 */
exports.createTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager") return res.status(403).json({ error: "Only Managers can create tasks" });

    const { clientId, title, description, priority, dueDate } = req.body;
    if (!clientId || !title) return res.status(400).json({ error: "clientId and title are required" });

    const client = await ClientInfo.findById(clientId).select("_id owner assignedTo");
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (String(client.owner) !== String(me.owner)) {
      return res.status(403).json({ error: "Client does not belong to your owner" });
    }

    const task = await Task.create({
      owner: client.owner,
      client: client._id,
      createdBy: me._id,
      assignedTo: client.assignedTo || undefined,
      title,
      description: description || "",
      priority: priority || "medium",
      dueDate: dueDate ? new Date(dueDate) : undefined,
    });

    const populated = await Task.findById(task._id)
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");

    res.status(201).json(populated);
  } catch (err) {
    console.error("createTask error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
};

/**
 * Get tasks for a specific client
 * - Owner: client must belong to them
 * - Manager: client must belong to their owner
 * - Employee: only if they are assigned to that client
 * GET /api/tasks/client/:clientId
 */
exports.getTasksForClient = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const { clientId } = req.params;
    const client = await ClientInfo.findById(clientId).select("_id owner assignedTo");
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (me.role === "Owner") {
      if (String(client.owner) !== String(me._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (me.role === "Manager") {
      if (String(client.owner) !== String(me.owner)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      // Employee
      if (!client.assignedTo || String(client.assignedTo) !== String(me._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const tasks = await Task.find({ client: client._id })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail")
      .populate("client", "_id clientName");

    res.json(tasks);
  } catch (err) {
    console.error("getTasksForClient error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
};

/**
 * Employee: tasks assigned to me (for all my assigned clients)
 * GET /api/tasks/my
 */
exports.getMyTasks = async (req, res) => {
  try {
    const meId = req.employee._id;
    const tasks = await Task.find({ assignedTo: meId })
      .sort({ createdAt: -1 })
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");
    res.json(tasks);
  } catch (err) {
    console.error("getMyTasks error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Update a task (status/priority/dueDate/title/description)
 * - Manager (same owner) OR assigned employee can update
 * PATCH /api/tasks/:taskId
 */
exports.updateTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId).populate("client", "owner assignedTo");
    if (!task) return res.status(404).json({ error: "Task not found" });

    const isManagerSameOwner =
      me.role === "Manager" && String(task.client.owner) === String(me.owner);
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(me._id);

    if (!isManagerSameOwner && !isAssignee) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const allowed = ["status", "priority", "dueDate", "title", "description"];
    allowed.forEach((k) => {
      if (k in req.body) {
        task[k] = k === "dueDate" && req.body[k] ? new Date(req.body[k]) : req.body[k];
      }
    });

    await task.save();
    const populated = await Task.findById(task._id)
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");

    res.json(populated);
  } catch (err) {
    console.error("updateTask error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
};

/**
 * Delete task – Manager (same owner) only
 * DELETE /api/tasks/:taskId
 */
exports.deleteTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId).populate("client", "owner");
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (!(me.role === "Manager" && String(task.client.owner) === String(me.owner))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await Task.deleteOne({ _id: task._id });
    res.json({ success: true });
  } catch (err) {
    console.error("deleteTask error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
};
