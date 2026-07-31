/**
 * Invited people used to be added straight into space.members (they could read
 * and post before accepting, and the space showed in their sidebar). Invites
 * are now pending until accepted, so anyone who is BOTH a member and has a
 * pending invite has to be pulled back out of the space until they act on it.
 *
 * Run:  node migrate-pending-invites.js          (report only)
 *       node migrate-pending-invites.js --apply  (write)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { Space, Conversation } = require("./src/models/Chat");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? "APPLYING changes\n" : "DRY RUN — pass --apply to write\n");

  const spaces = await Space.find({
    "pendingInvites.0": { $exists: true },
  }).select("name members pendingInvites");

  let touched = 0;
  for (const space of spaces) {
    const pendingIds = (space.pendingInvites || [])
      .map((inv) => inv.employee?.toString())
      .filter(Boolean);

    const stillMembers = space.members
      .map((m) => m.toString())
      .filter((id) => pendingIds.includes(id));

    if (stillMembers.length === 0) continue;

    touched += 1;
    console.log(
      `${space.name}: removing ${stillMembers.length} un-accepted invitee(s) from members`
    );

    if (APPLY) {
      space.members = space.members.filter(
        (m) => !stillMembers.includes(m.toString())
      );
      space.admins = (space.admins || []).filter(
        (a) => !stillMembers.includes(a.toString())
      );
      await space.save();

      await Conversation.updateOne(
        { space: space._id, isGroup: true },
        { $pull: { participants: { $in: stillMembers } } }
      );
    }
  }

  console.log(`\n${touched} space(s) ${APPLY ? "updated" : "would be updated"}`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
