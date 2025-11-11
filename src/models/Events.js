const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    title: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, required: true },
    time: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Event", eventSchema);
