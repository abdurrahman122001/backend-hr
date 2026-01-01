const mongoose = require("mongoose");
const { Schema } = mongoose;

const EmailLabelSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    color: {
      type: String,
      default: "#60a5fa",
      validate: {
        validator: function (v) {
          return /^#([0-9A-F]{3}){1,2}$/i.test(v);
        },
        message: (props) => `${props.value} is not a valid hex color!`,
      },
    },
    textColor: {
      type: String,
      default: "#ffffff",
      validate: {
        validator: function (v) {
          return /^#([0-9A-F]{3}){1,2}$/i.test(v);
        },
        message: (props) => `${props.value} is not a valid hex color!`,
      },
    },
    // Change from owner to employee for private labels
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    displayInSidebar: {
      type: Boolean,
      default: true,
    },
    showIfUnread: {
      type: Boolean,
      default: false,
    },
    showInMessageList: {
      type: Boolean,
      default: true,
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      default: 0,
    },
    parentLabel: {
      type: Schema.Types.ObjectId,
      ref: "EmailLabel",
      default: null,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Compound index for unique label names per employee
EmailLabelSchema.index({ name: 1, employee: 1 }, { unique: true });

// Index for faster queries
EmailLabelSchema.index({ employee: 1, createdAt: -1 });
EmailLabelSchema.index({ createdBy: 1 });
EmailLabelSchema.index({ displayInSidebar: 1 });
EmailLabelSchema.index({ parentLabel: 1 });

module.exports = mongoose.model("EmailLabel", EmailLabelSchema);