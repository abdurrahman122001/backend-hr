const { Schema, model } = require("mongoose");

/**
 * A "things to do" item raised for a SENIOR when a new employee is onboarded
 * under them in the org hierarchy (auto onboarding → offer letter with a
 * selected senior).
 *
 * It surfaces in the dashboard Things-to-do widget (People / Employee_dashboard
 * people / admin) via GET /api/onboarding-tasks, prompting the senior to add
 * the new hire to their clients / projects.
 */
const OnboardingTaskSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Who has to act — the senior in the hierarchy
    senior: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    // The newly onboarded employee the task is about
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    type: {
      type: String,
      enum: ["assign-clients-projects"],
      default: "assign-clients-projects",
    },
    title: { type: String },
    note: { type: String },
    status: {
      type: String,
      enum: ["pending", "done"],
      default: "pending",
    },
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { timestamps: true }
);

// One open task per senior/employee/type — re-sending an offer must not stack.
OnboardingTaskSchema.index(
  { owner: 1, senior: 1, employee: 1, type: 1 },
  { unique: true }
);
OnboardingTaskSchema.index({ owner: 1, senior: 1, status: 1, createdAt: -1 });

module.exports = model("OnboardingTask", OnboardingTaskSchema);
