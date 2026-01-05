const Workspace = require("../models/Workspace");
const TaskSpace = require("../models/TaskSpace");
const Employee = require("../models/Employees");

/* =========================
   WORKSPACES
========================= */

// Create
exports.createWorkspace = async (req, res) => {
  const workspace = await Workspace.create({
    owner: req.user._id,
    name: req.body.name,
    description: req.body.description || "",
    members: [],
  });

  res.status(201).json(workspace);
};

// Read
exports.getWorkspaces = async (req, res) => {
  const workspaces = await Workspace.find({ owner: req.user._id });
  res.json(workspaces);
};

// Update
exports.updateWorkspace = async (req, res) => {
  const { id } = req.params;

  const workspace = await Workspace.findOneAndUpdate(
    { _id: id, owner: req.user._id },
    { $set: req.body },
    { new: true }
  );

  res.json(workspace);
};

// Delete
exports.deleteWorkspace = async (req, res) => {
  const { id } = req.params;

  await Workspace.deleteOne({ _id: id, owner: req.user._id });
  await TaskSpace.deleteMany({ workspace: id, owner: req.user._id });

  res.json({ message: "Workspace deleted" });
};

// Add / Remove member
exports.updateWorkspaceMember = async (req, res) => {
  const { workspaceId, employeeId, action } = req.body;

  const update =
    action === "add"
      ? { $addToSet: { members: { employee: employeeId, role: "member" } } }
      : { $pull: { members: { employee: employeeId } } };

  await Workspace.updateOne(
    { _id: workspaceId, owner: req.user._id },
    update
  );

  res.json({ message: "Workspace members updated" });
};

/* =========================
   SPACES
========================= */

// Create
exports.createSpace = async (req, res) => {
  const space = await TaskSpace.create({
    owner: req.user._id,
    workspace: req.body.workspaceId,
    name: req.body.name,
    visibleTo: [],
  });

  res.status(201).json(space);
};

// Read
exports.getSpaces = async (req, res) => {
  const spaces = await TaskSpace.find({
    owner: req.user._id,
    workspace: req.params.workspaceId,
  });

  res.json(spaces);
};

// Update
exports.updateSpace = async (req, res) => {
  const { id } = req.params;

  const space = await TaskSpace.findOneAndUpdate(
    { _id: id, owner: req.user._id },
    { $set: req.body },
    { new: true }
  );

  res.json(space);
};

// Delete
exports.deleteSpace = async (req, res) => {
  const { id } = req.params;

  await TaskSpace.deleteOne({ _id: id, owner: req.user._id });
  res.json({ message: "Space deleted" });
};

// Visibility
exports.updateSpaceVisibility = async (req, res) => {
  const { spaceId, employeeIds } = req.body;

  await TaskSpace.updateOne(
    { _id: spaceId, owner: req.user._id },
    { $set: { visibleTo: employeeIds } }
  );

  res.json({ message: "Visibility updated" });
};

// Employees
exports.getEmployees = async (req, res) => {
  const employees = await Employee.find({
    owner: req.user._id,
    isTrashed: false,
  }).select("_id name email");

  res.json(employees);
};
