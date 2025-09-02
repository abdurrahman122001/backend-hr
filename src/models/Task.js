const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const TaskSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true }, // client's owner
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Employee", required: true }, // the manager
    assignedTo: { type: Schema.Types.ObjectId, ref: "Employee" }, // auto from client.assignedTo

    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    status: { type: String, enum: ["todo", "in_progress", "blocked", "done"], default: "todo" },
    dueDate: { type: Date },
  },
  { timestamps: true }
);

module.exports = model("Task", TaskSchema);
