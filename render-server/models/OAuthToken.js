const mongoose = require('mongoose');

const oauthTokenSchema = new mongoose.Schema({
  clientId:        { type: String, required: true, unique: true },
  email:           { type: String, default: '' },
  bitrixDomain:    { type: String, required: true },
  accessToken:     { type: String, required: true },
  refreshToken:    { type: String, required: true },
  expiresAt:       { type: Date,   required: true },
  memberId:        { type: String },
  customerEmail:   { type: String, default: '' },
  licenseId:       { type: String, default: '' },
  licensePlan:     { type: String, default: '' },
  licenseStatus:   { type: String, default: '' },
  licenseLinkedAt: { type: Date },
  webhooksRegistered: { type: Boolean, default: false },
  agentLastPushedAt:  { type: Date },
  agentLive:          { type: Boolean, default: false },
  createdAt:       { type: Date, default: Date.now },
  updatedAt:       { type: Date, default: Date.now },
});

module.exports = mongoose.model('OAuthToken', oauthTokenSchema);