const mongoose = require('mongoose');

const shopOwnerSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true
    },
    shopName: {
        type: String,
        required: true,
    },
    otp: {
        type: String
    },
    otpExpiry: {
        type: Date
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('ShopOwner', shopOwnerSchema);
