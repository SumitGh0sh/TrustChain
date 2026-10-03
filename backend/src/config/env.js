const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Accepts MONGO_URI or MONGODB_URI
  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trustchain',
  jwtSecret: process.env.JWT_SECRET || 'trustchain_default_secret_key_2026',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
  // Hardhat Account #1 is the default pre-configured relayer
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  deploymentsPath: path.resolve(__dirname, '..', '..', process.env.DEPLOYMENTS_FILE_PATH || '../contracts-project/deployments/localhost.json'),
  abiDirPath: path.resolve(__dirname, '..', '..', process.env.ABI_DIR_PATH || '../contracts-project/abi'),
  mockOtpCode: process.env.MOCK_OTP_CODE || '123456',
  inrCostPerUnit: parseFloat(process.env.INR_COST_PER_UNIT || '1'),
  inrCostStandard: parseFloat(process.env.INR_COST_PER_UNIT_STANDARD || process.env.INR_COST_PER_UNIT || '1'),
  inrCostHighValue: parseFloat(process.env.INR_COST_PER_UNIT_HIGH_VALUE || '2'),
  pointsPerClaim: parseInt(process.env.POINTS_PER_CLAIM || '50', 10),
  cloneScanThreshold: parseInt(process.env.CLONE_SCAN_THRESHOLD || '50', 10),
  cloneWindowMinutes: parseInt(process.env.CLONE_WINDOW_MINUTES || '5', 10),
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
};

module.exports = config;
