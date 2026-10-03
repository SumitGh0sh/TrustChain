const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const User = require('../models/User');
const Brand = require('../models/Brand');
const Otp = require('../models/Otp');
const config = require('../config/env');
const smsService = require('../services/sms.service');
const walletService = require('../services/wallet.service');
const { successResponse, errorResponse } = require('../utils/response');
const { ROLES } = require('../constants/roles');

/**
 * Generate standard JWT token for user
 */
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      phone: user.phone,
      email: user.email,
      walletAddress: user.walletAddress,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
};

/**
 * Clean user profile object (without sensitive fields)
 */
const formatUserResponse = (user) => ({
  id: user._id,
  name: user.name,
  role: user.role,
  phone: user.phone || null,
  email: user.email || null,
  companyName: user.companyName || null,
  creditBalance: user.creditBalance,
  pointsBalance: user.pointsBalance,
  brandStatus: user.brandStatus || 'none',
  walletAddress: user.walletAddress || null,
  isVerified: user.isVerified,
  createdAt: user.createdAt,
});

// =============================================================================
// CONSUMER AUTH: Phone + Mock OTP (123456)
// =============================================================================

/**
 * Request OTP for consumer (Mocked: 123456)
 */
const requestOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const otpCode = config.mockOtpCode;

    try {
      await Otp.findOneAndUpdate(
        { phone },
        {
          otp: otpCode,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 mins
          verified: false,
        },
        { upsert: true, new: true }
      );
    } catch (dbErr) {
      console.warn(`[OTP Storage Warning] Could not persist to DB (offline/unreachable): ${dbErr.message}`);
    }

    await smsService.sendOtp(phone, otpCode);

    return successResponse(res, {
      phone,
      message: 'OTP sent successfully. (Mock OTP: 123456)',
      mockOtp: config.nodeEnv === 'development' ? otpCode : undefined,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Consumer login with Phone + OTP
 */
const consumerLogin = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;

    const isValid = smsService.verifyOtp(otp);
    if (!isValid) {
      return errorResponse(res, 'Invalid OTP code. Please use test OTP: 123456.', 400, 'INVALID_OTP');
    }

    const user = await User.findOne({ phone, role: ROLES.CONSUMER });
    if (!user) {
      return errorResponse(res, 'No consumer account found with this phone number. Please sign up first.', 404, 'USER_NOT_FOUND');
    }

    const token = generateToken(user);
    return successResponse(res, {
      token,
      user: formatUserResponse(user),
      message: 'Consumer login successful.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Consumer signup with Phone + OTP
 */
const consumerSignup = async (req, res, next) => {
  try {
    const { name, phone, otp } = req.body;

    const isValid = smsService.verifyOtp(otp);
    if (!isValid) {
      return errorResponse(res, 'Invalid OTP code. Please use test OTP: 123456.', 400, 'INVALID_OTP');
    }

    const existing = await User.findOne({ phone });
    if (existing) {
      return errorResponse(res, 'An account with this phone number already exists.', 409, 'PHONE_EXISTS');
    }

    const custodialWallet = walletService.createCustodialWallet();

    const consumer = await User.create({
      name,
      phone,
      role: ROLES.CONSUMER,
      walletAddress: custodialWallet.address,
      encryptedPrivateKey: custodialWallet.encryptedPrivateKey,
      pointsBalance: 0,
      isVerified: true,
    });

    const token = generateToken(consumer);
    return successResponse(
      res,
      {
        token,
        user: formatUserResponse(consumer),
        message: 'Consumer registered successfully.',
      },
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Universal verify OTP (auto-detects if user exists)
 */
const verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp, name } = req.body;

    const isValid = smsService.verifyOtp(otp);
    if (!isValid) {
      return errorResponse(res, 'Invalid OTP code. Please use test OTP: 123456.', 400, 'INVALID_OTP');
    }

    let user = await User.findOne({ phone });

    // If user does not exist yet and name is provided, auto-create consumer
    if (!user && name) {
      const custodialWallet = walletService.createCustodialWallet();
      user = await User.create({
        name,
        phone,
        role: ROLES.CONSUMER,
        walletAddress: custodialWallet.address,
        encryptedPrivateKey: custodialWallet.encryptedPrivateKey,
        isVerified: true,
      });
    }

    if (!user) {
      return successResponse(res, {
        isNewUser: true,
        phone,
        message: 'OTP verified. Please complete signup with your name.',
      });
    }

    const token = generateToken(user);
    return successResponse(res, {
      isNewUser: false,
      token,
      user: formatUserResponse(user),
    });
  } catch (err) {
    next(err);
  }
};

// =============================================================================
// BUSINESS AUTH: Manufacturer, Partner (Distributor, Retailer), Admin (Email + Password)
// =============================================================================

/**
 * Signup for business roles (Manufacturer, Distributor, Retailer, Admin)
 */
const businessSignup = async (req, res, next) => {
  try {
    const { name, email, password, role, companyName, gst, cin, phone, licenseNumber } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return errorResponse(res, 'An account with this email address already exists.', 409, 'EMAIL_EXISTS');
    }

    if (phone) {
      const phoneExists = await User.findOne({ phone });
      if (phoneExists) {
        return errorResponse(res, 'An account with this phone number already exists.', 409, 'PHONE_EXISTS');
      }
    }

    const custodialWallet = walletService.createCustodialWallet();
    const initialCredits = role === ROLES.MANUFACTURER ? 500 : 0;
    const isManufacturer = role === ROLES.MANUFACTURER;

    const user = await User.create({
      name,
      email,
      password, // Automatically hashed by User schema pre-save hook using bcrypt
      role,
      companyName: companyName || '',
      gst: gst || '',
      cin: cin || '',
      phone: phone || undefined,
      licenseNumber: licenseNumber || '',
      walletAddress: custodialWallet.address,
      encryptedPrivateKey: custodialWallet.encryptedPrivateKey,
      creditBalance: initialCredits,
      brandStatus: isManufacturer ? 'pending' : 'none',
      isVerified: !isManufacturer, // Non-manufacturers auto-verified, manufacturers pending admin KYB
    });

    // Automatically create a Brand document in pending state for manufacturers
    let createdBrand = null;
    if (isManufacturer) {
      createdBrand = await Brand.create({
        manufacturer: user._id,
        companyName: companyName || name,
        gst: gst || '',
        cin: cin || '',
        status: 'pending',
      });
      console.log(`[Brand Onboarding] Created Brand in pending state for manufacturer: ${user.name} (${user.email})`);
    }

    const token = generateToken(user);
    return successResponse(
      res,
      {
        token,
        user: {
          ...formatUserResponse(user),
          brandStatus: user.brandStatus,
          brandId: createdBrand?._id || undefined,
        },
        message: isManufacturer
          ? 'Manufacturer registered. Brand onboarding is in PENDING review.'
          : `${role.toUpperCase()} account created successfully.`,
      },
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Login for business roles (Email + Password)
 */
const businessLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Explicitly select password field since it is select: false by default
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return errorResponse(res, 'Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, 'Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    if (user.status === 'SUSPENDED') {
      return errorResponse(res, 'Account has been suspended. Please contact administrator.', 403, 'ACCOUNT_SUSPENDED');
    }

    const token = generateToken(user);
    return successResponse(res, {
      token,
      user: formatUserResponse(user),
      message: 'Login successful.',
    });
  } catch (err) {
    next(err);
  }
};

// =============================================================================
// FORGOT PASSWORD STUB
// =============================================================================

/**
 * Forgot password stub
 * Generates a mock reset token and logs instructions to console
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });

    // Consistent response to prevent user enumeration
    const genericSuccess = {
      message: 'If that email address is registered, password reset instructions have been sent.',
    };

    if (!user) {
      return successResponse(res, genericSuccess);
    }

    // Generate mock reset token
    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await user.save();

    console.log('\n================== [MOCK PASSWORD RESET STUB] ==================');
    console.log(`📧 User Email: ${email}`);
    console.log(`🔑 Reset Token: ${resetToken}`);
    console.log(`🔗 Reset URL: http://localhost:5173/reset-password?token=${resetToken}`);
    console.log('================================================================\n');

    return successResponse(res, {
      ...genericSuccess,
      mockResetToken: config.nodeEnv === 'development' ? resetToken : undefined,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Reset password stub endpoint
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return errorResponse(res, 'Password reset token is invalid or has expired.', 400, 'INVALID_RESET_TOKEN');
    }

    user.password = newPassword; // Will be hashed by pre-save hook
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return successResponse(res, {
      message: 'Password reset successful. You may now log in with your new password.',
    });
  } catch (err) {
    next(err);
  }
};

// =============================================================================
// COMMON AUTH ENDPOINTS: /auth/me & /auth/logout
// =============================================================================

/**
 * Get current user profile
 */
const getMe = async (req, res, next) => {
  try {
    return successResponse(res, {
      user: formatUserResponse(req.user),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Logout
 */
const logout = async (req, res) => {
  return successResponse(res, {
    message: 'Logged out successfully. Please clear the authorization token from client storage.',
  });
};

module.exports = {
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
  // Aliases for backwards compatibility
  sendOtp: requestOtp,
  register: businessSignup,
};
