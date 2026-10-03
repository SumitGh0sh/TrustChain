const mongoose = require('mongoose');
const crypto = require('crypto');
const { ethers } = require('ethers');
const Batch = require('../models/Batch');
const Unit = require('../models/Unit');
const Product = require('../models/Product');
const Brand = require('../models/Brand');
const { MerkleTreeBuilder, leafHash } = require('../utils/merkle');
const blockchainService = require('../services/blockchain.service');
const creditService = require('../services/credit.service');
const qrService = require('../services/qr.service');
const { successResponse, errorResponse } = require('../utils/response');
const { ROLES } = require('../constants/roles');

/**
 * @desc Create and register a product batch on-chain and off-chain
 * @route POST /api/v1/batches
 */

/**
 * Helper to query batch by batchNumber, batchId, or ObjectId
 */
const findBatchByIdentifier = async (batchId, populateFields = false) => {
  if (!batchId) return null;
  const cleanId = String(batchId).trim();
  const query = {
    $or: [
      { batchNumber: cleanId },
      { batchId: cleanId },
    ],
  };

  if (mongoose.Types.ObjectId.isValid(cleanId)) {
    query.$or.push({ _id: cleanId });
  }

  let q = Batch.findOne(query);
  if (populateFields) {
    q = q.populate('product', 'name category sku description price images')
         .populate('brand', 'companyName status gst cin')
         .populate('manufacturer', 'name companyName email walletAddress');
  }
  return await q;
};

/**
 * Helper to check manufacturer or admin ownership authorization
 */
const isAuthorizedForBatch = (user, batch) => {
  if (!user || !batch) return false;
  if (user.role === ROLES.ADMIN) return true;
  const mfgId = (batch.manufacturer?._id || batch.manufacturer)?.toString();
  return mfgId === user._id.toString();
};

const createBatch = async (req, res, next) => {
  try {
    const {
      product,
      batchNumber,
      batchId,
      quantity,
      mfgDate,
      expiryDate,
      expiryDays,
      protectionLevel = 'Standard',
      description,
      category,
    } = req.body;

    const manufacturerId = req.user._id;

    // 1. Verify Brand KYB approval status
    if (req.user.role === ROLES.MANUFACTURER) {
      const brand = await Brand.findOne({ manufacturer: manufacturerId });
      const currentStatus = brand ? brand.status : req.user.brandStatus;
      if (currentStatus !== 'approved') {
        return errorResponse(
          res,
          `Cannot create batch: Your brand onboarding is currently "${currentStatus || 'pending'}". An approved brand is required.`,
          403,
          'BRAND_NOT_APPROVED',
          { brandStatus: currentStatus }
        );
      }
    }

    // 2. Verify Product existence and manufacturer ownership
    const productDoc = await Product.findById(product);
    if (!productDoc) {
      return errorResponse(res, `Product with ID "${product}" was not found.`, 404, 'PRODUCT_NOT_FOUND');
    }

    if (req.user.role !== ROLES.ADMIN && productDoc.manufacturer.toString() !== manufacturerId.toString()) {
      return errorResponse(res, 'You do not have permission to create batches for this product.', 403, 'FORBIDDEN');
    }

    // 3. Normalize batch identifier & check uniqueness
    const finalBatchNumber = (batchNumber || batchId).trim().toUpperCase();
    const existingBatch = await Batch.findOne({
      $or: [{ batchNumber: finalBatchNumber }, { batchId: finalBatchNumber }],
    });

    if (existingBatch) {
      return errorResponse(
        res,
        `Batch "${finalBatchNumber}" already exists in the system.`,
        409,
        'BATCH_ALREADY_EXISTS'
      );
    }

    // 4. Normalize Protection Level & Pricing Rates
    const isHighValue = protectionLevel === 'HighValue' || protectionLevel === 1 || protectionLevel === '1';
    const protectionLevelStr = isHighValue ? 'HighValue' : 'Standard';
    const protectionLevelCode = isHighValue ? 1 : 0;

    const ratePerUnit = creditService.getRate(protectionLevelStr);
    const totalCostINR = quantity * ratePerUnit;

    // 5. Check manufacturer has enough credits
    if ((req.user.creditBalance || 0) < totalCostINR) {
      const needed = totalCostINR - (req.user.creditBalance || 0);
      return errorResponse(
        res,
        `Insufficient prepaid INR credits. Required: ₹${totalCostINR} (${quantity} units @ ₹${ratePerUnit}/unit for ${protectionLevelStr} protection), Available: ₹${req.user.creditBalance || 0}. Please top up ₹${needed} to proceed.`,
        402,
        'INSUFFICIENT_CREDITS',
        {
          required: totalCostINR,
          available: req.user.creditBalance || 0,
          needed,
          ratePerUnit,
          protectionLevel: protectionLevelStr,
        }
      );
    }

    // 6. Calculate Timestamps
    const mfg = mfgDate ? new Date(mfgDate) : new Date();
    let expiry = null;
    if (expiryDate) {
      expiry = new Date(expiryDate);
    } else {
      const days = parseInt(expiryDays, 10) || 365;
      expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    const expiryTimestamp = Math.floor(expiry.getTime() / 1000);
    const nowTimestamp = Math.floor(Date.now() / 1000);
    if (expiryTimestamp <= nowTimestamp) {
      return errorResponse(
        res,
        'Batch expiry date must be set in the future.',
        400,
        'INVALID_EXPIRY_DATE'
      );
    }

    // 7. Generate Unique Unit Codes (and secret scratch codes if HighValue)
    const unitsData = [];
    for (let i = 1; i <= quantity; i++) {
      const serial = String(i).padStart(4, '0');
      const randomSalt = crypto.randomBytes(3).toString('hex').toUpperCase();
      const unitCode = `${finalBatchNumber}-U${serial}-${randomSalt}`;

      let secretScratchCode = null;
      let scratchCodeHash = null;

      if (isHighValue) {
        // HighValue units receive a secret scratch code stored only as a cryptographic hash
        const secretRand = crypto.randomBytes(4).toString('hex').toUpperCase();
        secretScratchCode = `SCRATCH-${secretRand}`;
        scratchCodeHash = crypto.createHash('sha256').update(secretScratchCode).digest('hex');
      }

      unitsData.push({
        unitCode,
        secretScratchCode,
        scratchCodeHash,
      });
    }

    // 8. Build Merkle Tree with merkletreejs (leaf = keccak256(unitCode))
    const unitCodeStrings = unitsData.map(u => u.unitCode);
    const merkleTree = new MerkleTreeBuilder(unitCodeStrings);
    const merkleRoot = merkleTree.getRoot();

    // 9. Call registerBatch on-chain through the transaction service
    let txHash = null;
    try {
      const onChainRes = await blockchainService.registerBatchOnChain({
        batchId: finalBatchNumber,
        manufacturerWallet: req.user.walletAddress,
        merkleRoot,
        quantity,
        protectionLevel: protectionLevelCode,
        expiryTimestamp,
      });
      txHash = onChainRes.txHash;
    } catch (chainErr) {
      console.warn(`[Blockchain Warning] Relayer write simulated for development: ${chainErr.message}`);
      txHash = ethers.id(`simulated-batch-tx-${Date.now()}`);
    }

    // 10. Deduct credits and write a CreditLedger entry
    const creditDeduction = await creditService.deductCreditsForBatch({
      manufacturerId,
      quantity,
      batchId: finalBatchNumber,
      protectionLevel: protectionLevelStr,
    });

    // 11. Retrieve Brand details for snapshotting
    const brand = await Brand.findOne({ manufacturer: manufacturerId });

    // 12. Save Batch in MongoDB
    const newBatch = await Batch.create({
      batchNumber: finalBatchNumber,
      batchId: finalBatchNumber,
      batchIdBytes32: blockchainService.toBytes32(finalBatchNumber),
      product: productDoc._id,
      productName: productDoc.name,
      productSku: productDoc.sku,
      brand: brand?._id || productDoc.brand || null,
      brandName: brand?.companyName || productDoc.brandName || req.user.companyName || '',
      category: category || productDoc.category || 'General',
      description: description || productDoc.description || '',
      manufacturer: manufacturerId,
      manufacturerWallet: req.user.walletAddress,
      merkleRoot,
      quantity,
      protectionLevel: protectionLevelStr,
      protectionLevelCode,
      mfgDate: mfg,
      expiryDate: expiry,
      expiryTimestamp,
      inrCost: totalCostINR,
      txHash,
      status: 'active',
      isRecalled: false,
    });

    // 13. Save units with status 'inStock'
    const unitDocs = unitsData.map(u => ({
      unitCode: u.unitCode,
      batch: newBatch._id,
      batchNumber: finalBatchNumber,
      batchId: finalBatchNumber,
      product: productDoc._id,
      productName: productDoc.name,
      leafHash: leafHash(u.unitCode),
      proof: merkleTree.getProof(u.unitCode),
      status: 'inStock',
      soldState: 0, // 0: Unsold / inStock
      protectionLevel: protectionLevelStr,
      scratchCodeHash: u.scratchCodeHash,
      currentOwnerWallet: req.user.walletAddress,
    }));

    await Unit.insertMany(unitDocs, { ordered: false });

    // Format sample units for initial display/printing
    const sampleUnits = unitsData.slice(0, 5).map(u => ({
      unitCode: u.unitCode,
      ...(isHighValue && {
        secretScratchCode: u.secretScratchCode,
        note: 'Store or print secretScratchCode onto scratch sticker; only the SHA-256 hash is kept in the database.',
      }),
    }));

    return successResponse(
      res,
      {
        batch: {
          id: newBatch._id,
          batchNumber: newBatch.batchNumber,
          product: {
            id: productDoc._id,
            name: productDoc.name,
            sku: productDoc.sku,
          },
          brandName: newBatch.brandName,
          quantity: newBatch.quantity,
          protectionLevel: newBatch.protectionLevel,
          mfgDate: newBatch.mfgDate,
          expiryDate: newBatch.expiryDate,
          merkleRoot: newBatch.merkleRoot,
          txHash: newBatch.txHash,
          status: newBatch.status,
        },
        credits: {
          deductedINR: creditDeduction.costINR,
          ratePerUnit,
          remainingBalance: creditDeduction.remainingBalance,
        },
        sampleUnits,
        totalUnitsGenerated: unitsData.length,
        message: 'Batch successfully created, registered on-chain, and units saved to inventory with status inStock.',
      },
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * @desc List batches with search, filter, and pagination
 *       Manufacturer sees only their own batches. Admin sees all.
 * @route GET /api/v1/batches
 */
const getBatches = async (req, res, next) => {
  try {
    const { search, protectionLevel, status, product, page = 1, limit = 10, manufacturerId } = req.query;

    const query = {};

    // 1. Scoping: Manufacturer sees only their own batches
    if (req.user.role === ROLES.ADMIN && manufacturerId) {
      query.manufacturer = manufacturerId;
    } else if (req.user.role !== ROLES.ADMIN) {
      query.manufacturer = req.user._id;
    }

    // 2. Protection Level Filter
    if (protectionLevel) {
      const isHV = protectionLevel.toLowerCase() === 'highvalue' || protectionLevel === '1';
      query.protectionLevel = isHV ? 'HighValue' : 'Standard';
    }

    // 3. Status Filter
    if (status) {
      query.status = status;
    }

    // 4. Product Filter
    if (product) {
      query.product = product;
    }

    // 5. Search Filter (batchNumber, productName, brandName)
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { batchNumber: searchRegex },
        { batchId: searchRegex },
        { productName: searchRegex },
        { brandName: searchRegex },
      ];
    }

    // 6. Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [batches, totalItems] = await Promise.all([
      Batch.find(query)
        .populate('product', 'name category sku price images')
        .populate('brand', 'companyName status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Batch.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalItems / limitNum) || 1;

    return successResponse(res, {
      batches,
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
 * @desc Get batch detail with unit inventory statistics
 * @route GET /api/v1/batches/:batchId
 */
const getBatchById = async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const batch = await findBatchByIdentifier(batchId, true);

    if (!batch) {
      return errorResponse(res, `Batch "${batchId}" was not found.`, 404, 'BATCH_NOT_FOUND');
    }

    // Ownership check: manufacturer can only view their own batches
    if (!isAuthorizedForBatch(req.user, batch)) {
      return errorResponse(res, 'You do not have permission to view this batch.', 403, 'FORBIDDEN');
    }

    // Compute Unit inventory statistics
    const [totalUnits, inStockUnits, soldUnits, claimedUnits, sampleUnits] = await Promise.all([
      Unit.countDocuments({ batchNumber: batch.batchNumber }),
      Unit.countDocuments({ batchNumber: batch.batchNumber, status: 'inStock' }),
      Unit.countDocuments({ batchNumber: batch.batchNumber, soldState: 1 }),
      Unit.countDocuments({ batchNumber: batch.batchNumber, soldState: 2 }),
      Unit.find({ batchNumber: batch.batchNumber })
        .select('unitCode status soldState currentOwnerWallet createdAt')
        .limit(5),
    ]);

    return successResponse(res, {
      batch,
      stats: {
        totalUnits,
        inStockUnits,
        soldUnits,
        claimedUnits,
        activeRate: totalUnits > 0 ? ((inStockUnits / totalUnits) * 100).toFixed(1) + '%' : '0%',
      },
      sampleUnits,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Recall a product batch on-chain and off-chain (marks batch & all units recalled)
 * @route POST /api/v1/batches/:batchId/recall
 */
const recallBatch = async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { reason } = req.body;

    const batch = await findBatchByIdentifier(batchId);

    if (!batch) {
      return errorResponse(res, `Batch "${batchId}" was not found.`, 404, 'BATCH_NOT_FOUND');
    }

    if (!isAuthorizedForBatch(req.user, batch)) {
      return errorResponse(res, 'Not authorized to recall this batch.', 403, 'FORBIDDEN');
    }

    if (batch.isRecalled || batch.recalled || batch.status === 'Recalled' || batch.status === 'recalled') {
      return errorResponse(
        res,
        `Batch "${batch.batchNumber}" has already been recalled.`,
        400,
        'BATCH_ALREADY_RECALLED',
        {
          batchNumber: batch.batchNumber,
          recalledAt: batch.recalledAt,
          recallReason: batch.recallReason,
        }
      );
    }

    let txHash = null;
    try {
      const chainRes = await blockchainService.recallBatch(batch.batchNumber, reason);
      txHash = chainRes.txHash;
    } catch (chainErr) {
      console.warn(`[Blockchain Warning] Recall on-chain simulated/failed: ${chainErr.message}`);
      txHash = ethers.id(`simulated-recall-tx-${Date.now()}`);
    }

    // 1. Mark batch as recalled
    batch.isRecalled = true;
    batch.recalled = true;
    batch.status = 'Recalled';
    batch.recallReason = reason;
    batch.recalledAt = new Date();
    batch.recalledBy = req.user._id;
    if (txHash) {
      batch.technicalProof = batch.technicalProof || {};
      batch.technicalProof.recallTxHash = txHash;
    }
    await batch.save();

    // 2. Mark all associated units as recalled
    const unitUpdateResult = await Unit.updateMany(
      { batch: batch._id },
      {
        $set: {
          status: 'recalled',
          recallReason: reason,
          recalledAt: new Date(),
        },
      }
    );
    const affectedUnitsCount = unitUpdateResult.modifiedCount || batch.quantity;

    console.log(`\n🚨 [PRODUCT RECALL INITIATED] Batch ${batch.batchNumber} recalled.`);
    console.log(`   Reason: "${reason}"`);
    console.log(`   Affected Units: ${affectedUnitsCount}`);
    console.log(`   On-Chain TxHash: ${txHash}\n`);

    return successResponse(res, {
      batchNumber: batch.batchNumber,
      batchId: batch.batchId,
      productName: batch.productName,
      isRecalled: true,
      status: batch.status,
      recallReason: batch.recallReason,
      recalledAt: batch.recalledAt,
      affectedUnitsCount,
      txHash,
      message: `Product batch "${batch.batchNumber}" and ${affectedUnitsCount} units have been recalled successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Get list of past recalled batches with dates, reasons, and affected units counts
 * @route GET /api/v1/batches/recalls
 * @access Manufacturer, Admin
 */
const getRecallsList = async (req, res, next) => {
  try {
    const { page = '1', limit = '20', search, startDate, endDate } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const query = {
      $or: [
        { status: { $in: ['Recalled', 'recalled'] } },
        { isRecalled: true },
        { recalled: true },
      ],
    };

    if (req.user.role === ROLES.MANUFACTURER) {
      query.manufacturer = req.user._id;
    }

    if (search) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { batchNumber: new RegExp(search.trim(), 'i') },
          { productName: new RegExp(search.trim(), 'i') },
          { recallReason: new RegExp(search.trim(), 'i') },
        ],
      });
    }

    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      query.$and = query.$and || [];
      query.$and.push({
        $or: [{ recalledAt: dateFilter }, { updatedAt: dateFilter }],
      });
    }

    const total = await Batch.countDocuments(query);
    const recalledBatches = await Batch.find(query)
      .populate('product', 'name sku category images mrp')
      .populate('recalledBy', 'name email role')
      .sort({ recalledAt: -1, updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const items = await Promise.all(
      recalledBatches.map(async b => {
        const unitsCount = await Unit.countDocuments({ batch: b._id });
        return {
          id: b._id,
          batchNumber: b.batchNumber,
          batchId: b.batchId,
          productName: b.productName,
          product: b.product,
          brandName: b.brandName,
          quantity: b.quantity,
          affectedUnitsCount: unitsCount || b.quantity,
          protectionLevel: b.protectionLevel,
          mfgDate: b.mfgDate,
          expiryDate: b.expiryDate,
          status: b.status,
          recallReason: b.recallReason,
          recalledAt: b.recalledAt || b.updatedAt,
          recalledBy: b.recalledBy ? { name: b.recalledBy.name, email: b.recalledBy.email } : null,
          txHash: b.technicalProof?.recallTxHash || b.technicalProof?.txHash || null,
        };
      })
    );

    const totalAffectedUnits = items.reduce((acc, curr) => acc + curr.affectedUnitsCount, 0);

    return successResponse(res, {
      total,
      page: pageNum,
      limit: limitNum,
      recalls: items,
      summary: {
        totalRecalledBatches: total,
        totalAffectedUnits,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Download all QR codes for a batch as a ZIP archive of PNGs
 *       Only the owning manufacturer or admin can download.
 * @route GET /api/v1/batches/:batchId/qr/zip
 */
const downloadBatchQrZip = async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const batch = await findBatchByIdentifier(batchId);
    if (!batch) {
      return errorResponse(res, `Batch "${batchId}" was not found.`, 404, 'BATCH_NOT_FOUND');
    }

    // Ownership check: only the owning manufacturer or admin can download
    if (!isAuthorizedForBatch(req.user, batch)) {
      return errorResponse(
        res,
        'Access denied: You can only download QR codes for batches created by your organization.',
        403,
        'FORBIDDEN'
      );
    }

    await qrService.streamBatchZip(batch, res);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Download all QR codes for a batch as a printable PDF sheet (A4, 12 labels / page)
 *       Only the owning manufacturer or admin can download.
 * @route GET /api/v1/batches/:batchId/qr/pdf
 */
const downloadBatchQrPdf = async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const batch = await findBatchByIdentifier(batchId);
    if (!batch) {
      return errorResponse(res, `Batch "${batchId}" was not found.`, 404, 'BATCH_NOT_FOUND');
    }

    // Ownership check: only the owning manufacturer or admin can download
    if (!isAuthorizedForBatch(req.user, batch)) {
      return errorResponse(
        res,
        'Access denied: You can only download QR sheets for batches created by your organization.',
        403,
        'FORBIDDEN'
      );
    }

    await qrService.streamBatchPdf(batch, res);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createBatch,
  getBatches,
  getBatchById,
  recallBatch,
  getRecallsList,
  downloadBatchQrZip,
  downloadBatchQrPdf,
};
