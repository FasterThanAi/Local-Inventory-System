const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true },
  barcode: { type: String, required: true }, // Scanned by USB scanner
  name: { type: String, required: true },
  mrp: { type: Number, required: true, min: 0 },
  sellingPrice: { type: Number, required: true, min: 0 },
  stockQuantity: { type: Number, required: true, min: 0 },
  expiryDate: { type: Date, required: true }
});

module.exports = mongoose.model('Product', productSchema);
