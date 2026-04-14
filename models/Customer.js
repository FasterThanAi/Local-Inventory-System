const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  udhaarBalance: { type: Number, default: 0, min: 0 } // Positive means they owe the shop money
});

customerSchema.index({ ownerId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);
