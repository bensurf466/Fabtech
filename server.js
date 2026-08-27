require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── CONFIG ──────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://FABTECH:Fabtech@exhibition.6dlhmwy.mongodb.net/?appName=EXHIBITION';
const JWT_SECRET = process.env.JWT_SECRET || 'fabtech_secret_2026';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'o3wq4srt',
  api_key: process.env.CLOUDINARY_API_KEY || '928473485518452',
  api_secret: process.env.CLOUDINARY_API_SECRET || '0jnqMA1RtlEP1niW2SXw9Mla20Q',
});

console.log('✅ Cloudinary configured');

// ─── CORS ────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ─── MULTER SETUP ──────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tiff', '.mp4', '.webm', '.mov', '.avi'];
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') ||
        allowedExts.includes(ext) || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Received: ${file.mimetype}`), false);
    }
  }
});

// ─── DATABASE ──────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ DB error:', err.message));

// ─── MODELS ────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const HomeSchema = new mongoose.Schema({
  type: { type: String, enum: ['category', 'video'], required: true },
  title: { type: String, required: true },
  icon: { type: String, default: '' },
  description: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  publicId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
const Home = mongoose.model('Home', HomeSchema);

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
});
const Project = mongoose.model('Project', ProjectSchema);

const TeamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, required: true },
  bio: { type: String, default: '' },
  photo: { publicId: String, url: String },
  createdAt: { type: Date, default: Date.now },
});
const Team = mongoose.model('Team', TeamSchema);

const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
});
const Setting = mongoose.model('Setting', SettingSchema);

const ServiceSchema = new mongoose.Schema({
  title: { type: String, required: true, unique: true },
  images: [{ type: String }],
  publicIds: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const Service = mongoose.model('Service', ServiceSchema);

// ─── AUTH HELPERS ──────────────────────────────────
function generateToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── IMAGE PROCESSING (HEIC support WITHOUT Sharp) ──
async function processImage(buffer, originalName) {
  try {
    const ext = path.extname(originalName).toLowerCase();
    const isHeic = ext === '.heic' || ext === '.heif';

    let imageBuffer = buffer;

    // Step 1: Convert HEIC to JPEG using heic-convert (NO Sharp)
    if (isHeic) {
      try {
        console.log('🔄 Converting HEIC to JPEG using heic-convert...');
        const outputBuffer = await heicConvert({
          buffer: buffer,
          format: 'JPEG',
          quality: 0.9,
        });
        imageBuffer = outputBuffer;
        console.log('✅ HEIC converted to JPEG successfully');
      } catch (heicError) {
        console.error('❌ HEIC conversion failed:', heicError.message);
        // If HEIC conversion fails, try Sharp as fallback (may work on some systems)
        try {
          console.log('🔄 Trying Sharp as fallback...');
          const sharpBuffer = await sharp(buffer)
            .jpeg({ quality: 80 })
            .toBuffer();
          imageBuffer = sharpBuffer;
          console.log('✅ Sharp fallback succeeded');
        } catch (sharpFallbackError) {
          console.error('❌ Sharp fallback also failed:', sharpFallbackError.message);
          return buffer;
        }
      }
    }

    // Step 2: Resize and optimize with Sharp (now working with JPEG)
    try {
      const processed = await sharp(imageBuffer)
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      return processed;
    } catch (sharpError) {
      console.error('❌ Sharp processing failed:', sharpError.message);
      return imageBuffer;
    }
  } catch (err) {
    console.error('❌ processImage error:', err.message);
    return buffer;
  }
}

// ─── CLOUDINARY UPLOAD ────────────────────────────
async function uploadToCloudinary(buffer, folder = 'fabtech', resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (error, result) => {
        if (error) {
          console.error('❌ Cloudinary upload error:', error);
          reject(error);
        } else {
          console.log('✅ Cloudinary upload success:', result.secure_url);
          resolve(result);
        }
      }
    );
    uploadStream.write(buffer);
    uploadStream.end();
  });
}

// ─── AUTH ROUTES ────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const count = await User.countDocuments();
    const user = new User({
      name,
      email: email.toLowerCase(),
      phone,
      password: hashed,
      role: count === 0 ? 'admin' : 'user',
    });
    await user.save();
    const token = generateToken(user);
    res.status(201).json({
      token,
      user: { id: user._id, name, email: user.email, phone, role: user.role },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(user);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HOME ROUTES ────────────────────────────────────
app.get('/api/home', async (req, res) => {
  try {
    const items = await Home.find().sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error('GET /api/home error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/home/:id', async (req, res) => {
  try {
    const item = await Home.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/home', verifyToken, adminOnly, upload.single('media'), async (req, res) => {
  try {
    const { type, title, icon, description } = req.body;
    if (!type || !title) {
      return res.status(400).json({ error: 'Type and title are required' });
    }
    let mediaUrl = '', publicId = '';
    if (req.file) {
      const isVideo = req.file.mimetype.startsWith('video/');
      const processedBuffer = isVideo ? req.file.buffer : await processImage(req.file.buffer, req.file.originalname);
      const result = await uploadToCloudinary(processedBuffer, 'fabtech/home', isVideo ? 'video' : 'image');
      mediaUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`📤 Home upload: ${isVideo ? 'video' : 'image'} -> ${mediaUrl}`);
    }
    const item = new Home({ type, title, icon: icon || '', description: description || '', mediaUrl, publicId });
    await item.save();
    res.status(201).json(item);
  } catch (err) {
    console.error('POST /api/home error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/home/:id', verifyToken, adminOnly, upload.single('media'), async (req, res) => {
  try {
    const item = await Home.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { type, title, icon, description } = req.body;
    let mediaUrl = item.mediaUrl, publicId = item.publicId;
    if (req.file) {
      if (item.publicId) await cloudinary.uploader.destroy(item.publicId).catch(() => {});
      const isVideo = req.file.mimetype.startsWith('video/');
      const processedBuffer = isVideo ? req.file.buffer : await processImage(req.file.buffer, req.file.originalname);
      const result = await uploadToCloudinary(processedBuffer, 'fabtech/home', isVideo ? 'video' : 'image');
      mediaUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`📤 Home update: ${isVideo ? 'video' : 'image'} -> ${mediaUrl}`);
    }
    item.type = type || item.type;
    item.title = title || item.title;
    item.icon = icon !== undefined ? icon : item.icon;
    item.description = description !== undefined ? description : item.description;
    item.mediaUrl = mediaUrl;
    item.publicId = publicId;
    await item.save();
    res.json(item);
  } catch (err) {
    console.error('PUT /api/home error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/home/:id', verifyToken, adminOnly, async (req, res) => {
  try {
    const item = await Home.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.publicId) await cloudinary.uploader.destroy(item.publicId).catch(() => {});
    await item.deleteOne();
    res.json({ message: 'Home item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PROJECT ROUTES ─────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const { category, mediaType } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (mediaType) filter.mediaType = mediaType;
    const items = await Project.find(filter).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const item = await Project.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Project not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', verifyToken, adminOnly, upload.single('media'), async (req, res) => {
  try {
    const { category, mediaType, heading, description } = req.body;
    if (!category || !mediaType || !heading) {
      return res.status(400).json({ error: 'Category, mediaType, and heading are required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Media file is required' });
    }
    const isVideo = mediaType === 'video' || req.file.mimetype.startsWith('video/');
    const processedBuffer = isVideo ? req.file.buffer : await processImage(req.file.buffer, req.file.originalname);
    const result = await uploadToCloudinary(processedBuffer, 'fabtech/projects', isVideo ? 'video' : 'image');
    console.log(`📤 Project upload: ${isVideo ? 'video' : 'photo'} -> ${result.secure_url}`);
    const project = new Project({
      category,
      mediaType,
      heading,
      description: description || '',
      mediaUrl: result.secure_url,
      publicId: result.public_id,
    });
    await project.save();
    res.status(201).json(project);
  } catch (err) {
    console.error('POST /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', verifyToken, adminOnly, upload.single('media'), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { category, mediaType, heading, description } = req.body;
    let mediaUrl = project.mediaUrl, publicId = project.publicId;
    if (req.file) {
      if (project.publicId) await cloudinary.uploader.destroy(project.publicId).catch(() => {});
      const isVideo = mediaType === 'video' || req.file.mimetype.startsWith('video/');
      const processedBuffer = isVideo ? req.file.buffer : await processImage(req.file.buffer, req.file.originalname);
      const result = await uploadToCloudinary(processedBuffer, 'fabtech/projects', isVideo ? 'video' : 'image');
      mediaUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`📤 Project update: ${isVideo ? 'video' : 'photo'} -> ${mediaUrl}`);
    }
    project.category = category || project.category;
    project.mediaType = mediaType || project.mediaType;
    project.heading = heading || project.heading;
    project.description = description !== undefined ? description : project.description;
    project.mediaUrl = mediaUrl;
    project.publicId = publicId;
    await project.save();
    res.json(project);
  } catch (err) {
    console.error('PUT /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', verifyToken, adminOnly, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.publicId) await cloudinary.uploader.destroy(project.publicId).catch(() => {});
    await project.deleteOne();
    res.json({ message: 'Project deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEAM ROUTES ────────────────────────────────────
app.get('/api/team', async (req, res) => {
  try {
    const members = await Team.find().sort({ createdAt: -1 });
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/:id', async (req, res) => {
  try {
    const member = await Team.findById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/team', verifyToken, adminOnly, upload.single('photo'), async (req, res) => {
  try {
    const { name, role, bio } = req.body;
    if (!name || !role) {
      return res.status(400).json({ error: 'Name and role are required' });
    }
    let photoUrl = '', publicId = '';
    if (req.file) {
      const processedBuffer = await processImage(req.file.buffer, req.file.originalname);
      const result = await uploadToCloudinary(processedBuffer, 'fabtech/team', 'image');
      photoUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`📤 Team photo upload -> ${photoUrl}`);
    }
    const member = new Team({ name, role, bio: bio || '', photo: { url: photoUrl, publicId } });
    await member.save();
    res.status(201).json(member);
  } catch (err) {
    console.error('POST /api/team error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/team/:id', verifyToken, adminOnly, upload.single('photo'), async (req, res) => {
  try {
    const member = await Team.findById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    const { name, role, bio } = req.body;
    let photoUrl = member.photo?.url || '', publicId = member.photo?.publicId || '';
    if (req.file) {
      if (member.photo?.publicId) await cloudinary.uploader.destroy(member.photo.publicId).catch(() => {});
      const processedBuffer = await processImage(req.file.buffer, req.file.originalname);
      const result = await uploadToCloudinary(processedBuffer, 'fabtech/team', 'image');
      photoUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`📤 Team photo update -> ${photoUrl}`);
    }
    member.name = name || member.name;
    member.role = role || member.role;
    member.bio = bio !== undefined ? bio : member.bio;
    member.photo = { url: photoUrl, publicId };
    await member.save();
    res.json(member);
  } catch (err) {
    console.error('PUT /api/team error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/team/:id', verifyToken, adminOnly, async (req, res) => {
  try {
    const member = await Team.findById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    if (member.photo?.publicId) await cloudinary.uploader.destroy(member.photo.publicId).catch(() => {});
    await member.deleteOne();
    res.json({ message: 'Team member deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SETTINGS ROUTES ────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const obj = {};
    settings.forEach((s) => (obj[s.key] = s.value));
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/:key', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: req.params.key });
    if (!setting) return res.status(404).json({ error: 'Setting not found' });
    res.json({ value: setting.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/:key', verifyToken, adminOnly, upload.single('media'), async (req, res) => {
  try {
    if (req.params.key === 'heroVideo' && req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'fabtech/hero', 'video');
      const setting = await Setting.findOneAndUpdate(
        { key: req.params.key },
        { key: req.params.key, value: result.secure_url },
        { new: true, upsert: true }
      );
      console.log(`📤 Hero video uploaded -> ${result.secure_url}`);
      return res.json(setting);
    }
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Value is required' });
    const setting = await Setting.findOneAndUpdate(
      { key: req.params.key },
      { key: req.params.key, value },
      { new: true, upsert: true }
    );
    res.json(setting);
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVICES ROUTES ──────────────────────────────
app.get('/api/services', async (req, res) => {
  try {
    const services = await Service.find().sort({ title: 1 });
    res.json(services);
  } catch (err) {
    console.error('GET /api/services error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services/:title', async (req, res) => {
  try {
    const service = await Service.findOne({ title: req.params.title });
    if (!service) {
      return res.json({ title: req.params.title, images: [], publicIds: [] });
    }
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/services/:title', verifyToken, adminOnly, upload.array('images', 6), async (req, res) => {
  try {
    const title = req.params.title;
    let service = await Service.findOne({ title });
    if (!service) {
      service = new Service({ title, images: [], publicIds: [] });
    }

    if (req.files && req.files.length > 0) {
      const currentCount = service.images.length;
      const maxNew = 6 - currentCount;
      if (maxNew <= 0) {
        return res.status(400).json({ error: 'Maximum 6 images allowed per service' });
      }

      const filesToUpload = req.files.slice(0, maxNew);
      for (const file of filesToUpload) {
        try {
          const processedBuffer = await processImage(file.buffer, file.originalname);
          const result = await uploadToCloudinary(processedBuffer, 'fabtech/services', 'image');
          service.images.push(result.secure_url);
          service.publicIds.push(result.public_id);
          console.log(`📤 Service image uploaded -> ${result.secure_url}`);
        } catch (err) {
          console.error('Upload error:', err);
        }
      }
    }

    service.updatedAt = Date.now();
    await service.save();
    res.json(service);
  } catch (err) {
    console.error('PUT /api/services error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/services/:title/image', verifyToken, adminOnly, async (req, res) => {
  try {
    const { title } = req.params;
    const { publicId } = req.query;
    if (!publicId) {
      return res.status(400).json({ error: 'publicId is required' });
    }

    const service = await Service.findOne({ title });
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const index = service.publicIds.indexOf(publicId);
    if (index === -1) return res.status(404).json({ error: 'Image not found' });

    await cloudinary.uploader.destroy(publicId).catch(() => {});

    service.images.splice(index, 1);
    service.publicIds.splice(index, 1);
    service.updatedAt = Date.now();
    await service.save();
    res.json(service);
  } catch (err) {
    console.error('DELETE /api/services/image error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/services/:title', verifyToken, adminOnly, async (req, res) => {
  try {
    const service = await Service.findOne({ title: req.params.title });
    if (!service) return res.status(404).json({ error: 'Service not found' });

    for (const publicId of service.publicIds) {
      await cloudinary.uploader.destroy(publicId).catch(() => {});
    }

    await service.deleteOne();
    res.json({ message: 'Service deleted' });
  } catch (err) {
    console.error('DELETE /api/services error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── TEST & STATIC ──────────────────────────────────
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Server is alive!' });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer error:', err);
    return res.status(400).json({ error: err.message });
  }
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── START ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Home: http://localhost:${PORT}/`);
  console.log(`🔐 Admin: http://localhost:${PORT}/admin`);
  console.log(`🧪 Test: http://localhost:${PORT}/api/test`);
});