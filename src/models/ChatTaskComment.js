// Thread-style comments on a space task (opened from the "N tasks created"
// badge under a chat message). Realtime via `chat_task_comment_added`.
const mongoose = require("mongoose");

const chatTaskCommentSchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatTask",
      required: true,
      index: true,
    },
    // The space the task lives in — used for the socket room broadcast.
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    content: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

chatTaskCommentSchema.index({ taskId: 1, createdAt: 1 });

module.exports = mongoose.model("ChatTaskComment", chatTaskCommentSchema);
