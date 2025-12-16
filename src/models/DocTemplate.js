const mongoose = require("mongoose");

const DocTemplateSchema = new mongoose.Schema(
  {
    type: { 
      type: String, 
      required: true,
      trim: true,
      unique: false
      // NO unique: true here!
    },
    canvas: { 
      type: Object, 
      required: true 
    }, // your full canvas JSON
    defaultValues: { 
      type: Object, 
      default: {} 
    }, // default variable values (optional)
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    isGlobal: {
      type: Boolean,
      default: false
    },
    name: {
      type: String,
      default: "Untitled Template"
    }
  },
  { timestamps: true }
);

// Compound index for unique templates per owner per type
DocTemplateSchema.index({ type: 1, owner: 1 }, { unique: false });

// Index for global templates
DocTemplateSchema.index({ type: 1, isGlobal: 1 });

module.exports = mongoose.model("DocTemplate", DocTemplateSchema);