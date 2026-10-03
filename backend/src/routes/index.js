const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const batchRoutes = require('./batch.routes');
const verifyRoutes = require('./verify.routes');
const transferRoutes = require('./transfer.routes');
const unitRoutes = require('./unit.routes');
const creditRoutes = require('./credit.routes');
const brandRoutes = require('./brand.routes');
const adminRoutes = require('./admin.routes');
const productRoutes = require('./product.routes');
const partnerRoutes = require('./partner.routes');
const consumerRoutes = require('./consumer.routes');
const rewardRoutes = require('./reward.routes');
const reportRoutes = require('./report.routes');
const analyticsRoutes = require('./analytics.routes');
const billingRoutes = require('./billing.routes');
const settingsRoutes = require('./settings.routes');
const zkpRoutes = require('./zkp.routes');

const { sellUnit, claimUnit, getRetailSales } = require('../controllers/unit.controller');
const { getHotspots } = require('../controllers/report.controller');
const { getManufacturerAnalytics } = require('../controllers/analytics.controller');
const { getRecallsList } = require('../controllers/batch.controller');
const authenticate = require('../middleware/auth');
const { requireRoles } = require('../middleware/rbac');
const validate = require('../middleware/validate');
const { sellUnitSchema, claimUnitSchema } = require('../validators/unit.validator');
const { ROLES } = require('../constants/roles');

const router = express.Router();

// Mount Health Check endpoint at /api/v1/health
router.use('/health', healthRoutes);

// Mount Subsystem Endpoints
router.use('/auth', authRoutes);
router.use('/batches', batchRoutes);
router.use('/verify', verifyRoutes);
router.use('/transfers', transferRoutes);
router.use('/units', unitRoutes);
router.use('/credits', creditRoutes);
router.use('/brands', brandRoutes);
router.use('/admin', adminRoutes);
router.use('/products', productRoutes);
router.use('/partners', partnerRoutes);
router.use('/consumer', consumerRoutes);
router.use('/rewards', rewardRoutes);
router.use('/reports', reportRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/billing', billingRoutes);
router.use('/settings', settingsRoutes);
router.use('/zkp', zkpRoutes);

// Manufacturer & Admin Hotspots shortcut: GET /api/v1/hotspots
router.get(
  '/hotspots',
  authenticate,
  requireRoles(ROLES.MANUFACTURER, ROLES.ADMIN),
  getHotspots
);

// Manufacturer Analytics shortcut: GET /api/v1/manufacturers/analytics
router.get(
  '/manufacturers/analytics',
  authenticate,
  requireRoles(ROLES.MANUFACTURER, ROLES.ADMIN),
  getManufacturerAnalytics
);

// Past Recalls shortcut: GET /api/v1/recalls
router.get(
  '/recalls',
  authenticate,
  requireRoles(ROLES.MANUFACTURER, ROLES.ADMIN),
  getRecallsList
);

// Direct top-level shortcuts: POST /api/v1/sell, GET /api/v1/sales, and POST /api/v1/claim
router.post(
  '/sell',
  authenticate,
  requireRoles(ROLES.RETAILER, ROLES.ADMIN),
  validate(sellUnitSchema),
  sellUnit
);

router.get(
  '/sales',
  authenticate,
  requireRoles(ROLES.RETAILER, ROLES.ADMIN),
  getRetailSales
);

router.post(
  '/claim',
  authenticate,
  requireRoles(ROLES.CONSUMER, ROLES.ADMIN),
  validate(claimUnitSchema),
  claimUnit
);

module.exports = router;
