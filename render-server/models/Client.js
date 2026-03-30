const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  clientId:    { type: String, required: true, unique: true },
  email:       { type: String, required: true },
  bitrixUrl:   { type: String, required: true },
  bitrixDomain:{ type: String },
  webhooksRegistered: { type: Boolean, default: false },
  registeredAt:{ type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },
  isActive:    { type: Boolean, default: true },
});

module.exports = mongoose.model('Client', clientSchema);