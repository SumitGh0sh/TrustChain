import { toast } from './toast';

const BASE_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000/api/v1';


export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: {
    message: string;
    code: string;
    details?: any;
  };
}

export interface UserSession {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  role: 'consumer' | 'manufacturer' | 'distributor' | 'retailer' | 'admin';
  status?: string;
  brandStatus?: 'pending' | 'approved' | 'rejected' | 'info_requested' | 'suspended';
  brandId?: string;
  partnerId?: string;
  companyProfile?: any;
  walletAddress?: string;
  creditBalance?: number;
  pointsBalance?: number;
  plan?: string;
  token?: string;
}

export interface RequestOptions extends RequestInit {
  silent?: boolean;
}

class ApiService {
  private token: string | null = null;

  constructor() {
    this.token = sessionStorage.getItem('trustchain_token') || localStorage.getItem('trustchain_token');
  }

  public setToken(token: string | null) {
    this.token = token;
    if (token) {
      sessionStorage.setItem('trustchain_token', token);
      localStorage.setItem('trustchain_token', token);
    } else {
      sessionStorage.removeItem('trustchain_token');
      localStorage.removeItem('trustchain_token');
    }
  }

  public getToken(): string | null {
    return this.token || sessionStorage.getItem('trustchain_token') || localStorage.getItem('trustchain_token');
  }

  public clearSession() {
    this.setToken(null);
    sessionStorage.removeItem('trustchain_session');
    localStorage.removeItem('trustchain_session');
  }

  public getSession(): UserSession | null {
    try {
      const raw = sessionStorage.getItem('trustchain_session') || localStorage.getItem('trustchain_session');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  public setSession(session: UserSession | null) {
    if (session) {
      sessionStorage.setItem('trustchain_session', JSON.stringify(session));
      localStorage.setItem('trustchain_session', JSON.stringify(session));
      if (session.token) {
        this.setToken(session.token);
      }
    } else {
      this.clearSession();
    }
  }

  private async request<T = any>(
    endpoint: string,
    options: RequestOptions = {},
    customHeaders: Record<string, string> = {}
  ): Promise<ApiResponse<T>> {
    const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
    const token = this.getToken();

    const headers: Record<string, string> = {
      ...customHeaders,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...(options.headers as Record<string, string>),
        },
      });

      // Automatic Auto-Logout on 401 Unauthorized
      if (response.status === 401) {
        const wasLoggedIn = Boolean(this.getToken() || this.getSession());
        this.clearSession();
        if (wasLoggedIn && !options.silent) {
          toast.error('Session expired or unauthorized. Please log in again.');
        }
        window.dispatchEvent(new CustomEvent('trustchain:auth-expired'));
      }

      const json = await response.json();

      // Automatic Toast Error Handling
      if (!json.success && !options.silent) {
        const errMsg = json.error?.message || 'Request failed. Please check inputs.';
        toast.error(errMsg);
      }

      return json;
    } catch (err: any) {
      console.error(`[API Error] ${endpoint}:`, err);
      const networkErrMsg = err.message || 'Network request failed. Is the backend running?';
      if (!options.silent) {
        toast.error(networkErrMsg);
      }
      return {
        success: false,
        data: null as any,
        error: {
          message: networkErrMsg,
          code: 'NETWORK_ERROR',
        },
      };
    }
  }

  // ==========================================
  // 1. AUTHENTICATION & SESSION
  // ==========================================
  public auth = {
    login: async (email: string, password: string) => {
      const res = await this.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },

    register: async (data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      role?: string;
      companyName?: string;
      gst?: string;
      cin?: string;
    }) => {
      const res = await this.request('/auth/register', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },

    consumerRequestOtp: async (phone: string) => {
      return this.request('/auth/consumer/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
    },

    consumerSignup: async (name: string, phone: string, otp: string = '123456', referralCode?: string) => {
      const res = await this.request('/auth/consumer/signup', {
        method: 'POST',
        body: JSON.stringify({ name, phone, otp, referralCode }),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },

    consumerLogin: async (phone: string, otp: string = '123456') => {
      const res = await this.request('/auth/consumer/login', {
        method: 'POST',
        body: JSON.stringify({ phone, otp }),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },

    logout: () => {
      this.clearSession();
      toast.info('Logged out successfully.');
    },

    getMe: async () => {
      const res = await this.request('/auth/me');
      if (res.success && res.data?.user) {
        const currentSession = this.getSession();
        this.setSession({ ...currentSession, ...res.data.user });
      }
      return res;
    },

    getSession: () => this.getSession(),
    setSession: (session: UserSession | null) => this.setSession(session),
    clearSession: () => this.clearSession(),
  };

  // ==========================================
  // 2. PRODUCT VERIFICATION
  // ==========================================
  public verify = {
    verifyProduct: async (code: string, simulateCity?: string) => {
      const customHeaders: Record<string, string> = {};
      if (simulateCity) {
        customHeaders['x-simulate-city'] = simulateCity;
      }
      return this.request(
        `/verify/${encodeURIComponent(code)}`,
        { method: 'GET' },
        customHeaders
      );
    },
  };

  // ==========================================
  // 3. BATCHES & QR CODE EXPORTS
  // ==========================================
  public batches = {
    getBatches: async (params?: { page?: number; limit?: number; status?: string }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/batches${qs ? `?${qs}` : ''}`);
    },

    getBatchById: async (id: string) => {
      return this.request(`/batches/${id}`);
    },

    createBatch: async (data: {
      product: string;
      batchNumber: string;
      quantity: number;
      mfgDate: string;
      expiryDate: string;
      protectionLevel?: 'Standard' | 'HighValue';
      description?: string;
    }) => {
      return this.request('/batches', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    getBatchQrZipUrl: (batchId: string) => {
      const token = this.getToken();
      return `${BASE_URL}/batches/${batchId}/qr-zip${token ? `?token=${token}` : ''}`;
    },

    getBatchQrPdfUrl: (batchId: string) => {
      const token = this.getToken();
      return `${BASE_URL}/batches/${batchId}/qr-pdf${token ? `?token=${token}` : ''}`;
    },

    recallBatch: async (batchId: string, reason: string) => {
      return this.request(`/batches/${batchId}/recall`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    getRecalls: async (params?: {
      page?: number;
      limit?: number;
      search?: string;
      startDate?: string;
      endDate?: string;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/batches/recalls${qs ? `?${qs}` : ''}`);
    },
  };

  // ==========================================
  // 3B. PRODUCTS CATALOG
  // ==========================================
  public products = {
    getProducts: async (params?: { page?: number; limit?: number; search?: string; category?: string }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/products${qs ? `?${qs}` : ''}`);
    },

    getProductById: async (id: string) => {
      return this.request(`/products/${id}`);
    },

    createProduct: async (data: FormData | { name: string; sku: string; category: string; description?: string; price?: number }) => {
      return this.request('/products', {
        method: 'POST',
        body: data instanceof FormData ? data : JSON.stringify(data),
      });
    },

    updateProduct: async (id: string, data: FormData | { name?: string; sku?: string; category?: string; description?: string; price?: number }) => {
      return this.request(`/products/${id}`, {
        method: 'PUT',
        body: data instanceof FormData ? data : JSON.stringify(data),
      });
    },

    deleteProduct: async (id: string) => {
      return this.request(`/products/${id}`, {
        method: 'DELETE',
      });
    },
  };

  // ==========================================
  // 4. PARTNER ONBOARDING & TRANSFERS
  // ==========================================
  public transfers = {
    getTransfers: async (params?: { status?: string; role?: string; page?: number; limit?: number }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/transfers${qs ? `?${qs}` : ''}`);
    },

    getTransferById: async (id: string) => {
      return this.request(`/transfers/${id}`);
    },

    createTransfer: async (data: {
      batchId: string;
      toPartnerId?: string;
      toUserId?: string;
      toWallet?: string;
      quantity: number;
      notes?: string;
    }) => {
      return this.request('/transfers', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    respondTransfer: async (transferId: string, accept: boolean, reason?: string, notes?: string) => {
      return this.request(`/transfers/${transferId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ accept, reason, notes }),
      });
    },

    getIncoming: async (status?: string) => {
      return this.request(`/transfers/incoming${status ? `?status=${status}` : ''}`);
    },

    getInventory: async () => {
      return this.request('/transfers/inventory');
    },
  };

  public partners = {
    getPartners: async (role?: string) => {
      return this.request(`/partners${role ? `?role=${role}` : ''}`);
    },

    getPartnerById: async (id: string) => {
      return this.request(`/partners/${id}`);
    },

    createInvite: async (role: 'distributor' | 'retailer') => {
      return this.request('/partners/invite', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
    },

    getInventory: async () => {
      return this.request('/transfers/inventory');
    },

    getIncomingTransfers: async (status?: string) => {
      return this.request(`/transfers/incoming${status ? `?status=${status}` : ''}`);
    },

    createTransfer: async (data: {
      to: string;
      batchId: string;
      quantity: number;
      notes?: string;
    }) => {
      return this.request('/transfers', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    respondTransfer: async (transferId: string, action: 'accept' | 'reject', rejectionReason?: string) => {
      return this.request(`/transfers/${transferId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action, rejectionReason }),
      });
    },

    getReputationList: async (params?: { role?: string; city?: string }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/partners/reputation${qs ? `?${qs}` : ''}`);
    },

    getReputation: async (partnerId: string) => {
      return this.request(`/partners/${encodeURIComponent(partnerId)}/reputation`);
    },

    joinInvite: async (data: {
      token: string;
      name: string;
      password: string;
      phone: string;
      gst: string;
      businessDetails?: any;
      location: {
        address: string;
        city: string;
        state: string;
        pincode: string;
        country?: string;
      };
    }) => {
      const res = await this.request('/partners/join-invite', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },

    selfApply: async (data: {
      email: string;
      password: string;
      name: string;
      phone: string;
      role: 'distributor' | 'retailer';
      businessName: string;
      gst: string;
      businessDetails?: any;
      location: {
        address: string;
        city: string;
        state: string;
        pincode: string;
        country?: string;
      };
      upstreamId?: string;
    }) => {
      const res = await this.request('/partners/self-apply', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      if (res.success && res.data?.token) {
        this.setToken(res.data.token);
        if (res.data?.user) {
          this.setSession({ ...res.data.user, token: res.data.token });
        }
      }
      return res;
    },
  };

  // ==========================================
  // 4B. BRAND KYB & COMPLIANCE
  // ==========================================
  public brand = {
    getMyBrand: async () => {
      return this.request('/brands/me');
    },

    uploadDocuments: async (formData: FormData) => {
      return this.request('/brands/me/documents', {
        method: 'POST',
        body: formData,
      });
    },

    updateKybDetails: async (data: {
      companyName?: string;
      gst?: string;
      cin?: string;
    }) => {
      return this.request('/brands/me', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
  };

  // ==========================================
  // 5. RETAIL SALES & PRODUCT CLAIMS
  // ==========================================
  public sales = {
    sellUnit: async (code: string, customerPhone: string) => {
      return this.request('/sell', {
        method: 'POST',
        body: JSON.stringify({ code, customerPhone }),
      });
    },

    claimUnit: async (
      payload: { claimToken?: string; unitCode?: string; code?: string; otp?: string } | string,
      otpFallback: string = '123456'
    ) => {
      const body = typeof payload === 'string'
        ? { claimToken: payload, otp: otpFallback }
        : { otp: '123456', ...payload };
      return this.request('/claim', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getSales: async () => {
      const res = await this.request('/sales');
      if (res.success) return res;
      return this.request('/units/sales');
    },
  };

  // ==========================================
  // 6. CONSUMER PRODUCTS & RESALE
  // ==========================================
  public consumer = {
    getMyProducts: async () => {
      return this.request('/consumer/products');
    },

    getProductDetail: async (code: string) => {
      return this.request(`/consumer/products/${encodeURIComponent(code)}`);
    },

    initiateResale: async (unitCode: string, buyerPhone: string) => {
      return this.request('/consumer/resale/transfer', {
        method: 'POST',
        body: JSON.stringify({ unitCode, buyerPhone }),
      });
    },

    getResaleTransfers: async () => {
      return this.request('/consumer/resale/transfers');
    },

    respondResaleTransfer: async (transferId: string, action: 'accept' | 'reject', rejectionReason?: string) => {
      return this.request(`/consumer/resale/transfers/${transferId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action, rejectionReason }),
      });
    },

    getMyScans: async () => {
      return this.request('/consumer/scans');
    },

    exportWallet: async (otp: string = '123456') => {
      return this.request('/consumer/export-wallet', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
    },
  };

  // ==========================================
  // 7. LOYALTY REWARDS & REDEMPTION
  // ==========================================
  public rewards = {
    getBalance: async () => {
      return this.request('/rewards/balance');
    },

    getHistory: async (page = 1, limit = 20) => {
      return this.request(`/rewards/history?page=${page}&limit=${limit}`);
    },

    getStreak: async () => {
      return this.request('/rewards/streak');
    },

    getReferral: async () => {
      return this.request('/rewards/referral');
    },

    applyReferral: async (code: string) => {
      return this.request('/rewards/referral/apply', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
    },

    getStoreOffers: async () => {
      return this.request('/rewards/store');
    },

    redeemOffer: async (offerId: string) => {
      return this.request('/rewards/redeem', {
        method: 'POST',
        body: JSON.stringify({ offerId }),
      });
    },

    getRedemptions: async () => {
      return this.request('/rewards/redemptions');
    },

    getCampaign: async () => {
      return this.request('/rewards/campaign');
    },

    updateCampaign: async (data: {
      pointsPerScan?: number;
      streakBonus?: number;
      referralBonus?: number;
      fakeReportBonus?: number;
      dailyCap?: number;
    }) => {
      return this.request('/rewards/campaign', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
  };

  // ==========================================
  // 8. FAKE REPORTS & HOTSPOTS
  // ==========================================
  public reports = {
    submitReport: async (formData: FormData) => {
      return this.request('/reports', {
        method: 'POST',
        body: formData,
      });
    },

    getMyReports: async () => {
      return this.request('/reports/my-reports');
    },

    getReportById: async (id: string) => {
      return this.request(`/reports/${id}`);
    },

    getAdminReports: async (params?: {
      status?: string;
      city?: string;
      brand?: string;
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/admin/reports${qs ? `?${qs}` : ''}`);
    },

    reviewReport: async (id: string, status: 'Submitted' | 'UnderReview' | 'Valid' | 'Invalid', notes?: string) => {
      return this.request(`/admin/reports/${id}/review`, {
        method: 'PATCH',
        body: JSON.stringify({ status, notes }),
      });
    },

    getHotspots: async (params?: {
      city?: string;
      product?: string;
      batch?: string;
      startDate?: string;
      endDate?: string;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/reports/hotspots${qs ? `?${qs}` : ''}`);
    },
  };

  // ==========================================
  // 9. ANALYTICS & INTELLIGENCE
  // ==========================================
  public analytics = {
    getManufacturerAnalytics: async (params?: {
      startDate?: string;
      endDate?: string;
      productId?: string;
      batchNumber?: string;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/analytics/manufacturer${qs ? `?${qs}` : ''}`);
    },
  };

  // ==========================================
  // 10. BILLING & PREPAID CREDITS (MANUFACTURERS)
  // ==========================================
  public billing = {
    getOverview: async () => {
      return this.request('/billing/overview');
    },

    getPlan: async () => {
      return this.request('/billing/plan');
    },

    updatePlan: async (planCode: 'STARTER' | 'GROWTH' | 'ENTERPRISE', billingCycle: 'monthly' | 'annual' = 'monthly') => {
      return this.request('/billing/plan', {
        method: 'PATCH',
        body: JSON.stringify({ planCode, billingCycle }),
      });
    },

    getInvoices: async (params?: { page?: number; limit?: number; status?: string }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/billing/invoices${qs ? `?${qs}` : ''}`);
    },

    getInvoiceById: async (id: string) => {
      return this.request(`/billing/invoices/${encodeURIComponent(id)}`);
    },

    topupCredits: async (data: {
      amountINR: number;
      paymentMethod?: 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET';
      upiId?: string;
      cardNumber?: string;
      cardLast4?: string;
      cardNetwork?: string;
      bankName?: string;
      referenceId?: string;
    }) => {
      return this.request('/billing/topup', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    getUsageHistory: async (params?: { page?: number; limit?: number; type?: 'TOPUP' | 'DEDUCTION' }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/billing/usage${qs ? `?${qs}` : ''}`);
    },
  };

  // ==========================================
  // 11. SETTINGS & ORGANIZATION PROFILE
  // ==========================================
  public settings = {
    getCompanyProfile: async () => {
      return this.request('/settings/company');
    },

    updateCompanyProfile: async (data: {
      companyName?: string;
      legalName?: string;
      gst?: string;
      cin?: string;
      pan?: string;
      website?: string;
      supportEmail?: string;
      supportPhone?: string;
      address?: {
        street?: string;
        city?: string;
        state?: string;
        pincode?: string;
        country?: string;
      };
      brandLogoUrl?: string;
      description?: string;
    }) => {
      return this.request('/settings/company', {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    getTeamMembers: async () => {
      return this.request('/settings/team');
    },

    inviteTeamMember: async (data: {
      name: string;
      email: string;
      phone?: string;
      role?: 'Admin' | 'Manager' | 'Operator' | 'Viewer' | 'Compliance';
    }) => {
      return this.request('/settings/team', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    updateTeamMember: async (
      memberId: string,
      data: {
        role?: 'Admin' | 'Manager' | 'Operator' | 'Viewer' | 'Compliance';
        status?: 'Active' | 'Invited' | 'Suspended';
      }
    ) => {
      return this.request(`/settings/team/${encodeURIComponent(memberId)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    removeTeamMember: async (memberId: string) => {
      return this.request(`/settings/team/${encodeURIComponent(memberId)}`, {
        method: 'DELETE',
      });
    },

    getNotificationPreferences: async () => {
      return this.request('/settings/notifications');
    },

    updateNotificationPreferences: async (data: {
      emailNotifications?: boolean;
      smsNotifications?: boolean;
      lowCreditWarning?: boolean;
      lowCreditThreshold?: number;
      counterfeitAlerts?: boolean;
      transferUpdates?: boolean;
      dailyDigest?: boolean;
      webhookUrl?: string;
    }) => {
      return this.request('/settings/notifications', {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
  };

  // ==========================================
  // 12. ADMIN GOVERNANCE & PLATFORM OPERATIONS
  // ==========================================
  public admin = {
    getUsers: async (params?: {
      search?: string;
      role?: string;
      status?: string;
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/admin/users${qs ? `?${qs}` : ''}`);
    },

    suspendUser: async (userId: string, reason: string) => {
      return this.request(`/admin/users/${encodeURIComponent(userId)}/suspend`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      });
    },

    activateUser: async (userId: string) => {
      return this.request(`/admin/users/${encodeURIComponent(userId)}/activate`, {
        method: 'PATCH',
      });
    },

    verifyUser: async (userId: string) => {
      return this.request(`/admin/users/${encodeURIComponent(userId)}/verify`, {
        method: 'PATCH',
      });
    },

    getBrands: async (params?: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/admin/brands${qs ? `?${qs}` : ''}`);
    },

    getStats: async () => {
      return this.request('/admin/stats');
    },

    getBrandById: async (brandId: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}`);
    },

    approveBrand: async (brandId: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}/approve`, {
        method: 'POST',
      });
    },

    rejectBrand: async (brandId: string, reason: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    requestMoreInfo: async (brandId: string, details: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}/request-info`, {
        method: 'POST',
        body: JSON.stringify({ details }),
      });
    },

    suspendBrand: async (brandId: string, reason: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}/suspend`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      });
    },

    activateBrand: async (brandId: string) => {
      return this.request(`/admin/brands/${encodeURIComponent(brandId)}/activate`, {
        method: 'PATCH',
      });
    },

    getReports: async (params?: {
      status?: string;
      city?: string;
      brand?: string;
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/admin/reports${qs ? `?${qs}` : ''}`);
    },

    getReportById: async (id: string) => {
      return this.request(`/admin/reports/${encodeURIComponent(id)}`);
    },

    reviewReport: async (id: string, status: 'Submitted' | 'UnderReview' | 'Valid' | 'Invalid', notes?: string) => {
      return this.request(`/admin/reports/${encodeURIComponent(id)}/review`, {
        method: 'PATCH',
        body: JSON.stringify({ status, notes }),
      });
    },

    getRewardOffers: async (params?: {
      search?: string;
      category?: string;
      isActive?: boolean;
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams(params as any).toString();
      return this.request(`/admin/rewards/offers${qs ? `?${qs}` : ''}`);
    },

    createRewardOffer: async (data: {
      title: string;
      description: string;
      category?: string;
      pointsRequired: number;
      couponPrefix?: string;
      partner: string;
      discountAmount?: number;
      discountPercentage?: number;
      stock?: number;
      terms?: string;
      image?: string;
      isActive?: boolean;
    }) => {
      return this.request('/admin/rewards/offers', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    getRewardOfferById: async (id: string) => {
      return this.request(`/admin/rewards/offers/${encodeURIComponent(id)}`);
    },

    updateRewardOffer: async (id: string, data: any) => {
      return this.request(`/admin/rewards/offers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    deleteRewardOffer: async (id: string) => {
      return this.request(`/admin/rewards/offers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    toggleRewardOffer: async (id: string) => {
      return this.request(`/admin/rewards/offers/${encodeURIComponent(id)}/toggle`, {
        method: 'PATCH',
      });
    },

    getRewardPartners: async () => {
      return this.request('/admin/rewards/partners');
    },

    getPlatformAnalytics: async () => {
      return this.request('/admin/analytics');
    },

    getSystemHealth: async () => {
      return this.request('/admin/health');
    },

    retryTransaction: async (transactionId: string) => {
      return this.request(`/admin/transactions/${encodeURIComponent(transactionId)}/retry`, {
        method: 'POST',
      });
    },

    retryAllTransactions: async () => {
      return this.request('/admin/transactions/retry-all', {
        method: 'POST',
      });
    },

    getListenerTelemetry: async () => {
      return this.request('/admin/listener');
    },

    reconcileOnChainEvents: async () => {
      return this.request('/admin/listener/reconcile', {
        method: 'POST',
      });
    },
  };
}

export const api = new ApiService();
export default api;
