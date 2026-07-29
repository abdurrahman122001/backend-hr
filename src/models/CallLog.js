const { Schema, model } = require("mongoose");

/**
 * One row per placed call — who rang whom, when, and how it ended.
 *
 * A row is written the moment a call is placed rather than when it finishes,
 * so a call that is never cleanly ended (browser closed, server restarted)
 * still leaves a trace. For that reason `status` starts at "missed": an
 * interrupted call reads as missed, which is true from the callee's side,
 * instead of hanging around as a phantom call in progress.
 */
const CallLogSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Signalling id — lets the socket layer find this row again without
    // holding a database id in memory for the life of the call.
    callId: { type: String, required: true, unique: true, index: true },

    caller: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    callee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    video: { type: Boolean, default: false },

    status: {
      type: String,
      enum: [
        "missed", // rang out, or interrupted before it was answered
        "answered", // picked up, still in progress
        "completed", // picked up and ended normally
        "declined", // callee pressed decline
        "cancelled", // caller hung up before it was answered
        "failed", // media never connected
      ],
      default: "missed",
      index: true,
    },

    startedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    // Talk time only — from pick-up to hang-up, excluding the ringing. 0 for
    // any call that was never answered.
    durationSec: { type: Number, default: 0 },

    // Drives the "you have missed calls" badge; cleared when the callee opens
    // their history.
    seenByCallee: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// The history list: "my calls, newest first".
CallLogSchema.index({ owner: 1, caller: 1, startedAt: -1 });
CallLogSchema.index({ owner: 1, callee: 1, startedAt: -1 });

module.exports = model("CallLog", CallLogSchema);
