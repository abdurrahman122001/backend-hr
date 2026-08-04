// models/FeedbackCounter.js
//
// Monotonic ticket-number allocator for feedback (Bug) documents, one counter
// per company owner. `seq` only ever moves forward: resolving or deleting a
// feedback item never gives its number back, so #11 stays #11 for the life of
// the company even after #10 is gone.
const mongoose = require("mongoose");

const feedbackCounterSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Highest ticket number handed out so far for this owner.
    seq: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FeedbackCounter", feedbackCounterSchema);
