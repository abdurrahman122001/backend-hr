const { Schema, model } = require("mongoose");

/**
 * One line in a candidate's onboarding log.
 *
 * Every onboarding step used to leave its trace only in the pm2 console
 * ("[CNIC-REQUEST] SENT to …"), so nobody outside the server could tell
 * whether an offer letter actually reached the candidate or died in SMTP —
 * the employee row said "Offered" either way. These documents are what the
 * Log dialog on the Employees screen reads.
 */
const OnboardingEventSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },

    // Stable machine key for the step, so new steps can be added without
    // touching anything that reads these back.
    type: {
      type: String,
      required: true,
      enum: [
        "offer_letter",
        "offer_accepted",
        "offer_rejected",
        "cnic_cv_request",
        "documents_received",
        "complete_profile_link",
        "set_password_invite",
      ],
    },
    // Did the step do what it was supposed to do? "failed" is the whole point
    // of this collection: a send that threw still left the employee sitting in
    // an onboarding status with no way to tell.
    status: { type: String, enum: ["success", "failed"], required: true },

    // What the UI prints, resolved at write time — the log has to stay
    // readable even after templates, names or roles change later.
    title: { type: String, required: true },
    // Error text on failure, message id / recipient on success.
    detail: { type: String, default: "" },
    recipient: { type: String, default: "" },

    // Who triggered it, when a human did. Watcher-driven steps have none.
    actor: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    actorName: { type: String, default: "" },

    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

// The only read pattern: one employee's log, newest first.
OnboardingEventSchema.index({ owner: 1, employee: 1, at: -1 });

module.exports = model("OnboardingEvent", OnboardingEventSchema);
