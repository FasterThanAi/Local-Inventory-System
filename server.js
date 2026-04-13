require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const auth = require('./middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_local_inventory_key';
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const DASHBOARD_TIMEZONE = process.env.DASHBOARD_TIMEZONE || 'Asia/Kolkata';
const EXPIRY_ALERT_DAYS = Number.parseInt(process.env.EXPIRY_ALERT_DAYS || '30', 10) || 30;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const hasEmailConfig = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

const transporter = hasEmailConfig
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    })
  : null;

const Product = require('./models/Products');
const Customer = require('./models/Customer');
const Bill = require('./models/Bill');
const Owner = require('./models/Owner');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/frontend', express.static(FRONTEND_DIR));
app.get('/frontend', (req, res) => {
  res.redirect('/frontend/');
});

async function connectDatabase() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is missing in .env. Update .env and restart the server.');
    return;
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Database connected successfully.');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }
}

async function sendOtpEmail(to, subject, text) {
  if (!transporter) {
    console.log('Email skipped (EMAIL_USER / EMAIL_PASS missing). OTP is printed in server logs.');
    return;
  }

  try {
    await transporter.sendMail({
      from: '"Local Inventory" <no-reply@localinventory.com>',
      to,
      subject,
      text,
    });
  } catch (error) {
    console.log('Email delivery failed. OTP is still available in server logs.');
  }
}

function createClientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function processCheckout(cartItems, paymentMode, customerId, ownerId) {
  try {
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      throw createClientError('cartItems must be a non-empty array');
    }

    const allowedPaymentModes = new Set(['Cash', 'UPI', 'Credit']);
    if (!allowedPaymentModes.has(paymentMode)) {
      throw createClientError('Invalid payment mode');
    }

    if (paymentMode === 'Credit' && !customerId) {
      throw createClientError('Customer is required for credit checkout.');
    }

    if (paymentMode === 'Credit') {
      if (!mongoose.isValidObjectId(customerId)) {
        throw createClientError('Invalid customerId');
      }

      const creditCustomer = await Customer.findOne({ _id: customerId, ownerId }).select('_id');
      if (!creditCustomer) {
        throw createClientError('Customer not found for this owner', 404);
      }
    }

    const productCache = new Map();
    const requestedByProductId = new Map();
    const normalizedItems = [];
    let totalAmount = 0;

    // Validate each cart line and check stock availability before any deduction.
    for (const item of cartItems) {
      const productId = String(item?.productId || '').trim();
      const quantity = Number(item?.quantity);

      if (!productId) {
        throw createClientError('Each cart item must include productId');
      }

      if (!mongoose.isValidObjectId(productId)) {
        throw createClientError('Invalid productId in cart');
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw createClientError('Each cart item must include a valid quantity greater than 0');
      }

      let product = productCache.get(productId);
      if (!product) {
        product = await Product.findOne({ _id: productId, ownerId });
        if (!product) {
          throw createClientError('Product not found for this owner', 404);
        }
        productCache.set(productId, product);
      }

      const requestedQty = (requestedByProductId.get(productId) || 0) + quantity;
      requestedByProductId.set(productId, requestedQty);

      if (Number(product.stockQuantity || 0) < requestedQty) {
        throw createClientError(`Insufficient stock for ${product.name}`);
      }

      const unitPrice = Number(product.sellingPrice || 0);
      totalAmount += unitPrice * quantity;

      normalizedItems.push({
        productId: product._id,
        name: product.name,
        quantity,
        price: unitPrice,
      });
    }

    const deductedItems = [];

    try {
      for (const [productId, quantity] of requestedByProductId.entries()) {
        const product = productCache.get(productId);
        const updateResult = await Product.updateOne(
          { _id: productId, ownerId, stockQuantity: { $gte: quantity } },
          { $inc: { stockQuantity: -quantity } }
        );

        if (!updateResult.modifiedCount) {
          throw createClientError(`Insufficient stock for ${product ? product.name : 'selected product'}`);
        }

        deductedItems.push({ productId, quantity });
      }

      const newBill = new Bill({
        ownerId,
        items: normalizedItems,
        totalAmount,
        paymentMode,
        customerId: paymentMode === 'Credit' ? customerId : null,
      });
      await newBill.save();

      if (paymentMode === 'Credit' && customerId) {
        await Customer.findOneAndUpdate(
          { _id: customerId, ownerId },
          { $inc: { udhaarBalance: totalAmount } }
        );
        console.log('Udhaar ledger updated.');
      }

      return newBill;
    } catch (error) {
      if (deductedItems.length > 0) {
        for (const deductedItem of deductedItems) {
          try {
            await Product.updateOne(
              { _id: deductedItem.productId, ownerId },
              { $inc: { stockQuantity: deductedItem.quantity } }
            );
          } catch (rollbackError) {
            console.error('Stock rollback failed:', rollbackError.message);
          }
        }
      }
      throw error;
    }
  } catch (error) {
    console.log('Error during checkout:', error);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.send('<h1>Server is alive.</h1><p>Frontend is available at <a href="/frontend/">/frontend/</a></p>');
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/test-add-product', async (req, res) => {
  try {
    const newProduct = new Product({
      barcode: '890123456',
      name: 'Parle-G Gold',
      mrp: 20,
      sellingPrice: 18,
      stockQuantity: 50,
      expiryDate: new Date('2026-12-31'),
    });
    await newProduct.save();
    res.send('<h1>Success! Parle-G added to database.</h1>');
  } catch (error) {
    res.send('<h1>Error: ' + error.message + '</h1>');
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, shopName } = req.body;

    if (!email || !shopName) {
      return res.status(400).json({ error: 'email and shopName are required' });
    }

    let owner = await Owner.findOne({ email });

    if (owner && owner.isVerified) {
      return res.status(400).json({ error: 'Owner already registered and verified.' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpiry = new Date(Date.now() + 5 * 60000);

    if (!owner) {
      owner = new Owner({ email, shopName, otp, otpExpiry });
    } else {
      owner.shopName = shopName;
      owner.otp = otp;
      owner.otpExpiry = otpExpiry;
    }

    await owner.save();

    console.log('\n=========================================');
    console.log(`REGISTRATION OTP FOR [ ${email} ]: ${otp}`);
    console.log('=========================================\n');

    await sendOtpEmail(email, 'Your Registration OTP', `Your OTP is ${otp}. It expires in 5 minutes.`);

    res.status(200).json({ message: 'OTP generated successfully. Check your server terminal.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const owner = await Owner.findOne({ email, otp });

    if (!owner) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (owner.otpExpiry < new Date()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    owner.isVerified = true;
    owner.otp = undefined;
    owner.otpExpiry = undefined;
    await owner.save();

    const token = jwt.sign({ ownerId: owner._id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ message: 'Verification successful', token, shopName: owner.shopName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    const owner = await Owner.findOne({ email });

    if (!owner || !owner.isVerified) {
      return res.status(400).json({ error: 'No verified account found' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    owner.otp = otp;
    owner.otpExpiry = new Date(Date.now() + 5 * 60000);
    await owner.save();

    console.log('\n=========================================');
    console.log(`LOGIN OTP FOR [ ${email} ]: ${otp}`);
    console.log('=========================================\n');

    await sendOtpEmail(email, 'Your Login OTP', `Your login OTP is ${otp}. It expires in 5 minutes.`);

    res.status(200).json({ message: 'OTP generated successfully. Check your server terminal.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', auth, async (req, res) => {
  try {
    const newProduct = new Product({ ...req.body, ownerId: req.ownerId });
    await newProduct.save();
    res.status(201).json({ message: 'Product added to inventory', product: newProduct });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/products/:id', auth, async (req, res) => {
  try {
    const productId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const allowedFields = ['barcode', 'name', 'mrp', 'sellingPrice', 'stockQuantity', 'expiryDate'];
    const payload = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        payload[field] = req.body[field];
      }
    });

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    if (payload.barcode !== undefined) {
      payload.barcode = String(payload.barcode).trim();
    }

    if (payload.name !== undefined) {
      payload.name = String(payload.name).trim();
    }

    if (payload.mrp !== undefined) {
      payload.mrp = Number(payload.mrp);
    }

    if (payload.sellingPrice !== undefined) {
      payload.sellingPrice = Number(payload.sellingPrice);
    }

    if (payload.stockQuantity !== undefined) {
      payload.stockQuantity = Number(payload.stockQuantity);
    }

    if (payload.expiryDate !== undefined) {
      const parsedExpiryDate = new Date(payload.expiryDate);
      if (Number.isNaN(parsedExpiryDate.getTime())) {
        return res.status(400).json({ error: 'Invalid expiryDate' });
      }
      payload.expiryDate = parsedExpiryDate;
    }

    const updatedProduct = await Product.findOneAndUpdate(
      { _id: productId, ownerId: req.ownerId },
      payload,
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: 'Product not found for this owner' });
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully.',
      product: updatedProduct,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/products/:id', auth, async (req, res) => {
  try {
    const productId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const product = await Product.findOne({ _id: productId, ownerId: req.ownerId });
    if (!product) {
      return res.status(404).json({ error: 'Product not found for this owner' });
    }

    await Product.deleteOne({ _id: productId, ownerId: req.ownerId });

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function buildPaginationParams(query) {
  const parsedPage = Number.parseInt(String(query.page || '1'), 10);
  const parsedLimit = Number.parseInt(String(query.limit || '50'), 10);

  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 50;
  const search = String(query.search || '').trim();

  return { page, limit, search };
}

function escapeRegexSearch(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

app.get('/api/products', auth, async (req, res) => {
  try {
    const { page, limit, search } = buildPaginationParams(req.query);
    const filter = { ownerId: req.ownerId };

    if (search) {
      const safeSearch = escapeRegexSearch(search);
      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { barcode: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    const totalCount = await Product.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * limit;

    const products = await Product.find(filter).sort({ name: 1 }).skip(skip).limit(limit);

    res.status(200).json({
      data: products,
      totalPages,
      currentPage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customers', auth, async (req, res) => {
  try {
    const newCustomer = new Customer({ ...req.body, ownerId: req.ownerId });
    await newCustomer.save();
    res.status(201).json({ message: 'Customer profile created', customer: newCustomer });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/customers', auth, async (req, res) => {
  try {
    const { page, limit, search } = buildPaginationParams(req.query);
    const filter = { ownerId: req.ownerId };

    if (search) {
      const safeSearch = escapeRegexSearch(search);
      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { phone: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    const totalCount = await Customer.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * limit;

    const customers = await Customer.find(filter).sort({ name: 1 }).skip(skip).limit(limit);

    res.status(200).json({
      data: customers,
      totalPages,
      currentPage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/customers/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, ownerId: req.ownerId });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found for this owner' });
    }

    if (Number(customer.udhaarBalance || 0) > 0) {
      return res.status(400).json({ error: 'Cannot delete a customer with pending udhaar' });
    }

    await Customer.deleteOne({ _id: customer._id, ownerId: req.ownerId });

    res.status(200).json({
      success: true,
      message: 'Customer deleted successfully.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const expiryWindowEnd = new Date(startOfToday);
    expiryWindowEnd.setDate(expiryWindowEnd.getDate() + 30);
    expiryWindowEnd.setHours(23, 59, 59, 999);

    const products = await Product.find({
      ownerId: req.ownerId,
      $or: [
        { stockQuantity: { $lte: 5 } },
        { expiryDate: { $gte: startOfToday, $lte: expiryWindowEnd } },
      ],
    })
      .select('name barcode stockQuantity expiryDate')
      .sort({ stockQuantity: 1, expiryDate: 1, name: 1 })
      .lean();

    const alerts = [];

    products.forEach((product) => {
      const stockQuantity = Number(product.stockQuantity || 0);
      if (stockQuantity <= 5) {
        alerts.push({
          type: 'Low Stock',
          productId: product._id,
          message: `${product.name || 'Product'} is low on stock (${stockQuantity} left).`,
        });
      }

      if (!product.expiryDate) {
        return;
      }

      const expiryDate = new Date(product.expiryDate);
      if (Number.isNaN(expiryDate.getTime())) {
        return;
      }

      if (expiryDate >= startOfToday && expiryDate <= expiryWindowEnd) {
        alerts.push({
          type: 'Expiry Soon',
          productId: product._id,
          message: `${product.name || 'Product'} expires on ${expiryDate.toLocaleDateString('en-IN')}.`,
        });
      }
    });

    res.status(200).json({
      unreadCount: alerts.length,
      alerts,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const { cartItems, paymentMode, customerId } = req.body;
    const generatedBill = await processCheckout(cartItems, paymentMode, customerId, req.ownerId);

    res.status(200).json({
      success: true,
      message: 'Checkout complete. Bill generated.',
      bill: generatedBill,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    res.status(statusCode).json({ success: false, message: 'Checkout failed', error: error.message });
  }
});

app.get('/api/bills', auth, async (req, res) => {
  try {
    const allBills = await Bill.find({ ownerId: req.ownerId }).populate('customerId', 'name phone');
    res.status(200).json(allBills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills/:id/void', auth, async (req, res) => {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, ownerId: req.ownerId });

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found.' });
    }

    if (bill.isVoided) {
      return res.status(400).json({ error: 'Bill is already voided.' });
    }

    for (const item of bill.items || []) {
      const quantity = Number(item.quantity || 0);
      if (!item.productId || quantity <= 0) {
        continue;
      }

      await Product.findOneAndUpdate(
        { _id: item.productId, ownerId: req.ownerId },
        { $inc: { stockQuantity: quantity } }
      );
    }

    if (bill.paymentMode === 'Credit' && bill.customerId) {
      await Customer.findOneAndUpdate(
        { _id: bill.customerId, ownerId: req.ownerId },
        { $inc: { udhaarBalance: -Number(bill.totalAmount || 0) } }
      );
    }

    bill.isVoided = true;
    await bill.save();

    res.status(200).json({
      success: true,
      message: 'Bill voided successfully.',
      bill,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getDateKeyInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

app.get('/api/analytics/dashboard', auth, async (req, res) => {
  try {
    const now = new Date();
    const ownerId = new mongoose.Types.ObjectId(req.ownerId);
    const todayKey = getDateKeyInTimezone(now, DASHBOARD_TIMEZONE);

    const revenueWindowStart = new Date(now);
    revenueWindowStart.setDate(revenueWindowStart.getDate() - 6);
    revenueWindowStart.setHours(0, 0, 0, 0);

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const expiryWindowEnd = new Date(startOfToday);
    expiryWindowEnd.setDate(expiryWindowEnd.getDate() + EXPIRY_ALERT_DAYS);
    expiryWindowEnd.setHours(23, 59, 59, 999);

    const last7DayKeys = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      last7DayKeys.push(getDateKeyInTimezone(date, DASHBOARD_TIMEZONE));
    }

    const [
      revenueRows,
      lowStockAlerts,
      expiryAlerts,
      totalProducts,
      totalCustomers,
      totalBills,
    ] = await Promise.all([
      Bill.aggregate([
        {
          $match: {
            ownerId,
            date: { $gte: revenueWindowStart },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$date',
                timezone: DASHBOARD_TIMEZONE,
              },
            },
            revenue: { $sum: '$totalAmount' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Product.find({ ownerId: req.ownerId, stockQuantity: { $lt: 10 } })
        .select('name barcode stockQuantity sellingPrice expiryDate')
        .sort({ stockQuantity: 1, name: 1 })
        .lean(),
      Product.find({
        ownerId: req.ownerId,
        expiryDate: { $gte: startOfToday, $lte: expiryWindowEnd },
      })
        .select('name barcode stockQuantity sellingPrice expiryDate')
        .sort({ expiryDate: 1, name: 1 })
        .lean(),
      Product.countDocuments({ ownerId: req.ownerId }),
      Customer.countDocuments({ ownerId: req.ownerId }),
      Bill.countDocuments({ ownerId: req.ownerId }),
    ]);

    const revenueByDay = revenueRows.reduce((acc, row) => {
      acc[row._id] = Number(row.revenue || 0);
      return acc;
    }, {});

    const last7DaysRevenue = last7DayKeys.map((date) => ({
      date,
      revenue: revenueByDay[date] || 0,
    }));

    const todayRevenue = Number(revenueByDay[todayKey] || 0);

    res.status(200).json({
      todayRevenue,
      last7DaysRevenue,
      lowStockAlerts,
      expiryAlerts,
      kpi: {
        totalProducts,
        totalCustomers,
        totalBills,
      },
      expiryAlertDays: EXPIRY_ALERT_DAYS,
      timezone: DASHBOARD_TIMEZONE,
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customers/pay', auth, async (req, res) => {
  try {
    const { customerId, amountPaid } = req.body;
    const numericAmountPaid = Number(amountPaid);

    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ error: 'Invalid customerId' });
    }

    if (!Number.isFinite(numericAmountPaid) || numericAmountPaid <= 0) {
      return res.status(400).json({ error: 'Enter a valid payment amount greater than 0' });
    }

    const customer = await Customer.findOne(
      { _id: customerId, ownerId: req.ownerId },
      'udhaarBalance'
    );

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found for this owner' });
    }

    const pendingBalance = Number(customer.udhaarBalance || 0);
    if (numericAmountPaid > pendingBalance) {
      return res.status(400).json({ error: 'Payment exceeds pending udhaar balance' });
    }

    const updatedCustomer = await Customer.findOneAndUpdate(
      { _id: customerId, ownerId: req.ownerId, udhaarBalance: { $gte: numericAmountPaid } },
      { $inc: { udhaarBalance: -numericAmountPaid } },
      { new: true }
    );

    if (!updatedCustomer) {
      return res.status(400).json({ error: 'Payment exceeds pending udhaar balance' });
    }

    res.status(200).json({
      success: true,
      message: `Payment of Rs ${numericAmountPaid} received`,
      customer: updatedCustomer,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

connectDatabase();

app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Server is running on http://${displayHost}:${PORT}`);
  console.log(`Frontend URL: http://${displayHost}:${PORT}/frontend/`);
  if (process.platform === 'win32') {
    console.log('Windows mode enabled. Use Ctrl + C to stop the server.');
  }
});
