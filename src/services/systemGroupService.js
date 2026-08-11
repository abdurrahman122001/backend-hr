// System-owned Google-Chat groups: the ones the company gets for free rather
// than someone creating them.
//
//   company group    — every active employee of the org, nobody can leave.
//   department group — one per department, holding that department's active
//                      employees and nobody else by default.
//
// Both are ordinary Space documents of kind "group" (same messaging, threads,
// tasks and realtime as any group) marked with `systemGroup` so they can be
// found again and kept in step. Admins add extra participants through the
// normal group UI; anyone added that way is NOT recorded in
// `systemGroup.autoMembers`, which is what stops a later department change or
// re-sync from evicting them.
//
// Entry points:
//   syncSystemGroupsForEmployee — one employee became active / changed
//                                 department (called from the Employee model
//                                 hooks, so it catches every code path).
//   syncSystemGroupsForOwner    — whole org at once (backfill script).
//
// Fire-and-safe: a failure here is logged and swallowed. Onboarding must never
// fail because a chat group could not be created.
const mongoose = require("mongoose");

const isObjId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

// The company group has no department name to key on.
const COMPANY_KEY = "__company__";
// Department names are free text on the Employee record ("Software Department"
// vs "software department"), so the key is normalised and the display name is
// whatever the first employee spelled.
const departmentKey = (name) => String(name || "").trim().toLowerCase();

const emitSpaceCreated = (io, memberIds, space, conversation, createdBy) => {
  if (!io) return;
  const payload = { space, conversation, createdBy: String(createdBy) };
  memberIds.forEach((memberId) => {
    io.to(`employee_${memberId}`).emit("space_created", payload);
    io.to(`user_${memberId}`).emit("space_created", payload);
  });
};

/**
 * Space.createdBy is required and these groups have no human author, so the
 * company's admins own them: the first active `isAdmin` employee is the owner
 * and every active admin is a space admin, which is what lets them add extra
 * participants to a group nobody created by hand. Falls back to the employee
 * being onboarded only when the org has no admin at all.
 */
async function resolveGroupAdmins(ownerId, fallbackId) {
  const Employee = require("../models/Employees");
  const admins = await Employee.find({
    owner: ownerId,
    status: "active",
    isAdmin: true,
  })
    .select("_id")
    .sort({ createdAt: 1 })
    .lean();

  const adminIds = admins.map((a) => String(a._id));
  return {
    creatorId: adminIds[0] || (fallbackId ? String(fallbackId) : null),
    adminIds,
  };
}

async function resolveCompanyName(ownerId) {
  try {
    const CompanyProfile = require("../models/CompanyProfile");
    const profile = await CompanyProfile.findOne({ owner: ownerId })
      .select("name")
      .lean();
    return String(profile?.name || "").trim();
  } catch (e) {
    return "";
  }
}

/**
 * Create the group if it doesn't exist yet, then top up its membership.
 * Additive only — nobody is ever removed from here.
 */
async function ensureSystemGroup({
  ownerId,
  role,
  key,
  name,
  description,
  emoji,
  memberIds,
  creatorId,
  adminIds = [],
  // Department groups exist for every department on the books, so one with no
  // staff yet is still created — it just holds the admins until its first hire.
  allowEmpty = false,
  io,
}) {
  const { Space, Conversation } = require("../models/Chat");

  // The company's admins are in every system group and run it. They are NOT
  // recorded as auto-members of a department they don't belong to, so they can
  // still step out of one; the department's own people cannot.
  const admins = [...new Set(adminIds.map(String))].filter(isObjId);
  const desired = [...new Set((memberIds || []).map(String))].filter(isObjId);
  let space = await Space.findOne({
    "systemGroup.owner": ownerId,
    "systemGroup.role": role,
    "systemGroup.key": key,
  });

  if (!space) {
    // A group with nobody in it at all would have no creator and no one to see
    // it. An empty DEPARTMENT group is still fine — the admins are in it.
    const createdBy = creatorId && isObjId(creatorId) ? creatorId : desired[0];
    if (desired.length === 0 && !(allowEmpty && isObjId(createdBy))) return null;

    space = new Space({
      name,
      kind: "group",
      description,
      emoji,
      createdBy,
      admins: [...new Set([String(createdBy), ...admins])],
      members: [...new Set([String(createdBy), ...admins, ...desired])],
      // Nobody can wander in from Browse spaces: a department group is for its
      // department, and the company group already holds everyone.
      isPrivate: true,
      systemGroup: { role, owner: ownerId, key, autoMembers: desired },
    });
    await space.save();

    // Without the linked conversation the group has no unread tracking and
    // messaging breaks (getSpaces / sendSpaceMessage both key off it).
    const conversation = new Conversation({
      participants: space.members,
      isGroup: true,
      groupName: space.name,
      groupDescription: space.description,
      admins: [createdBy],
      unreadCount: new Map(),
      space: space._id,
    });
    await conversation.save();

    emitSpaceCreated(io, space.members.map(String), space, conversation, createdBy);
    return space;
  }

  const existing = new Set((space.members || []).map(String));
  // A newly promoted admin joins the group's admin roster on the next sync.
  const existingAdmins = new Set((space.admins || []).map(String));
  const missingAdmins = admins.filter((id) => !existingAdmins.has(id));
  const missing = [...new Set([...desired, ...admins])].filter(
    (id) => !existing.has(id)
  );
  const existingAuto = new Set((space.systemGroup?.autoMembers || []).map(String));
  const missingAuto = desired.filter((id) => !existingAuto.has(id));

  if (
    missing.length === 0 &&
    missingAuto.length === 0 &&
    missingAdmins.length === 0
  )
    return space;

  await Space.updateOne(
    { _id: space._id },
    {
      $addToSet: {
        members: { $each: missing },
        admins: { $each: missingAdmins },
        "systemGroup.autoMembers": { $each: missingAuto },
      },
    }
  );
  if (missing.length > 0) {
    await Conversation.updateOne(
      { space: space._id, isGroup: true },
      { $addToSet: { participants: { $each: missing } } }
    );

    if (io) {
      const [populatedSpace, populatedConversation] = await Promise.all([
        Space.findById(space._id)
          .populate("createdBy", "name companyEmail avatar")
          .populate("members", "name companyEmail avatar"),
        Conversation.findOne({ space: space._id, isGroup: true }),
      ]);
      emitSpaceCreated(
        io,
        missing,
        populatedSpace,
        populatedConversation,
        space.createdBy
      );
      missing.forEach((memberId) =>
        io.to(`employee_${memberId}`).emit("added_to_space", {
          space: populatedSpace,
          addedBy: space.createdBy,
          addedAt: new Date(),
        })
      );
      io.to(`space_${space._id}`).emit("space_members_updated", {
        spaceId: String(space._id),
        newMembers: missing,
        updatedBy: space.createdBy,
        updatedAt: new Date(),
      });
    }
  }

  return space;
}

/**
 * Someone moved department: take them out of the department groups they no
 * longer belong to. Only auto-members are pulled — an admin who deliberately
 * added them to another department's group keeps them there.
 */
async function leaveOtherDepartmentGroups({ ownerId, employeeId, keepKey, io }) {
  const { Space, Conversation } = require("../models/Chat");
  const id = String(employeeId);

  const stale = await Space.find({
    "systemGroup.owner": ownerId,
    "systemGroup.role": "department",
    "systemGroup.autoMembers": employeeId,
    ...(keepKey ? { "systemGroup.key": { $ne: keepKey } } : {}),
  })
    .select("_id")
    .lean();
  if (stale.length === 0) return;

  const staleIds = stale.map((s) => s._id);
  await Space.updateMany(
    { _id: { $in: staleIds } },
    {
      $pull: {
        members: employeeId,
        admins: employeeId,
        "systemGroup.autoMembers": employeeId,
      },
    }
  );
  await Conversation.updateMany(
    { space: { $in: staleIds }, isGroup: true },
    { $pull: { participants: employeeId } }
  );

  if (io) {
    staleIds.forEach((spaceId) => {
      io.to(`employee_${id}`).emit("removed_from_space", {
        spaceId: String(spaceId),
      });
      io.to(`space_${spaceId}`).emit("space_members_updated", {
        spaceId: String(spaceId),
        removedMembers: [id],
        updatedAt: new Date(),
      });
    });
  }
}

/**
 * Put ONE employee in the groups they belong to. Called when they become active
 * and when their department changes; a no-op for anyone not active, so an
 * offboarded employee is never quietly re-added.
 */
async function syncSystemGroupsForEmployee({ employeeId, io } = {}) {
  try {
    if (!isObjId(employeeId)) return null;
    const Employee = require("../models/Employees");
    const employee = await Employee.findById(employeeId)
      .select("_id owner department status")
      .lean();
    if (!employee) return null;
    if (String(employee.status || "").toLowerCase() !== "active") return null;

    const ownerId = Array.isArray(employee.owner)
      ? employee.owner[0]
      : employee.owner;
    if (!isObjId(ownerId)) return null;

    const { creatorId, adminIds } = await resolveGroupAdmins(
      ownerId,
      employee._id
    );
    const companyName = await resolveCompanyName(ownerId);

    const company = await ensureSystemGroup({
      ownerId,
      role: "company",
      key: COMPANY_KEY,
      name: companyName || "Company",
      description: `Everyone at ${companyName || "the company"}`,
      emoji: "🏢",
      memberIds: [employee._id],
      creatorId,
      adminIds,
      io,
    });

    let department = null;
    const departmentName = String(employee.department || "").trim();
    if (departmentName) {
      department = await ensureSystemGroup({
        ownerId,
        role: "department",
        key: departmentKey(departmentName),
        name: departmentName,
        description: `${departmentName} department`,
        emoji: "👥",
        memberIds: [employee._id],
        creatorId,
        adminIds,
        io,
      });
    }

    // Runs even when the employee now has NO department — leaving one still
    // means leaving its group.
    await leaveOtherDepartmentGroups({
      ownerId,
      employeeId: employee._id,
      keepKey: departmentName ? departmentKey(departmentName) : null,
      io,
    });

    return { company, department };
  } catch (error) {
    console.error(
      "syncSystemGroupsForEmployee error (onboarding unaffected):",
      error
    );
    return null;
  }
}

/**
 * One department's group, driven by the Department record rather than by an
 * employee — every department on the books gets a group, staffed or not, so
 * it is there before its first hire.
 *
 * `previousName` renames the existing group instead of leaving it orphaned
 * beside a new one (the group is keyed on the department's name).
 */
async function syncDepartmentGroup({ ownerId, name, previousName, io } = {}) {
  try {
    const departmentName = String(name || "").trim();
    if (!isObjId(ownerId) || !departmentName) return null;

    const { Space, Conversation } = require("../models/Chat");
    const Employee = require("../models/Employees");
    const key = departmentKey(departmentName);

    const priorKey = departmentKey(previousName);
    if (priorKey && priorKey !== key) {
      const renamed = await Space.findOneAndUpdate(
        {
          "systemGroup.owner": ownerId,
          "systemGroup.role": "department",
          "systemGroup.key": priorKey,
        },
        {
          $set: {
            name: departmentName,
            description: `${departmentName} department`,
            "systemGroup.key": key,
          },
        },
        { new: true }
      );
      if (renamed) {
        await Conversation.updateOne(
          { space: renamed._id, isGroup: true },
          { $set: { groupName: departmentName } }
        );
        if (io) {
          io.to(`space_${renamed._id}`).emit("space_updated", {
            spaceId: String(renamed._id),
            name: departmentName,
          });
        }
      }
    }

    const employees = await Employee.find({
      owner: ownerId,
      status: "active",
      department: departmentName,
    })
      .select("_id")
      .lean();

    const { creatorId, adminIds } = await resolveGroupAdmins(
      ownerId,
      employees[0]?._id
    );

    return ensureSystemGroup({
      ownerId,
      role: "department",
      key,
      name: departmentName,
      description: `${departmentName} department`,
      emoji: "👥",
      memberIds: employees.map((e) => e._id),
      creatorId,
      adminIds,
      allowEmpty: true,
      io,
    });
  } catch (error) {
    console.error(
      "syncDepartmentGroup error (department change unaffected):",
      error
    );
    return null;
  }
}

/**
 * Every system group for one org, in one pass — the backfill for companies that
 * were running before these groups existed. Safe to re-run.
 */
async function syncSystemGroupsForOwner({ ownerId, io } = {}) {
  const Employee = require("../models/Employees");
  if (!isObjId(ownerId)) return { company: null, departments: [] };

  const employees = await Employee.find({ owner: ownerId, status: "active" })
    .select("_id department")
    .lean();
  if (employees.length === 0) return { company: null, departments: [] };

  const { creatorId, adminIds } = await resolveGroupAdmins(
    ownerId,
    employees[0]._id
  );
  const companyName = await resolveCompanyName(ownerId);

  const company = await ensureSystemGroup({
    ownerId,
    role: "company",
    key: COMPANY_KEY,
    name: companyName || "Company",
    description: `Everyone at ${companyName || "the company"}`,
    emoji: "🏢",
    memberIds: employees.map((e) => e._id),
    creatorId,
    adminIds,
    io,
  });

  // Every department on the books gets a group, staffed or not. Names typed
  // straight onto an employee (with no Department record behind them) count
  // too, so nobody is left without one.
  const Department = require("../models/Departments");
  const records = await Department.find({ owner: ownerId }).select("name").lean();

  const byDepartment = new Map();
  const remember = (rawName, employeeId) => {
    const name = String(rawName || "").trim();
    if (!name) return;
    const key = departmentKey(name);
    if (!byDepartment.has(key)) byDepartment.set(key, { name, ids: [] });
    if (employeeId) byDepartment.get(key).ids.push(employeeId);
  };
  records.forEach((record) => remember(record.name, null));
  employees.forEach((employee) => remember(employee.department, employee._id));

  const departments = [];
  for (const [key, { name, ids }] of byDepartment) {
    const group = await ensureSystemGroup({
      ownerId,
      role: "department",
      key,
      name,
      description: `${name} department`,
      emoji: "👥",
      memberIds: ids,
      creatorId,
      adminIds,
      allowEmpty: true,
      io,
    });
    if (group) departments.push(group);
  }

  return { company, departments };
}

/**
 * Is this employee in the group because the SYSTEM put them there? Those
 * memberships are not optional — "everyone in the company should be there" —
 * so leaving and being removed are both refused for them, while an admin's
 * extra participants can come and go freely.
 */
function isAutoMember(space, employeeId) {
  return (space?.systemGroup?.autoMembers || []).some(
    (id) => String(id?._id || id) === String(employeeId)
  );
}

module.exports = {
  COMPANY_KEY,
  departmentKey,
  ensureSystemGroup,
  syncDepartmentGroup,
  syncSystemGroupsForEmployee,
  syncSystemGroupsForOwner,
  isAutoMember,
};
