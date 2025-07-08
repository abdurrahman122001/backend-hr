const mongoose = require('mongoose');
const ExtraFieldSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },  
  label: { type: String, required: true },
  type: { type: String, required: true, enum: ['text', 'select', 'number', 'date'], default: 'text' },
  placeholder: { type: String },
  options: [{ type: String }],
  isRequired: { type: Boolean, default: false },
  section: { 
    type: String, // e.g., 'personal', 'emergency', 'employment', 'salary', 'deduction'
    required: true,
    enum: ['personal', 'emergency', 'employment', 'salary', 'deduction']
  }
}, { timestamps: true });


ExtraFieldSchema.index({ owner: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('ExtraField', ExtraFieldSchema);
