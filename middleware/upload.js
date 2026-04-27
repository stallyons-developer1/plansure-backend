const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "../uploads/programmes");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const memoryStorage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype === "application/pdf") {
    cb(null, true);
  } else {
    cb(new Error("Only PDF files allowed"), false);
  }
};

const uploadToDisk = multer({
  storage: diskStorage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const uploadToMemory = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = { uploadToDisk, uploadToMemory };
