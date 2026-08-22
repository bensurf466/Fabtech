require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const path = require('path');

// =====================================================
// 1. EXPRESS APP SETUP
// =====================================================
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files (for admin.html and pictures)
app.use(express.static(path.join(__dirname)));

// =====================================================
// 2. CLOUDINARY CONFIG
// =====================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =====================================================
// 3. MONGODB MODELS (All in one file)
// =====================================================

// --- AdminUser Model ---
const AdminUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  createdAt: { type: Date, default: Date.now },
});

AdminUserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

AdminUserSchema.methods.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

const AdminUser = mongoose.model('AdminUser', AdminUserSchema);

// --- Exhibition Model ---
const ExhibitionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  location: { type: String, required: true },
  status: { type: String, enum: ['upcoming', 'ongoing', 'past'], default: 'upcoming' },
  featuredImage: { publicId: String, url: String },
  galleryImages: [{ publicId: String, url: String }],
  videos: [{ publicId: String, url: String, title: String }],
  customSections: [{ type: { type: String, enum: ['text', 'image', 'video'] }, content: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Exhibition = mongoose.model('Exhibition', ExhibitionSchema);

// --- Project Model ---
const ProjectSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    enum: ['Exhibition', 'Gala Dinner', 'Trade Show', 'Product Launch', 'Road Show', 'Opening Ceremony'],
  },
  mediaType: { type: String, required: true, enum: ['photo', 'video'] },
  heading: { type: String, required: true },
  description: { type: String, default: '' },
  mediaUrl: { type: String, required: true },
  publicId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Project = mongoose.model('Project', ProjectSchema);

// --- TeamMember Model ---
const TeamMemberSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, required: true },
  bio: { type: String, default: '' },
  photo: { publicId: String, url: String },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const TeamMember = mongoose.model('TeamMember', TeamMemberSchema);

// --- Setting Model ---
const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const Setting = mongoose.model('Setting', SettingSchema);

// =====================================================
// 4. MIDDLEWARE (Auth & Admin Only)
// =====================================================
const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

// =====================================================
// 5. AUTH ROUTES
// =====================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    const existingUser = await AdminUser.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered.' });
    }
    const count = await AdminUser.countDocuments();
    const role = count === 0 ? 'admin' : 'user';
    const user = new AdminUser({ name, email, phone, password, role });
    await user.save();
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await AdminUser.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await AdminUser.findById(req.user.id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 6. EXHIBITION ROUTES
// =====================================================
app.get('/api/exhibitions', async (req, res) => {
  try {
    const exhibitions = await Exhibition.find().sort({ createdAt: -1 });
    res.json(exhibitions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exhibitions/:slug', async (req, res) => {
  try {
    const exhibition = await Exhibition.findOne({ slug: req.params.slug });
    if (!exhibition) return res.status(404).json({ error: 'Exhibition not found.' });
    res.json(exhibition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/exhibitions', auth, adminOnly, async (req, res) => {
  try {
    const exhibition = new Exhibition(req.body);
    await exhibition.save();
    res.status(201).json(exhibition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/exhibitions/:id', auth, adminOnly, async (req, res) => {
  try {
    const exhibition = await Exhibition.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!exhibition) return res.status(404).json({ error: 'Exhibition not found.' });
    res.json(exhibition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/exhibitions/:id', auth, adminOnly, async (req, res) => {
  try {
    const exhibition = await Exhibition.findByIdAndDelete(req.params.id);
    if (!exhibition) return res.status(404).json({ error: 'Exhibition not found.' });
    res.json({ message: 'Exhibition deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 7. PROJECT ROUTES
// =====================================================
app.get('/api/projects', async (req, res) => {
  try {
    const { category, mediaType } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (mediaType) filter.mediaType = mediaType;
    const projects = await Project.find(filter).sort({ createdAt: -1 });
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', auth, adminOnly, async (req, res) => {
  try {
    const project = new Project(req.body);
    await project.save();
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', auth, adminOnly, async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', auth, adminOnly, async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json({ message: 'Project deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 8. TEAM ROUTES
// =====================================================
app.get('/api/team', async (req, res) => {
  try {
    const team = await TeamMember.find().sort({ order: 1, createdAt: -1 });
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/team/:id', async (req, res) => {
  try {
    const member = await TeamMember.findById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    res.json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/team', auth, adminOnly, async (req, res) => {
  try {
    const member = new TeamMember(req.body);
    await member.save();
    res.status(201).json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/team/:id', auth, adminOnly, async (req, res) => {
  try {
    const member = await TeamMember.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    res.json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/team/:id', auth, adminOnly, async (req, res) => {
  try {
    const member = await TeamMember.findByIdAndDelete(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    res.json({ message: 'Team member deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 9. SETTINGS ROUTES
// =====================================================
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.key] = s.value; });
    res.json(settingsObj);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings/:key', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: req.params.key });
    if (!setting) return res.status(404).json({ error: 'Setting not found.' });
    res.json({ value: setting.value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/settings/:key', auth, adminOnly, async (req, res) => {
  try {
    const { value } = req.body;
    const setting = await Setting.findOneAndUpdate(
      { key: req.params.key },
      { key: req.params.key, value, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    res.json(setting);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/settings/:key', auth, adminOnly, async (req, res) => {
  try {
    await Setting.findOneAndDelete({ key: req.params.key });
    res.json({ message: 'Setting deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 10. UPLOAD ROUTES (Cloudinary)
// =====================================================
app.post('/api/upload/sign', auth, adminOnly, (req, res) => {
  try {
    const timestamp = Math.round((new Date()).getTime() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      signature,
      timestamp,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/delete', auth, adminOnly, async (req, res) => {
  try {
    const { publicId } = req.body;
    if (!publicId) return res.status(400).json({ error: 'publicId is required.' });
    const result = await cloudinary.uploader.destroy(publicId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// 11. SERVE ADMIN PANEL
// =====================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// =====================================================
// 12. TEST ROUTE (to verify server is working)
// =====================================================
app.get('/api/test', (req, res) => {
  res.json({
    message: '✅ FABTECH Server is running!',
    timestamp: new Date().toISOString(),
    routes: {
      auth: '/api/auth/register, /api/auth/login, /api/auth/me',
      exhibitions: '/api/exhibitions',
      projects: '/api/projects',
      team: '/api/team',
      settings: '/api/settings',
      upload: '/api/upload/sign, /api/upload/delete',
      test: '/api/test',
      admin: '/admin'
    }
  });
});

// =====================================================
// 13. MONGODB CONNECTION & SERVER START
// =====================================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🧪 Test endpoint: http://localhost:${PORT}/api/test`);
});