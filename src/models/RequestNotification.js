const mongoose = require("mongoose");

const requestNotificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    requestModel: {
      type: String,
      default: "ApplyLeave",
    },
    requestType: {
      type: String,
      default: "leave",
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      default: "",
    },
    target: {
      path: String,
      query: mongoose.Schema.Types.Mixed,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: Date,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);

requestNotificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model("RequestNotification", requestNotificationSchema);
