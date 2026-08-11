
// Tasks that belong to a Google-Chat "space" (conversation). Created from the
// Tasks side-panel; shared with everyone in the space.
const mongoose = require("mongoose");

const chatTaskSchema = new mongoose.Schema(
  {
    // The space / conversation this task lives in. Absent for personal tasks,
    // which deliberately belong to no conversation at all.
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      required: function () {
        return !this.isPersonal;
      },
      index: true,
    },
    // A private to-do, created from an email with no client space to file it
    // under. It has no chatId, so every space/DM listing (which queries BY
    // chatId) skips it automatically — it surfaces only in the task app's Home,
    // which fetches these separately. Never shown to anyone but its owner.
    isPersonal: { type: Boolean, default: false, index: true },
    // Org owner, for tenant scoping.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, trim: true, default: "" },
    dueAt: { type: Date, default: null },
    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee" }],
    done: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    // Review stage: when an ASSIGNEE (not the creator) marks the task complete
    // it goes "in review" instead of done — the creator then reviews and
    // completes (or reopens) it.
    inReview: { type: Boolean, default: false },
    reviewRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    reviewRequestedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    // Message this task was created from ("Create space task" on a message).
    // Lets the chat show a task badge under that message.
    sourceMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
      index: true,
    },
    // Same idea for the OTHER kind of message — an email turned into a task
    // from the mail view's message menu. Kept separate from sourceMessageId
    // because that one refs a chat Message and is what the chat badge keys on.
    sourceEmailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AssignmentMessage",
      default: null,
      index: true,
    },
    // Carried alongside so the task can link back to the whole conversation,
    // not just the one message.
    sourceEmailThreadId: { type: String, default: "" },
    // Conversation message generated when the task is created directly from
    // the Tasks panel. Assignment activity is threaded under this message.
    announcementMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    // ── Assignment request ────────────────────────────────────────────────
    // A junior cannot simply hand work to someone ABOVE them in the employee
    // hierarchy: assigning upward arrives as a REQUEST the senior accepts,
    // declines, or closes outright. "none" covers every ordinary assignment
    // (downward or sideways), which is still just an assignment.
    requestStatus: {
      type: String,
      enum: ["none", "pending", "accepted", "declined", "closed"],
      default: "none",
      index: true,
    },
    // The junior who raised the request.
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    // The senior(s) being asked — always a subset of `assignees`, and emptied
    // as each one answers.
    requestedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee" }],
    requestedAt: { type: Date, default: null },
    // Who answered last, when, and anything they said while declining.
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    respondedAt: { type: Date, default: null },
    responseNote: { type: String, trim: true, default: "" },
    // ClickUp-style subtasks: set to the parent task's id (one level deep).
    parentTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatTask",
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Active-first, newest-first within a space.
chatTaskSchema.index({ chatId: 1, done: 1, createdAt: -1 });

module.exports = mongoose.model("ChatTask", chatTaskSchema);
