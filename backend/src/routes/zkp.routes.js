const express = require('express');
const router = express.Router();
const zkpController = require('../controllers/zkp.controller');

router.post('/generate-proof', zkpController.generateProof);
router.post('/verify-proof', zkpController.verifyProof);
router.post('/claim-warranty-zk', zkpController.claimWarrantyZk);

module.exports = router;
