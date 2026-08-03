const mongoose = require("mongoose");
const OnboardingTask = require("../models/OnboardingTask");
const Employee = require("../models/Employees");

const EMP_FIELDS =
  "name companyEmail email designation department subDepartment photographUrl employeeId joiningDate status";

/**
 * Raise the "new employee onboarded under you" task for a senior and push it to
 * their dashboard in real time.
 *
 * Safe to call more than once for the same pair — the unique index makes it an
 * upsert, and an already-completed task is re-opened only if `reopen` is set.
 *
 * @param {Object} opts
 * @param {string} opts.ownerId
 * @param {string} opts.seniorId    the senior in the hierarchy (who must act)
 * @param {Object} opts.employee    the newly onboarded employee document
 * @param {Object} [opts.io]        Socket.IO server, when available
 */
async function createOnboardingAssignmentTask({
  ownerId,
  seniorId,
  employee,
  io,
}) {
  if (!ownerId || !seniorId || !employee?._id) {
    throw new Error("ownerId, seniorId and employee are required");
  }

  if (String(seniorId) === String(employee._id)) {
    throw new Error("An employee cannot be their own senior");
  }

  const employeeName = employee.name || "A new employee";
  const where = [employee.department, employee.subDepartment]
    .filter(Boolean)
    .join(" / ");

  const task = await OnboardingTask.findOneAndUpdate(
    {
      owner: ownerId,
      senior: seniorId,
      employee: employee._id,
      type: "assign-clients-projects",
    },
    {
      $set: {
        title: `${employeeName} joined your team`,
        note: `${employeeName}${employee.designation ? ` (${employee.designation})` : ""}${
          where ? ` — ${where}` : ""
        } has been onboarded under you. Add them to the clients and projects they should work on.`,
      },
      $setOnInsert: { status: "pending" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (io) {
    // Refresh the Things-to-do widget for everyone in the company…
    io.to(`things_to_do_${ownerId}`).emit("things_to_do_updated", {
      changedAt: new Date().toISOString(),
    });
    // …and give the senior a direct, toast-able event.
    io.to(`employee_${seniorId}`).emit("onboarding_task_new", {
      taskId: String(task._id),
      type: task.type,
      title: task.title,
      note: task.note,
      employee: {
        _id: String(employee._id),
        name: employeeName,
        designation: employee.designation || null,
        department: employee.department || null,
      },
      createdAt: task.createdAt,
    });
  }

  return task;
}

/**
 * Same task, but the senior is looked up from the org hierarchy instead of being
 * passed in — used by flows that only know the employee (e.g. the offer
 * acceptance handler in watcher.js).
 *
 * @returns the task, or null when the employee has no senior yet.
 */
async function notifySeniorOfOnboarding({ employee, ownerId, io }) {
  const OrgHierarchy = require("../models/OrgHierarchy");

  const emp =
    employee && employee._id ? employee : await Employee.findById(employee);
  if (!emp) return null;

  const owner = ownerId || (Array.isArray(emp.owner) ? emp.owner[0] : emp.owner);
  if (!owner) return null;

  const link = await OrgHierarchy.findOne({ owner, junior: emp._id })
    .select("senior")
    .lean();

  if (!link?.senior) return null;

  return createOnboardingAssignmentTask({
    ownerId: owner,
    seniorId: link.senior,
    employee: emp,
    io,
  });
}

/* ------------------------------- Endpoints ------------------------------- */

// GET /api/onboarding-tasks?status=pending
// Tasks assigned to the logged-in employee (as senior).
exports.getMyOnboardingTasks = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const status = req.query.status || "pending";
    const query = { senior: employeeId };
    if (status !== "all") query.status = status;

    const tasks = await OnboardingTask.find(query)
      .populate("employee", EMP_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    // An employee removed/offboarded after the task was raised leaves nothing to do.
    const data = tasks.filter(
      (t) =>
        t.employee &&
        !["offboarded", "terminated"].includes(t.employee.status)
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error("Fetch onboarding tasks error:", err);
    res.status(500).json({ message: "Failed to fetch onboarding tasks" });
  }
};

// PUT /api/onboarding-tasks/:id/done — the senior marks it handled
exports.completeOnboardingTask = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid task id" });
    }

    const task = await OnboardingTask.findOneAndUpdate(
      { _id: id, senior: employeeId },
      {
        $set: {
          status: "done",
          completedAt: new Date(),
          completedBy: employeeId,
        },
      },
      { new: true }
    );

    if (!task) return res.status(404).json({ message: "Task not found" });

    const io = req.app.get("io");
    if (io) {
      io.to(`things_to_do_${task.owner}`).emit("things_to_do_updated", {
        changedAt: new Date().toISOString(),
      });
    }

    res.json({ success: true, data: task });
  } catch (err) {
    console.error("Complete onboarding task error:", err);
    res.status(500).json({ message: "Failed to update onboarding task" });
  }
};

exports.createOnboardingAssignmentTask = createOnboardingAssignmentTask;
exports.notifySeniorOfOnboarding = notifySeniorOfOnboarding;
