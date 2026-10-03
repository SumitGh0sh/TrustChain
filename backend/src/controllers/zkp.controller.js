const zkpService = require('../services/zkp.service');
const Unit = require('../models/Unit');
const Batch = require('../models/Batch');
const Scan = require('../models/Scan');
const { successResponse, errorResponse } = require('../utils/response');

const claimedNullifiers = new Set();

/**
 * Generates Zero-Knowledge Proof for unit code ownership/authenticity
 * @route POST /api/v1/zkp/generate-proof
 */
const generateProof = async (req, res) => {
  try {
    const { unitCode, secret = 'DEFAULT_SECRET_KEY', batchId } = req.body;

    if (!unitCode) {
      return errorResponse(res, 'unitCode is required', 400);
    }

    let merkleRoot = null;
    let unitObj = await Unit.findOne({ unitCode }).populate('batch');

    if (unitObj && unitObj.batch && unitObj.batch.merkleRoot) {
      merkleRoot = unitObj.batch.merkleRoot;
    }

    const proofResult = zkpService.generateZkProof({
      unitCode,
      secret,
      merkleRoot
    });

    return successResponse(res, {
      message: 'Zero-Knowledge Proof successfully generated',
      unitCodeMasked: unitCode.substring(0, 4) + '****' + unitCode.substring(unitCode.length - 2),
      proof: proofResult.proof,
      publicSignals: proofResult.publicSignals,
      proofBytes: proofResult.proofBytes,
      zkpStandard: 'Groth16 / BN128'
    });
  } catch (error) {
    console.error('Error generating ZK proof:', error);
    return errorResponse(res, error.message || 'Failed to generate ZK proof', 500);
  }
};

/**
 * Verifies Zero-Knowledge Proof without disclosing raw secrets or consumer PII
 * @route POST /api/v1/zkp/verify-proof
 */
const verifyProof = async (req, res) => {
  try {
    const { proof, publicSignals, unitCode } = req.body;

    if (!proof || !publicSignals) {
      return errorResponse(res, 'Both proof and publicSignals are required', 400);
    }

    const verification = zkpService.verifyZkProof({ proof, publicSignals });

    if (!verification.valid) {
      return errorResponse(res, verification.error || 'Invalid Zero-Knowledge Proof', 400);
    }

    const isAlreadyClaimed = claimedNullifiers.has(publicSignals.nullifierHash);

    // Record anonymous ZK verification scan log
    try {
      if (unitCode) {
        const unitObj = await Unit.findOne({ unitCode });
        if (unitObj) {
          await Scan.create({
            unit: unitObj._id,
            batch: unitObj.batch,
            location: { city: req.body.city || 'Anonymous ZK Client' },
            verificationType: 'ZKP_ZERO_KNOWLEDGE',
            isValid: true,
            notes: 'ZKP verified with Nullifier Hash: ' + publicSignals.nullifierHash.substring(0, 16) + '...'
          });
        }
      }
    } catch (dbErr) {
      console.warn('DB scan log skipped:', dbErr.message);
    }

    return successResponse(res, {
      verified: true,
      protocol: verification.protocol,
      curve: verification.curve,
      merkleRoot: publicSignals.merkleRoot,
      nullifierHash: publicSignals.nullifierHash,
      commitment: publicSignals.commitment,
      isNullifierUsed: isAlreadyClaimed,
      verifiedAt: verification.verifiedAt,
      statement: verification.privacyGuarantee,
      securityBadge: 'Cryptographically Verified via Chainstack ZK Protocol'
    });
  } catch (error) {
    console.error('Error verifying ZK proof:', error);
    return errorResponse(res, error.message || 'Failed to verify ZK proof', 500);
  }
};

/**
 * Claims product warranty / rewards via Zero-Knowledge Proof anonymously
 * @route POST /api/v1/zkp/claim-warranty-zk
 */
const claimWarrantyZk = async (req, res) => {
  try {
    const { proof, publicSignals, claimDetails } = req.body;

    if (!proof || !publicSignals) {
      return errorResponse(res, 'Proof and publicSignals are required', 400);
    }

    const verification = zkpService.verifyZkProof({ proof, publicSignals });

    if (!verification.valid) {
      return errorResponse(res, 'Invalid Zero-Knowledge Proof vector', 400);
    }

    const nullifier = publicSignals.nullifierHash;

    if (claimedNullifiers.has(nullifier)) {
      return errorResponse(res, 'This product warranty/reward has already been claimed via this ZK Nullifier!', 409);
    }

    claimedNullifiers.add(nullifier);

    return successResponse(res, {
      claimed: true,
      nullifierHash: nullifier,
      claimId: 'ZK-CLAIM-' + Date.now(),
      claimedAt: new Date().toISOString(),
      privacyMode: 'ANONYMOUS_ZERO_KNOWLEDGE',
      message: 'Warranty activated successfully without revealing consumer identity or private unit serial number.'
    });
  } catch (error) {
    console.error('Error claiming ZK warranty:', error);
    return errorResponse(res, error.message || 'Failed to execute ZK warranty claim', 500);
  }
};

module.exports = {
  generateProof,
  verifyProof,
  claimWarrantyZk
};
