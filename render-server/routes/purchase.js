const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const crypto   = require('crypto');
const OAuthToken = require('../models/OAuthToken');

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const LMS_BASE_URL        = process.env.LMS_BASE_URL || 'https://license-system-v6ht.onrender.com';
const LMS_API_KEY         = process.env.LMS_API_KEY  || 'my-secret-key-123';

// POST /purchase/create-order
// Called by the pricing page to create a Razorpay order
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', clientId, planName } = req.body;
    if (!amount || !clientId) {
      return res.status(400).json({ success: false, message: 'amount and clientId required' });
    }

    const response = await axios.post(
      'https://api.razorpay.com/v1/orders',
      { amount: amount * 100, currency, receipt: `order_${clientId}_${Date.now()}` },
      { auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET } }
    );

    res.json({ success: true, orderId: response.data.id, amount, currency });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /purchase/verify
// Called after Razorpay payment success — verifies signature, activates license
router.post('/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      clientId,
      customerEmail,
      planId,       // LMS licenseTypeId
      billingCycle,
    } = req.body;

    // Step 1: Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    // Step 2: Call LMS to purchase/activate license
    const lmsRes = await axios.post(
      `${LMS_BASE_URL}/api/lms/purchase-license`,
      {
        email: customerEmail,
        licenseTypeId: planId,
        billingCycle,
        paymentId: razorpay_payment_id,
        orderId:   razorpay_order_id,
      },
      { headers: { 'x-api-key': LMS_API_KEY, 'Content-Type': 'application/json' } }
    );

    if (!lmsRes.data?.success) {
      return res.status(500).json({ success: false, message: 'LMS activation failed', detail: lmsRes.data });
    }

    const { licenseId, plan } = lmsRes.data;

    // Step 3: Link license to this Bitrix24 portal
    await axios.post(
      `${process.env.APP_URL}/api/license/link`,
      { clientId, customerEmail, licenseId, licensePlan: plan, licenseStatus: 'active' }
    );

    // Step 4: Store email on OAuthToken so agent picks it up on next poll
    await OAuthToken.findOneAndUpdate(
      { clientId },
      { customerEmail, licenseId, licensePlan: plan, licenseStatus: 'active', licenseLinkedAt: new Date() }
    );

    res.json({ success: true, licenseId, plan, message: 'License activated — sync will resume within 6 hours' });
  } catch (e) {
    console.error('[Purchase] Verify error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /purchase/webhook  (Razorpay server-to-server webhook, backup)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig  = req.headers['x-razorpay-signature'];
  const body = req.body;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (sig !== expected) return res.status(400).send('Invalid signature');

  const event = JSON.parse(body.toString());
  console.log('[Purchase] Razorpay webhook event:', event.event);
  // Handle payment.captured as a fallback if /verify wasn't called
  res.json({ status: 'ok' });
});

module.exports = router;