require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');

const app = express();

// --- MIDDLEWARE ---
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- STATIC FILES WITH CACHING ---
app.use(express.static(__dirname, {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

app.use('/picture', express.static(path.join(__dirname, 'picture'), {
  maxAge: '7d'
}));

app.use('/pdf', express.static(__dirname, {
  maxAge: '1d'
}));

// --- FRONTEND URL (used for email images and dashboard links) ---
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.racdayinsure.online';

// --- MONGO DB CONNECTION ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://finance_db_user:LondonBoy@rac.xnnepne.mongodb.net/racon_db?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ============================================================
// SCHEMAS
// ============================================================

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'admin' },
  createdAt: { type: Date, default: Date.now }
});

const ApplicationSchema = new mongoose.Schema({
  customer: {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    dob: { type: String, required: true },
    email: { type: String, required: true },
    mobile: { type: String, required: true },
    occupation: { type: String, required: true },
    drivingLicense: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: String,
    city: { type: String, required: true },
    postcode: { type: String, required: true }
  },
  vehicle: {
    registration: { type: String, required: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: String, required: true }
  },
  coverDetails: {
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true }
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedDetails: {
    insurer: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    policyNumber: { type: String, default: '' },
    uniqueToken: { type: String, default: '' },
    tokenExpiry: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

const PolicySchema = new mongoose.Schema({
  customer: {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    dob: { type: String, required: true },
    drivingLicense: { type: String, required: true },
    occupation: String,
    addressLine1: { type: String, required: true },
    addressLine2: String,
    city: { type: String, required: true },
    postcode: { type: String, required: true },
    mobile: { type: String, required: true },
    email: { type: String, required: true }
  },
  vehicle: {
    registration: { type: String, required: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: String, required: true }
  },
  policyDetails: {
    amount: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    policyNumber: { type: String, unique: true },
    insurer: { type: String, required: true },
    status: { type: String, enum: ['active', 'expired'], default: 'active' },
    uniqueToken: { type: String, unique: true, sparse: true },
    tokenExpiry: { type: Date, default: () => new Date(+new Date() + 30*24*60*60*1000) }
  },
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  policyToken: { type: String, required: true },
  sender: { type: String, enum: ['customer', 'admin'], required: true },
  message: { type: String, required: true },
  customerEmail: { type: String },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const TypingSchema = new mongoose.Schema({
  policyToken: { type: String, required: true, unique: true },
  isTyping: { type: Boolean, default: false },
  sender: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  updatedAt: { type: Date, default: Date.now }
});

const Admin = mongoose.model('Admin', AdminSchema);
const Application = mongoose.model('Application', ApplicationSchema);
const Policy = mongoose.model('Policy', PolicySchema);
const Message = mongoose.model('Message', MessageSchema);
const Typing = mongoose.model('Typing', TypingSchema);

// ============================================================
// HELPERS
// ============================================================

async function generatePolicyNumber() {
  const year = new Date().getFullYear();
  // Count existing policies
  const count = await Policy.countDocuments();
  let seq = String(count + 1).padStart(3, '0');
  let policyNumber = `RAC-${year}-${seq}`;
  
  // If duplicate (rare), increment until unique
  let exists = await Policy.findOne({ 'policyDetails.policyNumber': policyNumber });
  let attempts = 0;
  while (exists && attempts < 10) {
    seq = String(parseInt(seq) + 1).padStart(3, '0');
    policyNumber = `RAC-${year}-${seq}`;
    exists = await Policy.findOne({ 'policyDetails.policyNumber': policyNumber });
    attempts++;
  }
  return policyNumber;
}

const hashPassword = async (plain) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// SEED ADMIN
// ============================================================
async function seedAdmin() {
  const count = await Admin.countDocuments();
  if (count === 0) {
    const hashed = await hashPassword('Admin123!');
    await Admin.create({ username: 'Jp', password: hashed });
    console.log('✅ Default admin "Jp" created with password "Admin123!"');
  }
}

// ============================================================
// JWT MIDDLEWARE
// ============================================================
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(decoded.id).select('-password');
    if (!admin) return res.status(401).json({ message: 'Invalid token' });
    req.admin = admin;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

// ============================================================
// API ROUTES
// ============================================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(400).json({ message: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: admin._id, username: admin.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, admin: { id: admin._id, username: admin.username } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admins', authenticate, async (req, res) => {
  try {
    const admins = await Admin.find().select('-password');
    res.json(admins);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admins', authenticate, async (req, res) => {
  try {
    const { username, password } = req.body;
    const exists = await Admin.findOne({ username });
    if (exists) return res.status(400).json({ message: 'Username already exists' });

    const hashed = await hashPassword(password);
    const newAdmin = await Admin.create({ username, password: hashed });
    res.status(201).json({ id: newAdmin._id, username: newAdmin.username });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/admins/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await Admin.findById(id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });

    const count = await Admin.countDocuments();
    if (count <= 1) {
      return res.status(400).json({ message: 'Cannot delete the last admin' });
    }

    await Admin.findByIdAndDelete(id);
    res.json({ message: 'Admin deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/applications', async (req, res) => {
  try {
    const data = req.body;
    const required = ['firstName','lastName','dob','email','mobile','occupation','drivingLicense','addressLine1','city','postcode','registration','make','model','year','startDate','endDate'];
    for (const field of required) {
      if (!data[field]) {
        return res.status(400).json({ message: `Missing field: ${field}` });
      }
    }

    const application = new Application({
      customer: {
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        dob: data.dob.trim(),
        email: data.email.trim(),
        mobile: data.mobile.trim(),
        occupation: data.occupation.trim(),
        drivingLicense: data.drivingLicense.trim(),
        addressLine1: data.addressLine1.trim(),
        addressLine2: data.addressLine2 ? data.addressLine2.trim() : '',
        city: data.city.trim(),
        postcode: data.postcode.trim()
      },
      vehicle: {
        registration: data.registration.trim(),
        make: data.make.trim(),
        model: data.model.trim(),
        year: data.year.trim()
      },
      coverDetails: {
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate)
      },
      status: 'pending'
    });

    await application.save();
    res.status(201).json({ message: 'Application submitted successfully', id: application._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/applications', authenticate, async (req, res) => {
  try {
    const applications = await Application.find().sort({ createdAt: -1 });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/applications/:id', authenticate, async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ message: 'Application not found' });
    res.json(application);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/applications/:id', authenticate, async (req, res) => {
  try {
    const application = await Application.findByIdAndDelete(req.params.id);
    if (!application) return res.status(404).json({ message: 'Application not found' });
    res.json({ message: 'Application deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// FIXED APPROVAL ROUTE – with detailed logging and error handling
// ============================================================

app.post('/api/applications/:id/approve', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { insurer, amount } = req.body;
    if (!insurer || !amount) {
      return res.status(400).json({ message: 'Insurer and amount are required' });
    }

    const application = await Application.findById(id);
    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({ message: 'Application already processed' });
    }

    // Generate policy number (with duplicate check)
    const policyNumber = await generatePolicyNumber();
    const token = uuidv4();

    // Update application
    application.status = 'approved';
    application.approvedDetails = {
      insurer,
      amount: parseFloat(amount),
      policyNumber,
      uniqueToken: token,
      tokenExpiry: new Date(+new Date() + 30*24*60*60*1000)
    };
    await application.save();
    console.log(`✅ Application ${id} approved, policy number: ${policyNumber}`);

    // Create policy
    const policy = new Policy({
      customer: application.customer,
      vehicle: application.vehicle,
      policyDetails: {
        amount: parseFloat(amount),
        startDate: application.coverDetails.startDate,
        endDate: application.coverDetails.endDate,
        policyNumber,
        insurer,
        status: 'active',
        uniqueToken: token,
        tokenExpiry: new Date(+new Date() + 30*24*60*60*1000)
      }
    });

    // Save policy with error logging
    let savedPolicy;
    try {
      savedPolicy = await policy.save();
      console.log('✅ Policy created:', savedPolicy.policyDetails.policyNumber);
    } catch (saveError) {
      console.error('❌ Policy save error:', saveError);
      // If policy save fails, we could revert the application status, but better to return error and let admin retry.
      return res.status(500).json({ message: 'Policy creation failed: ' + saveError.message });
    }

    const emailHtml = generateEmailHTML(savedPolicy);

    res.json({
      message: 'Application approved',
      policy: savedPolicy,
      emailHtml,
      token
    });
  } catch (err) {
    console.error('Approval error:', err);
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/applications/:id/reject', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const application = await Application.findById(id);
    if (!application) return res.status(404).json({ message: 'Application not found' });
    if (application.status !== 'pending') {
      return res.status(400).json({ message: 'Application already processed' });
    }

    application.status = 'rejected';
    await application.save();
    res.json({ message: 'Application rejected' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/public/retrieve', async (req, res) => {
  try {
    const { surname, dob, postcode } = req.body;
    if (!surname || !dob || !postcode) {
      return res.status(400).json({ message: 'Surname, DOB, and postcode are required' });
    }

    const surnameTrim = surname.trim();
    const dobTrim = dob.trim();
    const postcodeTrim = postcode.trim().toUpperCase();

    const query = {
      'customer.lastName': { $regex: new RegExp('^' + escapeRegex(surnameTrim), 'i') },
      'customer.dob': dobTrim,
      'customer.postcode': { $regex: new RegExp('^' + escapeRegex(postcodeTrim), 'i') },
      'policyDetails.status': 'active'
    };

    const policy = await Policy.findOne(query);

    if (!policy) {
      return res.status(404).json({ message: 'No active policy found matching these details.' });
    }

    res.json({
      customer: policy.customer,
      vehicle: policy.vehicle,
      policyDetails: {
        policyNumber: policy.policyDetails.policyNumber,
        amount: policy.policyDetails.amount,
        startDate: policy.policyDetails.startDate,
        endDate: policy.policyDetails.endDate,
        insurer: policy.policyDetails.insurer,
        status: policy.policyDetails.status,
        uniqueToken: policy.policyDetails.uniqueToken
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/public/policy', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token required' });

    const policy = await Policy.findOne({ 'policyDetails.uniqueToken': token });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });

    res.json({
      customer: policy.customer,
      vehicle: policy.vehicle,
      policyDetails: {
        policyNumber: policy.policyDetails.policyNumber,
        amount: policy.policyDetails.amount,
        startDate: policy.policyDetails.startDate,
        endDate: policy.policyDetails.endDate,
        insurer: policy.policyDetails.insurer,
        status: policy.policyDetails.status,
        uniqueToken: policy.policyDetails.uniqueToken
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/stats', authenticate, async (req, res) => {
  try {
    const totalPolicies = await Policy.countDocuments();
    const activePolicies = await Policy.countDocuments({ 'policyDetails.status': 'active' });
    const draftPolicies = await Policy.countDocuments({ 'policyDetails.status': { $ne: 'active' } });

    const revenueResult = await Policy.aggregate([
      { $group: { _id: null, total: { $sum: '$policyDetails.amount' } } }
    ]);
    const totalRevenue = revenueResult.length ? revenueResult[0].total : 0;

    const monthlyData = await Policy.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]);

    const recentPolicies = await Policy.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('customer policyDetails createdAt');

    res.json({
      totalPolicies,
      activePolicies,
      draftPolicies,
      totalRevenue,
      monthlyData: monthlyData.reverse(),
      recentPolicies
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/policies', authenticate, async (req, res) => {
  try {
    const policies = await Policy.find().sort({ createdAt: -1 });
    res.json(policies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/policies/:id', authenticate, async (req, res) => {
  try {
    const policy = await Policy.findById(req.params.id);
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    res.json(policy);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/policies/:id', authenticate, async (req, res) => {
  try {
    const policy = await Policy.findByIdAndDelete(req.params.id);
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    res.json({ message: 'Policy deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// EMAIL GENERATION – with PNG logos, triple spacing, etc.
// ============================================================

function generateEmailHTML(policy) {
  const dashboardUrl = `${FRONTEND_URL}/dashboard.html`;
  const manageLink = `${dashboardUrl}?token=${policy.policyDetails.uniqueToken}`;
  
  const start = new Date(policy.policyDetails.startDate);
  const end = new Date(policy.policyDetails.endDate);
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const duration = `${diffDays} days`;

  const fullName = `${policy.customer.firstName} ${policy.customer.lastName}`;
  const vehicleDisplay = `${policy.vehicle.make} ${policy.vehicle.model} (${policy.vehicle.registration})`;
  const amount = policy.policyDetails.amount;
  const total = amount;

  const racLogo = `${FRONTEND_URL}/picture/1.png`;
  const dayinsureLogo = `${FRONTEND_URL}/picture/2.png`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <meta name="darkmode" content="false">
  <title>RAC Insurance – Policy Details</title>
  <style>
    body, body * {
      background-color: #ffffff !important;
      background: #ffffff !important;
      color: #000000 !important;
      font-family: Arial, Helvetica, sans-serif !important;
    }
    table, td, tr, tbody, thead, th, div, p, span, a, strong, h1, h2, h3, h4, h5, h6 {
      background-color: #ffffff !important;
      background: #ffffff !important;
      color: #000000 !important;
    }
    .policy-row {
      padding: 40px 0 !important;
    }
    .label {
      font-weight: bold !important;
      color: #000000 !important;
      padding-right: 15px !important;
      white-space: nowrap !important;
      vertical-align: top !important;
    }
    .value {
      color: #000000 !important;
      word-wrap: break-word !important;
      vertical-align: top !important;
    }
    .logo-img {
      display: block !important;
      max-width: 100% !important;
      height: auto !important;
      max-height: 50px !important;
      width: auto !important;
      border: 0 !important;
    }
    .logo-cell-left {
      text-align: left !important;
      padding-right: 0 !important;
      width: 50% !important;
      vertical-align: middle !important;
    }
    .logo-cell-right {
      text-align: right !important;
      padding-left: 0 !important;
      width: 50% !important;
      vertical-align: middle !important;
    }
    .faq-link {
      color: #FF5A00 !important;
      text-decoration: underline !important;
      font-weight: bold !important;
      font-size: 13px !important;
      font-variant: small-caps !important;
    }
    .green-card {
      background-color: #1e7e34 !important;
      background: #1e7e34 !important;
      border-radius: 8px !important;
      padding: 18px 20px !important;
      text-align: center !important;
      display: block !important;
    }
    .green-card a {
      color: #ffffff !important;
      font-weight: bold !important;
      font-size: 16px !important;
      text-decoration: none !important;
      display: block !important;
      background-color: transparent !important;
    }
    @media (max-width: 480px) {
      .logo-img { max-height: 35px !important; }
      .logo-cell-left, .logo-cell-right { width: 50% !important; padding: 0 !important; }
      .logo-cell-left { text-align: left !important; }
      .logo-cell-right { text-align: right !important; }
      .policy-row { padding: 25px 0 !important; }
      .green-card { padding: 14px 15px !important; }
      .green-card a { font-size: 14px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#ffffff !important; background:#ffffff !important; font-family: Arial, Helvetica, sans-serif;" bgcolor="#ffffff">
<div style="background-color:#ffffff !important; background:#ffffff !important; padding:20px 0;" data-darkmode-ignore="true">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important; background:#ffffff !important; padding:20px 0;">
  <tr>
    <td align="center" bgcolor="#ffffff" style="background-color:#ffffff !important; background:#ffffff !important;">
      <table width="650" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important; background:#ffffff !important; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.08); padding:35px; border-collapse:collapse; max-width:650px;">

        <!-- HEADER WITH TWO LOGOS AT EDGES -->
        <tr>
          <td bgcolor="#ffffff" style="padding-bottom:20px; background-color:#ffffff !important; background:#ffffff !important;">
            <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important; background:#ffffff !important;">
              <tr>
                <td align="left" valign="middle" bgcolor="#ffffff" class="logo-cell-left" style="background-color:#ffffff !important; background:#ffffff !important;">
                  <img src="${racLogo}" alt="RAC" class="logo-img" style="display:block; max-width:100%; height:auto; max-height:50px; width:auto; border:0;" />
                </td>
                <td align="right" valign="middle" bgcolor="#ffffff" class="logo-cell-right" style="background-color:#ffffff !important; background:#ffffff !important;">
                  <img src="${dayinsureLogo}" alt="Dayinsure" class="logo-img" style="display:block; max-width:100%; height:auto; max-height:50px; width:auto; border:0;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- GREETING -->
        <tr>
          <td bgcolor="#ffffff" style="padding:25px 0 10px 0; background-color:#ffffff !important; background:#ffffff !important; text-align:center;">
            <span style="font-size:20px; color:#FF5A00 !important; font-weight:bold; line-height:1.6;">
              Hi ${fullName},<br>Thank you for insuring your vehicle with Dayinsure.
            </span>
          </td>
        </tr>

        <!-- POLICY DETAILS – triple spacing -->
        <tr>
          <td bgcolor="#ffffff" style="padding:5px 0; background-color:#ffffff !important; background:#ffffff !important;">
            <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important; background:#ffffff !important; font-size:15px; border-collapse:collapse;">
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Policy number:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${policy.policyDetails.policyNumber}</td></tr>
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Policy start:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${new Date(policy.policyDetails.startDate).toLocaleDateString('en-GB')} at ${new Date(policy.policyDetails.startDate).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</td></tr>
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Policy end:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${new Date(policy.policyDetails.endDate).toLocaleDateString('en-GB')} at ${new Date(policy.policyDetails.endDate).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</td></tr>
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Insured by:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${policy.policyDetails.insurer}</td></tr>
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Duration:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${duration}</td></tr>
              <tr class="policy-row"><td bgcolor="#ffffff" class="label" style="background-color:#ffffff !important; background:#ffffff !important;">Vehicle:</td><td bgcolor="#ffffff" class="value" style="background-color:#ffffff !important; background:#ffffff !important;">${vehicleDisplay}</td></tr>
              <tr class="policy-row" style="border-bottom: none !important;"><td bgcolor="#ffffff" class="label" style="color:#FF5A00 !important; font-weight:bold; background-color:#ffffff !important; background:#ffffff !important;">Total cost:</td><td bgcolor="#ffffff" class="value" style="color:#FF5A00 !important; font-weight:bold; font-size:18px; background-color:#ffffff !important; background:#ffffff !important;">£${total.toFixed(2)}</td></tr>
            </table>
          </td>
        </tr>

        <!-- NB NOTE -->
        <tr>
          <td bgcolor="#ffffff" style="padding:15px 0 10px 0; font-size:14px; background-color:#ffffff !important; background:#ffffff !important; text-align:left;">
            <strong style="color:#000000 !important;">NB:</strong> <span style="color:#000000 !important;">Total cost includes IPT at 12% and admin fee payable to Dayinsure.</span>
          </td>
        </tr>

        <!-- GREEN CARD -->
        <tr>
          <td bgcolor="#ffffff" style="padding:10px 0 15px 0; background-color:#ffffff !important; background:#ffffff !important; text-align:center;">
            <div class="green-card" style="background-color:#1e7e34 !important; background:#1e7e34 !important; border-radius:8px !important; padding:18px 20px !important; text-align:center !important; display:block !important;">
              <a href="${manageLink}" style="color:#ffffff !important; font-weight:bold !important; font-size:16px !important; text-decoration:none !important; display:block !important; background-color:transparent !important; background:transparent !important;">Manage Policy & View Documents</a>
            </div>
          </td>
        </tr>

        <!-- FAQ line -->
        <tr>
          <td bgcolor="#ffffff" style="padding:10px 0 5px 0; background-color:#ffffff !important; background:#ffffff !important; text-align:center; font-size:14px;">
            <span style="color:#000000 !important;">If you have any questions about our policy, check out our</span>
            <a href="#" class="faq-link" style="color:#FF5A00 !important; text-decoration:underline !important; font-weight:bold !important; font-size:13px !important; font-variant:small-caps !important;">FAQ'S</a>
            <span style="color:#000000 !important;">or</span>
            <a href="#" class="faq-link" style="color:#FF5A00 !important; text-decoration:underline !important; font-weight:bold !important; font-size:13px !important; font-variant:small-caps !important;">CONTACT PAGE</a>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td bgcolor="#ffffff" style="font-size:11px; background-color:#ffffff !important; background:#ffffff !important; text-align:center; line-height:1.8; padding-top:20px; border-top:1px solid #eee; margin-top:20px;">
            <span style="color:#888888 !important;">RAC Financial Services Limited act as an introducer to Dayinsure.com Ltd for RAC Day Insurance.<br>RAC Financial Services Limited is registered in England No. 5171817. Registered Office: RAC House, Brockhurst Crescent, Walsall WS5 4AW.<br>RAC Day Insurance is arranged and administered by Dayinsure.com Ltd, which is registered in England no. 04996289, registered office: Mara House, Tarporley Business Centre, Nantwich Road, Tarporley, Cheshire CW6 9UY.<br>Both companies are authorised and regulated by the Financial Conduct Authority.<br>RAC Day Insurance is underwritten by Aviva Insurance Limited. Registered in Scotland, No 2116. Registered Office: Pitheavlis, Perth PH2 0NH.<br>Aviva Insurance Limited are authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority.</span>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</div>
</body>
</html>`;
}

// ============================================================
// PDF GENERATION (unchanged)
// ============================================================

app.get('/api/public/policy/:token/pdf', async (req, res) => {
  let browser = null;
  try {
    const { token } = req.params;
    const policy = await Policy.findOne({ 'policyDetails.uniqueToken': token });
    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    const startDate = new Date(policy.policyDetails.startDate);
    const endDate = new Date(policy.policyDetails.endDate);
    const fullName = `${policy.customer.firstName} ${policy.customer.lastName}`;
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const amount = policy.policyDetails.amount;
    const ipt = (amount * 0.12).toFixed(2);
    const adminFee = 4.60;

    const htmlContent = `<!DOCTYPE html>
<html><head><style>
  body { font-family: Arial, Helvetica, sans-serif; padding: 50px; color: #222; font-size: 12px; line-height: 1.6; }
  .page { max-width: 800px; margin: 0 auto; }
  .header { border-bottom: 2px solid #FF5A00; padding-bottom: 10px; margin-bottom: 20px; }
  .title { color: #FF5A00; font-size: 24px; font-weight: bold; }
  .subtitle { color: #0050B3; font-size: 16px; font-weight: bold; }
  .section { margin-bottom: 15px; }
  .section-title { font-weight: bold; font-size: 13px; color: #222; margin-bottom: 3px; }
  .row { display: flex; padding: 4px 0; border-bottom: 1px solid #eee; }
  .label { width: 220px; font-weight: bold; color: #555; }
  .value { flex: 1; }
  .signature { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ccc; }
  .footer { margin-top: 30px; font-size: 9px; color: #888; border-top: 1px solid #ccc; padding-top: 15px; text-align: center; }
  .schedule-header { background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 15px 0; font-weight: bold; font-size: 14px; color: #FF5A00; text-align: center; }
  .agent-info { background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 11px; color: #555; }
  .policy-number { font-size: 16px; font-weight: bold; color: #FF5A00; }
  .amount-large { font-size: 20px; font-weight: bold; color: #FF5A00; }
  .excess { color: #222; font-weight: bold; }
  .limitations { font-size: 11px; color: #444; line-height: 1.8; }
  .exclusions { font-size: 11px; color: #444; line-height: 1.8; margin-left: 15px; }
  .highlight-box { background: #f0f7ff; border-left: 4px solid #0050B3; padding: 10px 15px; margin: 10px 0; font-size: 11px; color: #333; }
  .note { font-size: 10px; color: #666; font-style: italic; margin-top: 5px; }
  .impounded { color: #FF5A00; font-weight: bold; font-size: 11px; }
  .cert-footer { font-size: 9px; color: #888; text-align: center; margin-top: 20px; padding-top: 10px; border-top: 1px solid #ccc; }
  @media print { body { padding: 30px; } }
</style></head>
<body>
<div class="page">
  <div class="header">
    <div class="title">RAC INSURANCE</div>
    <div class="subtitle">dayinsure</div>
  </div>
  <div class="section"><div class="section-title">1. DESCRIPTION OF VEHICLES</div><div class="row"><span class="label">Registration Mark:</span><span class="value">${policy.vehicle.registration}</span></div></div>
  <div class="section"><div class="section-title">2. NAME OF POLICYHOLDER</div><div class="row"><span class="label">Policyholder:</span><span class="value">${fullName}</span></div></div>
  <div class="section"><div class="section-title">3. EFFECTIVE DATE OF THE COMMENCEMENT OF INSURANCE</div><div class="row"><span class="label">Start:</span><span class="value">${startDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${startDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div></div>
  <div class="section"><div class="section-title">4. DATE OF EXPIRY OF INSURANCE</div><div class="row"><span class="label">End:</span><span class="value">${endDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${endDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div></div>
  <div class="section"><div class="section-title">5. PERSONS OR CLASSES OF PERSONS ENTITLED TO DRIVE</div><div class="row"><span class="label">Driver:</span><span class="value">${fullName}</span></div></div>
  <div class="section"><div class="section-title">6. LIMITATIONS AS TO USE</div><div class="limitations"><p><strong>SUBJECT TO THE EXCLUSIONS BELOW:</strong></p><p>(a) Use for social, domestic or pleasure purposes.</p><p>(b) Use for travel to and from a place of paid employment.</p><p>(c) Use by the Policyholder in connection with the occupation of the Policyholder.</p></div></div>
  <div class="section"><div class="section-title">EXCLUSIONS</div><div class="exclusions"><p>(a) Use for hiring of the vehicle, the carriage of passengers or goods for payment, the carriage of goods or property which does not belong to you as a courier or for takeaway or fast food delivery.</p><p>(b) Use for any competitions, trial, performance test, race or trial of speed, including off road events whether between motor vehicles or otherwise, and irrespective of whether this takes place on any circuit or track, formed or otherwise and regardless of any statutory authorisation of any such event.</p><p>(c) Use to secure the release of a motor vehicle, which has been seized by, or on behalf of, any government or public authority.</p></div><p class="impounded">IMPOUNDED VEHICLES: This Short Term Insurance Certificate can be used for the purpose of recovering an impounded vehicle.</p></div>
  <div class="highlight-box"><p>I hereby certify that the Policy to which this Certificate relates satisfies the requirements of the relevant Law applicable in Great Britain, Northern Ireland, the Isle of Man, the Island of Guernsey, the Island of Jersey and the Island of Alderney.</p></div>
  <div class="signature"><p><strong>Signed on behalf of Aviva Insurance Limited (Authorised Insurers)</strong></p><p style="margin-top:10px;"><strong>Authorised Signatory</strong><br>Colm Holmes<br><span style="font-size:11px;color:#555;">Global CEO General Insurance</span></p></div>
  <div class="note"><p><strong>NOTE:</strong> For full details of the insurance cover reference should be made to the policy.</p><p><strong>ADVICE TO THIRD PARTIES:</strong> Nothing contained in this Certificate affects your right as a Third Party to make a claim. Any query relating to this insurance or any alteration should be referred to the Agent through whom the Insurance is arranged or the Aviva Office - address obtainable from the policy. The number under the heading 'CERTIFICATE NUMBER' should be quoted in all correspondence.</p><p><strong>TRANSFER OF INTEREST:</strong> This Certificate is not transferable.</p></div>
  <div style="text-align:center;margin:15px 0;padding:10px;background:#f8f9fa;border:1px solid #ddd;border-radius:4px;"><p style="font-weight:bold;color:#FF5A00;">THIS CERTIFICATE HAS BEEN PRODUCED ON A COMPUTER PRINTER AND IS NOT VALID IF ALTERED IN ANY WAY.</p></div>
  <div class="cert-footer"><p>Aviva Insurance Limited. Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH. Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority</p></div>
  <hr style="margin:30px 0; border:1px dashed #ccc;">
  <div style="margin-top:20px;">
    <div style="text-align:center;margin-bottom:15px;"><p style="font-size:16px;font-weight:bold;color:#FF5A00;">Aviva Insurance Limited</p><p style="font-size:10px;color:#888;">Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH. Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority.</p></div>
    <div class="schedule-header">YOUR SCHEDULE</div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;"><span><strong>Our Ref:</strong> ${policy.policyDetails.policyNumber}</span><span><strong>Produced On:</strong> ${today} at ${new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:15px;"><span><strong>Your policy starts on:</strong> ${startDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${startDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span><span><strong>Your policy expires on:</strong> ${endDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${endDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div>
    <div class="agent-info"><p><strong>Agent</strong></p><p>dayinsure.com Limited<br>Mara House<br>Tarporley Business Centre<br>Nantwich Road<br>Tarporley CW6 9UY<br>0333 005 0944</p></div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin:10px 0;"><span><strong>Type of policy</strong><br>Dayinsure Short Term Insurance from Aviva</span><span><strong>Policy Number</strong><br><span class="policy-number">${policy.policyDetails.policyNumber}</span></span></div>
    <div style="font-size:10px;color:#888;margin-bottom:10px;">This schedule forms part of your policy</div>
    <div style="margin:10px 0;"><p><strong>The Policy Holder</strong></p><p>${fullName}</p><p><strong>Address</strong></p><p>${policy.customer.addressLine1}${policy.customer.addressLine2 ? ', ' + policy.customer.addressLine2 : ''}, ${policy.customer.city}, ${policy.customer.postcode}</p></div>
    <div style="margin:10px 0;"><p><strong>Total Paid</strong></p><p class="amount-large">£${amount.toFixed(2)}</p><p style="font-size:10px;color:#666;">The total price includes Insurance Premium Tax (IPT) of £${ipt} An admin fee payable to Dayinsure of £${adminFee.toFixed(2)}</p></div>
    <div style="margin:10px 0;"><p><strong>Your Vehicle</strong></p><p><strong>Make:</strong> ${policy.vehicle.make}</p><p><strong>Model:</strong> ${policy.vehicle.model}</p><p><strong>Registration Mark:</strong> ${policy.vehicle.registration}</p></div>
    <div style="margin:10px 0;"><p><strong>Excess:</strong> <span class="excess">£250.00</span></p></div>
    <div style="margin:10px 0;"><p><strong>Persons entitled to drive:</strong> ${fullName}</p><p><strong>Date of Birth:</strong> ${policy.customer.dob}</p><p><strong>Licence:</strong> ${policy.customer.drivingLicense}</p></div>
    <div style="margin:10px 0;"><p><strong>Limitations as to use</strong></p><p style="font-size:11px;color:#444;">Use for social, domestic and pleasure purposes and business use by the Policyholder excluding the carriage of passengers or goods for hire or reward.</p></div>
    <div style="margin:15px 0;padding:10px;background:#f0f7ff;border-left:4px solid #FF5A00;"><p style="font-weight:bold;color:#FF5A00;">RAC Motor Legal Expenses Cover Included.</p><p style="font-size:10px;color:#555;">Refer to the separate RAC Motor Legal Expenses Policy Terms and Conditions for further information.</p></div>
    <div style="margin:15px 0;font-size:10px;color:#555;line-height:1.8;"><p>If the information in this Schedule is incorrect or does not meet your requirements, please tell us at once.</p><p>You are reminded of the need to notify any facts that we would take into account in our assessment or acceptance of this insurance. Failure to disclose all relevant facts may invalidate your policy, or result in your policy not operating fully. You should keep a written record of any information you give to us.</p></div>
    <div style="margin:15px 0;font-size:11px;font-weight:bold;color:#FF5A00;text-align:center;padding:10px;background:#f8f9fa;border:1px solid #ddd;border-radius:4px;">This policy is non renewable.</div>
    <div class="footer"><p>Aviva Insurance Limited. Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH.</p><p>This document is produced automatically and is valid only if unaltered.</p></div>
  </div>
</div>
</body></html>`;

    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ 
      format: 'A4', 
      printBackground: true,
      margin: { top: '30px', bottom: '30px', left: '30px', right: '30px' }
    });
    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=RAC_Policy_${policy.policyDetails.policyNumber}.pdf`,
    });
    res.send(pdfBuffer);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('PDF Error:', err);
    res.status(500).json({ message: 'Failed to generate PDF: ' + err.message });
  }
});

app.get('/api/public/policy/:token/html', async (req, res) => {
  try {
    const { token } = req.params;
    const policy = await Policy.findOne({ 'policyDetails.uniqueToken': token });
    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    const startDate = new Date(policy.policyDetails.startDate);
    const endDate = new Date(policy.policyDetails.endDate);
    const fullName = `${policy.customer.firstName} ${policy.customer.lastName}`;
    const amount = policy.policyDetails.amount;
    const ipt = (amount * 0.12).toFixed(2);
    const adminFee = 4.60;

    const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>RAC Insurance - Certificate</title>
<style>
  body { font-family: Arial, sans-serif; padding: 40px; color: #222; max-width: 800px; margin: 0 auto; line-height: 1.6; }
  .header { border-bottom: 3px solid #FF5A00; padding-bottom: 15px; margin-bottom: 25px; }
  .title { color: #FF5A00; font-size: 28px; font-weight: bold; }
  .subtitle { color: #0050B3; font-size: 18px; font-weight: bold; }
  .section { margin-bottom: 15px; }
  .section-title { font-weight: bold; font-size: 14px; color: #222; margin-bottom: 5px; }
  .row { display: flex; padding: 6px 0; border-bottom: 1px solid #eee; }
  .label { width: 220px; font-weight: bold; color: #555; }
  .value { flex: 1; }
  .signature { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ccc; }
  .footer { margin-top: 30px; font-size: 10px; color: #888; border-top: 1px solid #ccc; padding-top: 15px; text-align: center; }
  .schedule-header { background: #f8f9fa; padding: 12px; border-radius: 4px; margin: 15px 0; font-weight: bold; font-size: 16px; color: #FF5A00; text-align: center; }
  .agent-info { background: #f8f9fa; padding: 12px; border-radius: 4px; margin: 10px 0; font-size: 12px; color: #555; }
  .policy-number { font-size: 16px; font-weight: bold; color: #FF5A00; }
  .amount-large { font-size: 22px; font-weight: bold; color: #FF5A00; }
  .excess { color: #222; font-weight: bold; }
  .highlight-box { background: #f0f7ff; border-left: 4px solid #0050B3; padding: 12px 18px; margin: 10px 0; font-size: 12px; color: #333; }
  .note { font-size: 11px; color: #666; font-style: italic; margin-top: 5px; }
  .impounded { color: #FF5A00; font-weight: bold; }
  .cert-footer { font-size: 10px; color: #888; text-align: center; margin-top: 20px; padding-top: 10px; border-top: 1px solid #ccc; }
</style>
</head>
<body>
<div class="header"><div class="title">RAC INSURANCE</div><div class="subtitle">dayinsure</div></div>
<div class="section"><div class="section-title">1. DESCRIPTION OF VEHICLES</div><div class="row"><span class="label">Registration Mark:</span><span class="value">${policy.vehicle.registration}</span></div></div>
<div class="section"><div class="section-title">2. NAME OF POLICYHOLDER</div><div class="row"><span class="label">Policyholder:</span><span class="value">${fullName}</span></div></div>
<div class="section"><div class="section-title">3. EFFECTIVE DATE OF THE COMMENCEMENT OF INSURANCE</div><div class="row"><span class="label">Start:</span><span class="value">${startDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${startDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div></div>
<div class="section"><div class="section-title">4. DATE OF EXPIRY OF INSURANCE</div><div class="row"><span class="label">End:</span><span class="value">${endDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${endDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div></div>
<div class="section"><div class="section-title">5. PERSONS OR CLASSES OF PERSONS ENTITLED TO DRIVE</div><div class="row"><span class="label">Driver:</span><span class="value">${fullName}</span></div></div>
<div class="section"><div class="section-title">6. LIMITATIONS AS TO USE</div><div style="font-size:12px; color:#444; line-height:1.8;"><p><strong>SUBJECT TO THE EXCLUSIONS BELOW:</strong></p><p>(a) Use for social, domestic or pleasure purposes.</p><p>(b) Use for travel to and from a place of paid employment.</p><p>(c) Use by the Policyholder in connection with the occupation of the Policyholder.</p></div></div>
<div class="section"><div class="section-title">EXCLUSIONS</div><div style="font-size:12px; color:#444; line-height:1.8; margin-left:15px;"><p>(a) Use for hiring of the vehicle, the carriage of passengers or goods for payment, the carriage of goods or property which does not belong to you as a courier or for takeaway or fast food delivery.</p><p>(b) Use for any competitions, trial, performance test, race or trial of speed, including off road events whether between motor vehicles or otherwise, and irrespective of whether this takes place on any circuit or track, formed or otherwise and regardless of any statutory authorisation of any such event.</p><p>(c) Use to secure the release of a motor vehicle, which has been seized by, or on behalf of, any government or public authority.</p></div><p class="impounded">IMPOUNDED VEHICLES: This Short Term Insurance Certificate can be used for the purpose of recovering an impounded vehicle.</p></div>
<div class="highlight-box"><p>I hereby certify that the Policy to which this Certificate relates satisfies the requirements of the relevant Law applicable in Great Britain, Northern Ireland, the Isle of Man, the Island of Guernsey, the Island of Jersey and the Island of Alderney.</p></div>
<div class="signature"><p><strong>Signed on behalf of Aviva Insurance Limited (Authorised Insurers)</strong></p><p style="margin-top:10px;"><strong>Authorised Signatory</strong><br>Colm Holmes<br><span style="font-size:12px;color:#555;">Global CEO General Insurance</span></p></div>
<div class="note"><p><strong>NOTE:</strong> For full details of the insurance cover reference should be made to the policy.</p><p><strong>ADVICE TO THIRD PARTIES:</strong> Nothing contained in this Certificate affects your right as a Third Party to make a claim. Any query relating to this insurance or any alteration should be referred to the Agent through whom the Insurance is arranged or the Aviva Office - address obtainable from the policy.</p><p><strong>TRANSFER OF INTEREST:</strong> This Certificate is not transferable.</p></div>
<div style="text-align:center;margin:15px 0;padding:12px;background:#f8f9fa;border:1px solid #ddd;border-radius:4px;"><p style="font-weight:bold;color:#FF5A00;">THIS CERTIFICATE HAS BEEN PRODUCED ON A COMPUTER PRINTER AND IS NOT VALID IF ALTERED IN ANY WAY.</p></div>
<div class="cert-footer"><p>Aviva Insurance Limited. Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH.</p></div>
<hr style="margin:30px 0; border:1px dashed #ccc;">
<div style="margin-top:20px;">
<div style="text-align:center;margin-bottom:15px;"><p style="font-size:16px;font-weight:bold;color:#FF5A00;">Aviva Insurance Limited</p><p style="font-size:10px;color:#888;">Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH.</p></div>
<div class="schedule-header">YOUR SCHEDULE</div>
<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;"><span><strong>Our Ref:</strong> ${policy.policyDetails.policyNumber}</span><span><strong>Produced On:</strong> ${new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div>
<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:15px;"><span><strong>Your policy starts on:</strong> ${startDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${startDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span><span><strong>Your policy expires on:</strong> ${endDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })} at ${endDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</span></div>
<div class="agent-info"><p><strong>Agent</strong></p><p>dayinsure.com Limited<br>Mara House<br>Tarporley Business Centre<br>Nantwich Road<br>Tarporley CW6 9UY<br>0333 005 0944</p></div>
<div style="display:flex;justify-content:space-between;font-size:12px;margin:10px 0;"><span><strong>Type of policy</strong><br>Dayinsure Short Term Insurance from Aviva</span><span><strong>Policy Number</strong><br><span class="policy-number">${policy.policyDetails.policyNumber}</span></span></div>
<div style="font-size:11px;color:#888;margin-bottom:10px;">This schedule forms part of your policy</div>
<div style="margin:10px 0;"><p><strong>The Policy Holder</strong></p><p>${fullName}</p><p><strong>Address</strong></p><p>${policy.customer.addressLine1}${policy.customer.addressLine2 ? ', ' + policy.customer.addressLine2 : ''}, ${policy.customer.city}, ${policy.customer.postcode}</p></div>
<div style="margin:10px 0;"><p><strong>Total Paid</strong></p><p class="amount-large">£${amount.toFixed(2)}</p><p style="font-size:11px;color:#666;">The total price includes Insurance Premium Tax (IPT) of £${ipt} An admin fee payable to Dayinsure of £${adminFee.toFixed(2)}</p></div>
<div style="margin:10px 0;"><p><strong>Your Vehicle</strong></p><p><strong>Make:</strong> ${policy.vehicle.make}</p><p><strong>Model:</strong> ${policy.vehicle.model}</p><p><strong>Registration Mark:</strong> ${policy.vehicle.registration}</p></div>
<div style="margin:10px 0;"><p><strong>Excess:</strong> <span class="excess">£250.00</span></p></div>
<div style="margin:10px 0;"><p><strong>Persons entitled to drive:</strong> ${fullName}</p><p><strong>Date of Birth:</strong> ${policy.customer.dob}</p><p><strong>Licence:</strong> ${policy.customer.drivingLicense}</p></div>
<div style="margin:10px 0;"><p><strong>Limitations as to use</strong></p><p style="font-size:12px;color:#444;">Use for social, domestic and pleasure purposes and business use by the Policyholder excluding the carriage of passengers or goods for hire or reward.</p></div>
<div style="margin:15px 0;padding:12px;background:#f0f7ff;border-left:4px solid #FF5A00;"><p style="font-weight:bold;color:#FF5A00;">RAC Motor Legal Expenses Cover Included.</p><p style="font-size:11px;color:#555;">Refer to the separate RAC Motor Legal Expenses Policy Terms and Conditions for further information.</p></div>
<div style="margin:15px 0;font-size:11px;color:#555;line-height:1.8;"><p>If the information in this Schedule is incorrect or does not meet your requirements, please tell us at once.</p><p>You are reminded of the need to notify any facts that we would take into account in our assessment or acceptance of this insurance. Failure to disclose all relevant facts may invalidate your policy, or result in your policy not operating fully. You should keep a written record of any information you give to us.</p></div>
<div style="margin:15px 0;font-size:12px;font-weight:bold;color:#FF5A00;text-align:center;padding:12px;background:#f8f9fa;border:1px solid #ddd;border-radius:4px;">This policy is non renewable.</div>
</div>
<div style="margin-top:30px;font-size:10px;color:#888;border-top:1px solid #ccc;padding-top:15px;text-align:center;"><p>Aviva Insurance Limited. Registered in Scotland Number 2116. Registered Office: Pitheavlis, Perth PH2 0NH.</p><p>This document is produced automatically and is valid only if unaltered.</p></div>
</body></html>`;

    res.set({
      'Content-Type': 'text/html',
      'Content-Disposition': `inline; filename=RAC_Certificate_${policy.policyDetails.policyNumber}.html`,
    });
    res.send(htmlContent);

  } catch (err) {
    console.error('HTML Error:', err);
    res.status(500).json({ message: 'Failed to generate document: ' + err.message });
  }
});

// ============================================================
// CHAT ROUTES
// ============================================================

app.post('/api/public/messages', async (req, res) => {
  try {
    const { token, message } = req.body;
    if (!token || !message) {
      return res.status(400).json({ message: 'Token and message are required' });
    }

    const policy = await Policy.findOne({ 'policyDetails.uniqueToken': token });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });

    const newMessage = new Message({
      policyToken: token,
      sender: 'customer',
      message: message,
      customerEmail: policy.customer.email,
      read: false
    });
    await newMessage.save();

    await Typing.findOneAndUpdate(
      { policyToken: token },
      { isTyping: false },
      { upsert: true }
    );

    res.status(201).json({ message: 'Message sent successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/public/messages/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const messages = await Message.find({ policyToken: token }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/messages', authenticate, async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: -1 });
    const grouped = {};
    for (const msg of messages) {
      if (!grouped[msg.policyToken]) {
        grouped[msg.policyToken] = [];
      }
      grouped[msg.policyToken].push(msg);
    }
    const result = [];
    for (const [token, msgs] of Object.entries(grouped)) {
      const policy = await Policy.findOne({ 'policyDetails.uniqueToken': token });
      const unreadCount = msgs.filter(m => !m.read && m.sender === 'customer').length;
      result.push({
        policyToken: token,
        customerName: policy ? `${policy.customer.firstName} ${policy.customer.lastName}` : 'Unknown',
        customerEmail: policy ? policy.customer.email : 'Unknown',
        messages: msgs,
        unreadCount,
        lastMessage: msgs[0]?.createdAt || null
      });
    }
    result.sort((a, b) => {
      if (!a.lastMessage) return 1;
      if (!b.lastMessage) return -1;
      return new Date(b.lastMessage) - new Date(a.lastMessage);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/messages/reply', authenticate, async (req, res) => {
  try {
    const { policyToken, message } = req.body;
    if (!policyToken || !message) {
      return res.status(400).json({ message: 'Policy token and message are required' });
    }

    const newMessage = new Message({
      policyToken,
      sender: 'admin',
      message: message,
      adminId: req.admin._id,
      read: true
    });
    await newMessage.save();

    await Typing.findOneAndUpdate(
      { policyToken },
      { isTyping: false },
      { upsert: true }
    );

    res.status(201).json({ message: 'Reply sent successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/admin/messages/:token/read', authenticate, async (req, res) => {
  try {
    const { token } = req.params;
    await Message.updateMany(
      { policyToken: token, sender: 'customer', read: false },
      { read: true }
    );
    res.json({ message: 'Messages marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/typing', async (req, res) => {
  try {
    const { token, isTyping, sender } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required' });

    await Typing.findOneAndUpdate(
      { policyToken: token },
      { isTyping, sender: sender || 'customer', updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/typing/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const typing = await Typing.findOne({ policyToken: token });
    if (!typing) {
      return res.json({ isTyping: false });
    }
    if (new Date() - new Date(typing.updatedAt) > 10000) {
      typing.isTyping = false;
      await typing.save();
    }
    res.json({ isTyping: typing.isTyping, sender: typing.sender });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;

mongoose.connection.once('open', async () => {
  await seedAdmin();
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});