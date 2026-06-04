const mongoose = require("mongoose");

const governanceProofSchema = new mongoose.Schema({
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

  // PROOF 1: State Machine
  proof1_StateMachine: {
    currentState: String,
    validTransitions: [String],
    blockedTransitions: [{
      attemptedState: String,
      result: String,
      errorMessage: String
    }]
  },

  // PROOF 2: RAG Classification
  proof2_RAGClassification: {
    calculationLogic: {
      green: String,
      amber: String,
      red: String,
      blue: String
    },
    activitiesAnalyzed: mongoose.Schema.Types.Mixed
  },

  // PROOF 3: Governance Rules
  proof3_GovernanceRules: {
    stats: {
      totalActions: Number,
      requiredActions: Number,
      optionalActions: Number,
      openRequiredActions: Number,
      completedActions: Number,
      overdueActions: Number,
      blockedActivities: Number,
      totalWeeks: Number,
      closedWeeks: Number,
      remainingWeeks: Number
    },
    governanceChecks: [{
      checkName: String,
      count: Number,
      blocksCloseOut: Boolean,
      result: String
    }],
    blockingActions: mongoose.Schema.Types.Mixed,
    finalDecision: {
      readyToClose: Boolean,
      displayValue: String,
      uiColor: String,
      reason: String
    }
  },

  // Summary
  summary: {
    stateMachineEnforced: String,
    ragIsDynamic: String,
    governanceActive: String,
    currentCloseOutStatus: String,
    blockingReasons: [String]
  }
}, {
  timestamps: true
});

module.exports = mongoose.model("GovernanceProof", governanceProofSchema);
