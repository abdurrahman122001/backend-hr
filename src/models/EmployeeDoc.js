// models/EmployeeDoc.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const EmployeeDocSchema = new Schema(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employees", index: true, required: true },
    type: {
      type: String,
      required: true,
      enum: ["nda", "contract", "salary_certificate", "experience_letter"],
      index: true,
    },
    // What the user sees on Canvas (full JSON). No server-side typesetting.
    canvas: {
      type: Object,
      required: true,
      default: () => ({
        id: "doc",
        name: "Document",
        pages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    // Optional dynamic values (employee overrides)
    values: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

EmployeeDocSchema.index({ employee: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeDoc", EmployeeDocSchema);
