// utils/feedbackTicketNumber.js
const FeedbackCounter = require("../models/FeedbackCounter");

/**
 * Reserve the next feedback ticket number for a company.
 *
 * The allocation is a single atomic `$inc` upsert, so two people reporting
 * feedback at the same moment can never receive the same number. The counter is
 * never decremented — deleting or resolving feedback leaves a gap rather than
 * renumbering the items that follow it.
 *
 * @param {mongoose.Types.ObjectId|string} ownerId
 * @returns {Promise<number|null>} the reserved number, or null if no owner
 */
async function nextFeedbackTicketNumber(ownerId) {
  if (!ownerId) return null;

  const counter = await FeedbackCounter.findOneAndUpdate(
    { owner: ownerId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return counter.seq;
}

module.exports = { nextFeedbackTicketNumber };
