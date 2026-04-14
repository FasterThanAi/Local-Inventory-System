const mongoose = require('mongoose');

const ownerSchema = new mongoose.Schema({
    shopName: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true
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

module.exports = mongoose.model('Owner', ownerSchema);
