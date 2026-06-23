const { Schema, model } = require('mongoose');

const ProfileRevisionSchema = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Array of field changes
    changes: [
      {
        fieldName: {
          type: String,
          required: true,
        },
        oldValue: Schema.Types.Mixed,
        newValue: Schema.Types.Mixed,
        fieldType: String, // 'text', 'email', 'date', 'number', 'select', 'array', etc.
      },
    ],
    reason: {
      type: String,
      required: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    // Admin approval info
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    approvalDate: {
      type: Date,
      default: null,
    },
    adminResponse: {
      type: String, // Rejection reason or approval notes
      default: null,
    },
    // Applied to employee schema
    appliedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
ProfileRevisionSchema.index({ employee: 1, status: 1, createdAt: -1 });
ProfileRevisionSchema.index({ owner: 1, status: 1, createdAt: -1 });

module.exports = model('ProfileRevision', ProfileRevisionSchema);
