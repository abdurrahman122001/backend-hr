
// Tasks that belong to a Google-Chat "space" (conversation). Created from the
// Tasks side-panel; shared with everyone in the space.
const mongoose = require("mongoose");

const chatTaskSchema = new mongoose.Schema(
  {
    // The space / conversation this task lives in.
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Org owner, for tenant scoping.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, trim: true, default: "" },
    dueAt: { type: Date, default: null },
    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee" }],
    done: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
  },
  { timestamps: true }
);

// Active-first, newest-first within a space.
chatTaskSchema.index({ chatId: 1, done: 1, createdAt: -1 });

module.exports = mongoose.model("ChatTask", chatTaskSchema);
