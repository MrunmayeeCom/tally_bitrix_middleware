const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  clientId:  { type: String, required: true, index: true },
  eventType: { type: String, required: true },
  payload:   { type: mongoose.Schema.Types.Mixed },
  processed: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  processedAt:{ type: Date },
});

// Auto delete processed events after 24 hours
eventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 86400 });


module.exports = mongoose.model('Event', eventSchema);