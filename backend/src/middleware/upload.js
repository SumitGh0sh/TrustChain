const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const path = require("path");
const fs = require("fs");
const config = require("../config/env");

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

const kybStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const ext = path.extname(file.originalname).replace(".", "").toLowerCase() || "png";
    const cleanName = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9]/g, "_");
    const isPdf = file.mimetype === "application/pdf" || ext === "pdf";
    return {
      folder: "trustchain/kyb",
      resource_type: isPdf ? "raw" : "image",
      format: ext,
      public_id: `kyb_${cleanName}_${Date.now()}`,
    };
  },
});

const productStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const ext = path.extname(file.originalname).replace(".", "").toLowerCase() || "png";
    const cleanName = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9]/g, "_");
    return {
      folder: "trustchain/products",
      resource_type: "image",
      format: ext === "jpg" ? "jpg" : ext === "webp" ? "webp" : "png",
      public_id: `product_${cleanName}_${Date.now()}`,
    };
  },
});

const reportStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const ext = path.extname(file.originalname).replace(".", "").toLowerCase() || "png";
    const cleanName = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9]/g, "_");
    return {
      folder: "trustchain/reports",
      resource_type: "image",
      format: ext === "jpg" ? "jpg" : ext === "webp" ? "webp" : "png",
      public_id: `report_${cleanName}_${Date.now()}`,
    };
  },
});

const kybFileFilter = (req, file, cb) => {
  const allowedMimes = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only PDF, PNG, and JPG documents are allowed for KYB."), false);
  }
};

const productImageFilter = (req, file, cb) => {
  const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid image type. Only JPG, PNG, and WEBP images are allowed."), false);
  }
};

const uploadKybDocs = multer({
  storage: kybStorage,
  fileFilter: kybFileFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

const uploadProductImages = multer({
  storage: productStorage,
  fileFilter: productImageFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
});

const uploadReportPhotos = multer({
  storage: reportStorage,
  fileFilter: productImageFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
});

const kybUploadDir = path.resolve(__dirname, "..", "..", "uploads", "kyb");
const productUploadDir = path.resolve(__dirname, "..", "..", "uploads", "products");
const reportUploadDir = path.resolve(__dirname, "..", "..", "uploads", "reports");

[kybUploadDir, productUploadDir, reportUploadDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

module.exports = {
  uploadKybDocs,
  uploadProductImages,
  uploadReportPhotos,
  cloudinary,
  kybUploadDir,
  productUploadDir,
  reportUploadDir,
};

