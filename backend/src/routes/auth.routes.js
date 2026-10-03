const express = require('express');
const {
  requestOtp,
  verifyOtp,
  consumerLogin,
  consumerSignup,
  businessSignup,
  businessLogin,
  forgotPassword,
  resetPassword,
  getMe,
  logout,
} = require('../controllers/auth.controller');
const authenticate = require('../middleware/auth');
const { uploadKybDocs } = require('../middleware/upload');
const validate = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const {
  consumerRequestOtpSchema,
  consumerVerifyOtpSchema,
  consumerSignupSchema,
  consumerLoginSchema,
  businessSignupSchema,
  businessLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require('../validators/auth.validator');

const router = express.Router();

// =============================================================================
// CONSUMER AUTH: Phone + Mock OTP (123456)
// =============================================================================

// Request OTP (Rate limited: max 20 requests per 15 mins)
router.post('/consumer/request-otp', authLimiter, validate(consumerRequestOtpSchema), requestOtp);
router.post('/send-otp', authLimiter, validate(consumerRequestOtpSchema), requestOtp); // Alias

// Consumer verify OTP
router.post('/consumer/verify-otp', authLimiter, validate(consumerVerifyOtpSchema), verifyOtp);
router.post('/verify-otp', authLimiter, validate(consumerVerifyOtpSchema), verifyOtp); // Alias

// Consumer explicit signup and login
router.post('/consumer/signup', authLimiter, validate(consumerSignupSchema), consumerSignup);
router.post('/consumer/login', authLimiter, validate(consumerLoginSchema), consumerLogin);

// =============================================================================
// BUSINESS AUTH: Manufacturer, Partner (Distributor, Retailer), Admin (Email + Password)
// =============================================================================

// Business signup per role
router.post('/signup', uploadKybDocs.array('documents', 5), validate(businessSignupSchema), businessSignup);
router.post('/register', uploadKybDocs.array('documents', 5), validate(businessSignupSchema), businessSignup); // Alias

// Business login per role
router.post('/login', validate(businessLoginSchema), businessLogin);

// =============================================================================
// PASSWORD RESET (Stub)
// =============================================================================

router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

// =============================================================================
// COMMON AUTH ENDPOINTS: /auth/me & /auth/logout
// =============================================================================

router.get('/me', authenticate, getMe);
router.post('/logout', logout);

module.exports = router;
