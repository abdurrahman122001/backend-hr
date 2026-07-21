const mongoose = require("mongoose");

const normalizeEmployeeIds = (employeeIds) =>
  [...new Set((employeeIds || []).map(String))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

/**
 * Remove non-active employees from Chat spaces/groups and their linked
 * conversations. Space and group records share the same Space model.
 */
const removeEmployeesFromChatMemberships = async (employeeIds) => {
  const ids = normalizeEmployeeIds(employeeIds);
  if (ids.length === 0) return { spacesUpdated: 0, conversationsUpdated: 0 };

  // Lazy import avoids an Employees <-> Chat model initialization cycle.
  const { Space, Conversation } = require("../models/Chat");
  const affectedSpaces = await Space.find({ members: { $in: ids } })
    .select("_id")
    .lean();
  const spaceIds = affectedSpaces.map((space) => space._id);

  const [spaceResult, conversationResult] = await Promise.all([
    Space.updateMany(
      { members: { $in: ids } },
      {
        $pull: {
          members: { $in: ids },
          admins: { $in: ids },
          notificationSettings: { employee: { $in: ids } },
          pinnedBy: { employee: { $in: ids } },
        },
      },
    ),
    spaceIds.length > 0
      ? Conversation.updateMany(
          { space: { $in: spaceIds } },
          {
            $pull: {
              participants: { $in: ids },
              admins: { $in: ids },
              hiddenBy: { $in: ids },
              archivedBy: { $in: ids },
              pinnedBy: { employee: { $in: ids } },
              mutedBy: { employee: { $in: ids } },
            },
          },
        )
      : Promise.resolve({ modifiedCount: 0 }),
  ]);

  return {
    spacesUpdated: spaceResult.modifiedCount || 0,
    conversationsUpdated: conversationResult.modifiedCount || 0,
  };
};

const removeAllInactiveEmployeesFromChatMemberships = async () => {
  const Employee = require("../models/Employees");
  const inactiveEmployeeIds = await Employee.find({
    status: { $ne: "active" },
  }).distinct("_id");

  return removeEmployeesFromChatMemberships(inactiveEmployeeIds);
};

module.exports = {
  removeEmployeesFromChatMemberships,
  removeAllInactiveEmployeesFromChatMemberships,
};
