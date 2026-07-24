const mongoose = require("mongoose");

const governanceProofSchema = new mongoose.Schema(
  {
    programme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Programme",
      required: true,
    },
    programmeName: String,
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },

    GovernanceDashboard: {
      score: Number,
      status: String,
      metrics: mongoose.Schema.Types.Mixed,
      stats: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("GovernanceProof", governanceProofSchema);
