const mongoose = require('mongoose');
const { Schema } = mongoose;

const leaveMessageSchema = new Schema(
  {
    leave: { type: Schema.Types.ObjectId, ref: 'ApplyLeave', required: true, index: true },
    owner: { type: Schema.Types.ObjectId, required: true, index: true },
    // Either employee or admin user sends the message
    senderEmployee: { type: Schema.Types.ObjectId, ref: 'Employee' },
    senderUser: { type: Schema.Types.ObjectId },
    senderName: { type: String, required: true },
    senderRole: { type: String, enum: ['employee', 'admin', 'senior'], default: 'employee' },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    // Track who has read the message (by employeeId or userId)
    readBy: [{ type: Schema.Types.ObjectId }],
  },
  { timestamps: true }
);

leaveMessageSchema.index({ leave: 1, createdAt: 1 });
leaveMessageSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model('LeaveMessage', leaveMessageSchema);
