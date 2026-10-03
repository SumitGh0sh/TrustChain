const Product = require('../models/Product');
const Brand = require('../models/Brand');
const { ROLES } = require('../constants/roles');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * @desc Create a new product with optional image uploads
 * @route POST /api/v1/products
 */
const createProduct = async (req, res, next) => {
  try {
    const { name, category, description, sku, price } = req.body;
    const manufacturerId = req.user._id;

    // Check for SKU collision under this manufacturer
    const existing = await Product.findOne({
      manufacturer: manufacturerId,
      sku: sku.toUpperCase().trim(),
    });

    if (existing) {
      return errorResponse(
        res,
        `A product with SKU "${sku.toUpperCase().trim()}" already exists in your catalog.`,
        409,
        'SKU_ALREADY_EXISTS'
      );
    }

    // Retrieve manufacturer's Brand to link metadata
    const brand = await Brand.findOne({ manufacturer: manufacturerId });

    // Process uploaded images
    const images = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach((file, index) => {
        images.push({
          url: file.path || file.secure_url,
          filename: file.filename,
          originalName: file.originalname,
          path: file.path,
          mimetype: file.mimetype,
          size: file.size,
          isPrimary: index === 0, // First image marked as primary by default
        });
      });
    }

    const product = await Product.create({
      name,
      category,
      description: description || '',
      sku: sku.toUpperCase().trim(),
      price: price || 0,
      images,
      brand: brand?._id || null,
      brandName: brand?.companyName || req.user.companyName || '',
      manufacturer: manufacturerId,
      isActive: true,
    });

    return successResponse(
      res,
      {
        product,
        message: 'Product created successfully.',
      },
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * @desc List products with search, filter, and pagination
 *       Rule: A manufacturer sees ONLY their own products. Admin can view all.
 * @route GET /api/v1/products
 */
const getProducts = async (req, res, next) => {
  try {
    const { search, category, isActive, page = 1, limit = 10, manufacturerId } = req.query;

    const query = {};

    // 1. Strict Manufacturer Isolation
    if (req.user.role === ROLES.ADMIN && manufacturerId) {
      query.manufacturer = manufacturerId;
    } else if (req.user.role !== ROLES.ADMIN) {
      query.manufacturer = req.user._id; // Manufacturer only sees their own products!
    }

    // 2. Category Filter
    if (category) {
      query.category = new RegExp(`^${category.trim()}$`, 'i');
    }

    // 3. Status Filter
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // 4. Search Filter (by name, sku, description, category)
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: searchRegex },
        { sku: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
      ];
    }

    // 5. Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [products, totalItems] = await Promise.all([
      Product.find(query)
        .populate('brand', 'companyName status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Product.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalItems / limitNum) || 1;

    return successResponse(res, {
      products,
      pagination: {
        totalItems,
        totalPages,
        currentPage: pageNum,
        limit: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Get single product detail by ID (scoped to owner manufacturer)
 * @route GET /api/v1/products/:id
 */
const getProductById = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).populate('brand', 'companyName status');

    if (!product) {
      return errorResponse(res, 'Product not found.', 404, 'PRODUCT_NOT_FOUND');
    }

    // Check ownership: manufacturer only views their own product
    if (req.user.role !== ROLES.ADMIN && product.manufacturer.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'You do not have permission to view this product.', 403, 'FORBIDDEN');
    }

    return successResponse(res, {
      product,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Update a product (details and/or add images)
 * @route PUT /api/v1/products/:id
 */
const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return errorResponse(res, 'Product not found.', 404, 'PRODUCT_NOT_FOUND');
    }

    // Check ownership
    if (req.user.role !== ROLES.ADMIN && product.manufacturer.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'You do not have permission to modify this product.', 403, 'FORBIDDEN');
    }

    const { name, category, description, sku, price, isActive } = req.body;

    // Check if new SKU collides with another product
    if (sku && sku.toUpperCase().trim() !== product.sku) {
      const existing = await Product.findOne({
        manufacturer: product.manufacturer,
        sku: sku.toUpperCase().trim(),
        _id: { $ne: product._id },
      });
      if (existing) {
        return errorResponse(
          res,
          `A product with SKU "${sku.toUpperCase().trim()}" already exists.`,
          409,
          'SKU_ALREADY_EXISTS'
        );
      }
      product.sku = sku.toUpperCase().trim();
    }

    if (name) product.name = name.trim();
    if (category) product.category = category.trim();
    if (description !== undefined) product.description = description.trim();
    if (price !== undefined) product.price = Number(price);
    if (isActive !== undefined) product.isActive = isActive === true || isActive === 'true';

    // Append newly uploaded images if any
    if (req.files && req.files.length > 0) {
      const hasExistingPrimary = product.images.some(img => img.isPrimary);
      req.files.forEach((file, index) => {
        product.images.push({
          url: file.path || file.secure_url,
          filename: file.filename,
          originalName: file.originalname,
          path: file.path,
          mimetype: file.mimetype,
          size: file.size,
          isPrimary: !hasExistingPrimary && index === 0,
        });
      });
    }

    await product.save();

    return successResponse(res, {
      product,
      message: 'Product updated successfully.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Delete a product
 * @route DELETE /api/v1/products/:id
 */
const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return errorResponse(res, 'Product not found.', 404, 'PRODUCT_NOT_FOUND');
    }

    if (req.user.role !== ROLES.ADMIN && product.manufacturer.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'You do not have permission to delete this product.', 403, 'FORBIDDEN');
    }

    await product.deleteOne();

    return successResponse(res, {
      productId: req.params.id,
      message: 'Product deleted successfully from catalog.',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
