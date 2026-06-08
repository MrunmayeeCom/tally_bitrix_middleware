import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check, CheckCircle, CheckCircle2, AlertCircle, X,
  Lock, ShieldCheck, BadgeCheck, CreditCard, Zap, Users, ArrowLeft, Building2, Mail, Phone, MapPin,
} from "lucide-react";
import { createPortal } from "react-dom";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type BillingCycle = "monthly" | "quarterly" | "half-yearly" | "yearly";
type ToastType    = "success" | "error";

interface Toast { id: number; message: string; type: ToastType; }

interface LMSPlan {
  licenseId: string;
  planName: string;
  pricePerUser: number;
  includedUsers: number;
  features: { featureSlug: string; uiLabel: string }[];
  discountConfig: Record<BillingCycle, number>;
}

interface FormData {
  companyName: string; email: string; phone: string;
  address: string; city: string; state: string; pincode: string; gstNumber: string;
}

interface PricingAndCheckoutProps { onBack?: () => void; }

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const LMS_BASE_URL = "https://license-system-v6ht.onrender.com";
const LMS_API_KEY  = "my-secret-key-123";
const PRODUCT_ID   = "69ba90211cf0356ba779b317";

const APP_BASE_URL    = "https://tally-bitrix-middleware.onrender.com";
const RAZORPAY_KEY_ID = "rzp_live_XXXXXXXXXXXXXXXX"; // replace with your actual key

function getClientId(): string {
  try { return new URLSearchParams(window.location.search).get("clientId") || ""; }
  catch { return ""; }
}

const CYCLES: { key: BillingCycle; label: string; months: number }[] = [
  { key: "quarterly",   label: "Quarterly",   months: 3  },
  { key: "half-yearly", label: "Half-Yearly", months: 6  },
  { key: "yearly",      label: "Yearly",      months: 12 },
];

const BILLING_PERIOD_LABEL: Record<BillingCycle, string> = {
  monthly:      "1 month",
  quarterly:    "3 months",
  "half-yearly":"6 months",
  yearly:       "12 months",
};

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: number) => void }) {
  return createPortal(
    <div style={{ position:"fixed", top:16, right:16, zIndex:9999, display:"flex", flexDirection:"column", gap:8, pointerEvents:"none" }}>
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div key={toast.id}
            initial={{ opacity:0, x:50, scale:0.95 }} animate={{ opacity:1, x:0, scale:1 }} exit={{ opacity:0, x:50, scale:0.95 }}
            transition={{ type:"spring", stiffness:320, damping:26 }}
            style={{ pointerEvents:"auto", position:"relative", display:"flex", alignItems:"flex-start", gap:10, background:"white", border:"1px solid #e5e7eb", borderRadius:14, boxShadow:"0 8px 30px rgba(0,0,0,0.10)", padding:"13px 16px", minWidth:270, maxWidth:330, overflow:"hidden", fontFamily:"'Inter',sans-serif" }}
          >
            {toast.type === "success"
              ? <CheckCircle size={15} style={{ color:"#16a34a", flexShrink:0, marginTop:1 }} />
              : <AlertCircle size={15} style={{ color:"#dc2626", flexShrink:0, marginTop:1 }} />}
            <p style={{ fontSize:13, color:"#1f2937", fontWeight:500, flex:1, lineHeight:1.5, margin:0 }}>{toast.message}</p>
            <button onClick={() => onRemove(toast.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#9ca3af", padding:0 }}><X size={13} /></button>
            <motion.div initial={{ scaleX:1 }} animate={{ scaleX:0 }} transition={{ duration:4, ease:"linear" }}
              style={{ transformOrigin:"left", position:"absolute", bottom:0, left:0, right:0, height:2, background: toast.type==="success" ? "#4ade80" : "#f87171" }} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}

// ─────────────────────────────────────────────
// ALREADY ACTIVE MODAL
// ─────────────────────────────────────────────

function AlreadyActiveModal({ planName, onClose }: { planName: string; onClose: () => void }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 16px", background:"rgba(15,23,42,0.45)", backdropFilter:"blur(6px)" }}>
      <motion.div initial={{ opacity:0, scale:0.94, y:16 }} animate={{ opacity:1, scale:1, y:0 }} transition={{ type:"spring", stiffness:300, damping:24 }}
        style={{ background:"white", width:"100%", maxWidth:380, borderRadius:24, boxShadow:"0 32px 80px rgba(0,0,0,0.16)", padding:"40px 32px 32px", textAlign:"center", fontFamily:"'Inter',sans-serif" }}>
        <div style={{ width:64, height:64, borderRadius:"50%", background:"linear-gradient(135deg,#dcfce7,#bbf7d0)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 16px", boxShadow:"0 0 0 10px rgba(22,163,74,0.07)" }}>
          <Check size={26} style={{ color:"#16a34a" }} />
        </div>
        <h3 style={{ fontSize:20, fontWeight:700, color:"#0f172a", margin:"0 0 8px" }}>Plan Already Active!</h3>
        <p style={{ fontSize:14, color:"#64748b", margin:"0 0 24px", lineHeight:1.65 }}>
          You already have an active <strong style={{ color:"#0d7a8a" }}>{planName}</strong> plan on your account.
        </p>
        <button onClick={onClose} style={{ width:"100%", padding:"12px", borderRadius:12, border:"none", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"'Inter',sans-serif" }}>
          Continue
        </button>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────
// BILLING FORM (inlined from BillingForm.tsx)
// ─────────────────────────────────────────────

interface BillingFormProps {
  formData: FormData;
  onChange: (field: keyof FormData, value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  submitting: boolean;
}

function BillingForm({ formData, onChange, onSubmit, submitting }: BillingFormProps) {
  return (
    <form onSubmit={onSubmit}>
      <div className="pc-form-grid">

        <div className="pc-field pc-field-full">
          <label className="pc-label">Company Name <span className="pc-req">*</span></label>
          <div className="pc-input-wrap">
            <Building2 size={15} className="pc-input-ico" />
            <input placeholder="Enter company name" value={formData.companyName}
              onChange={e => onChange("companyName", e.target.value)}
              className="pc-input pc-input-ico-pad" required />
          </div>
        </div>

        <div className="pc-field">
          <label className="pc-label">Email Address <span className="pc-req">*</span></label>
          <div className="pc-input-wrap">
            <Mail size={15} className="pc-input-ico" />
            <input type="email" value={formData.email} readOnly
              className="pc-input pc-input-ico-pad pc-input-readonly" />
          </div>
        </div>

        <div className="pc-field">
          <label className="pc-label">Phone Number <span className="pc-req">*</span></label>
          <div className="pc-input-wrap">
            <Phone size={15} className="pc-input-ico" />
            <input type="tel" placeholder="+91 98765 43210" value={formData.phone}
              onChange={e => onChange("phone", e.target.value)}
              className="pc-input pc-input-ico-pad" required />
          </div>
        </div>

        <div className="pc-field pc-field-full">
          <label className="pc-label">Address <span className="pc-req">*</span></label>
          <div className="pc-input-wrap">
            <MapPin size={15} className="pc-input-ico" />
            <input placeholder="Street address" value={formData.address}
              onChange={e => onChange("address", e.target.value)}
              className="pc-input pc-input-ico-pad" required />
          </div>
        </div>

        <div className="pc-field">
          <label className="pc-label">City <span className="pc-req">*</span></label>
          <input placeholder="City" value={formData.city}
            onChange={e => onChange("city", e.target.value)}
            className="pc-input" required />
        </div>

        <div className="pc-field">
          <label className="pc-label">State <span className="pc-req">*</span></label>
          <input placeholder="State" value={formData.state}
            onChange={e => onChange("state", e.target.value)}
            className="pc-input" required />
        </div>

        <div className="pc-field">
          <label className="pc-label">Pincode <span className="pc-req">*</span></label>
          <input placeholder="400001" value={formData.pincode}
            onChange={e => onChange("pincode", e.target.value)}
            className="pc-input" required />
        </div>

        <div className="pc-field">
          <label className="pc-label">GST Number <span className="pc-opt">(Optional)</span></label>
          <input placeholder="22AAAAA0000A1Z5" value={formData.gstNumber}
            onChange={e => onChange("gstNumber", e.target.value)}
            className="pc-input" />
        </div>

        <div className="pc-submit-row">
          <button type="submit" disabled={submitting} className="pc-submit">
            <CreditCard size={15} />
            {submitting ? "Processing…" : "Proceed to Payment"}
          </button>
        </div>

      </div>
    </form>
  );
}

// ─────────────────────────────────────────────
// CHECKOUT SUMMARY (inlined from CheckoutSummary.tsx)
// ─────────────────────────────────────────────

interface CheckoutSummaryProps {
  plan: LMSPlan;
  billingCycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
}

function CheckoutSummary({ plan, billingCycle, onCycleChange }: CheckoutSummaryProps) {
  const discountPct  = plan.discountConfig[billingCycle] ?? 0;
  const months       = CYCLES.find(c => c.key === billingCycle)!.months;
  const baseTotal    = plan.pricePerUser * months;
  const discountAmt  = Math.round((baseTotal * discountPct) / 100);
  const subtotal     = baseTotal - discountAmt;
  const gst          = Math.round(subtotal * 0.18 * 100) / 100;
  const total        = Math.round((subtotal + gst) * 100) / 100;

  return (
    <div style={{ background:"#ffffff", borderRadius:16, border:"1px solid #e5e7eb", overflow:"hidden", fontFamily:"'Inter',sans-serif", position:"sticky", top:76 }}>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0d7a8a 0%,#0a3d5c 100%)", padding:"20px 24px", color:"#ffffff" }}>
        <p style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", color:"rgba(255,255,255,0.6)", margin:"0 0 10px" }}>ORDER SUMMARY</p>
        <div style={{ display:"inline-block", background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.25)", borderRadius:20, padding:"4px 14px", fontSize:13, fontWeight:600, color:"#ffffff", marginBottom:10 }}>
          {plan.planName}
        </div>
        <div style={{ display:"flex", alignItems:"center", fontSize:13, color:"rgba(255,255,255,0.8)" }}>
          <Users size={14} style={{ marginRight:6, opacity:0.8 }} />
          Includes {plan.includedUsers} users
        </div>
      </div>

      {/* Billing cycle switcher */}
      <div style={{ padding:"16px 24px" }}>
        <p style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:"#9ca3af", margin:"0 0 12px" }}>BILLING CYCLE</p>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          {CYCLES.filter(c => c.key !== "monthly").map(c => {
            const disc   = plan.discountConfig[c.key] ?? 0;
            const active = billingCycle === c.key;
            return (
              <button key={c.key} onClick={() => onCycleChange(c.key)}
                style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 8px", borderRadius:10, cursor:"pointer",
                  border: active ? "1.5px solid #0d7a8a" : "1.5px solid #e5e7eb",
                  background: active ? "linear-gradient(135deg,#0d7a8a,#0a3d5c)" : "#f9fafb",
                  color: active ? "#ffffff" : "#374151",
                  fontFamily:"'Inter',sans-serif", transition:"all 0.15s ease" }}>
                <span style={{ fontSize:12, fontWeight:600 }}>{c.label}</span>
                {disc > 0 && (
                  <span style={{ fontSize:10, fontWeight:700, borderRadius:4, padding:"1px 5px", marginTop:3,
                    background: active ? "rgba(255,255,255,0.2)" : "#d1fae5",
                    color: active ? "#ffffff" : "#065f46" }}>
                    -{disc}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Breakdown */}
      <div style={{ padding:"0 24px 16px" }}>
        {[
          { label:"Plan price",     value:`₹${plan.pricePerUser.toLocaleString("en-IN")}` },
          { label:"Billing period", value: BILLING_PERIOD_LABEL[billingCycle], bold: true },
        ].map(({ label, value, bold }) => (
          <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:13, color:"#6b7280" }}>{label}</span>
            <span style={{ fontSize:13, color:"#111827", fontWeight: bold ? 600 : 500 }}>{value}</span>
          </div>
        ))}
        {discountPct > 0 && (
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:13, color:"#0d7a8a" }}>Discount ({discountPct}%)</span>
            <span style={{ fontSize:13, color:"#0d7a8a", fontWeight:600 }}>-₹{discountAmt.toLocaleString("en-IN")}</span>
          </div>
        )}
      </div>

      <div style={{ height:1, background:"#f3f4f6", margin:"0 24px" }} />

      <div style={{ padding:"16px 24px" }}>
        {[
          { label:"Subtotal",   value:`₹${subtotal.toLocaleString("en-IN")}` },
          { label:"GST (18%)",  value:`₹${gst.toLocaleString("en-IN")}` },
        ].map(({ label, value }) => (
          <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:13, color:"#6b7280" }}>{label}</span>
            <span style={{ fontSize:13, color:"#111827", fontWeight:500 }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Total */}
      <div style={{ margin:"0 24px 16px", background:"#0f172a", borderRadius:12, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:14, fontWeight:600, color:"#ffffff" }}>Total Amount</span>
        <span style={{ fontSize:20, fontWeight:700, color:"#ffffff" }}>₹{total.toLocaleString("en-IN")}</span>
      </div>

      {/* Trust */}
      <div style={{ display:"flex", flexDirection:"column", gap:6, padding:"0 24px 20px" }}>
        {["Secure payment processing", "Money-back guarantee", "Cancel anytime"].map(t => (
          <div key={t} style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:"#6b7280" }}>
            <ShieldCheck size={13} style={{ color:"#0d7a8a", flexShrink:0 }} /> {t}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN: PricingAndCheckout
// ─────────────────────────────────────────────

export function PricingAndCheckout({ onBack }: PricingAndCheckoutProps) {
  const [billingCycle, setBillingCycle]       = useState<BillingCycle>("quarterly");
  const [lmsPlan, setLmsPlan]                 = useState<LMSPlan | null>(null);
  const [loading, setLoading]                 = useState(true);
  const [submitting, setSubmitting]           = useState(false);
  const [showActiveModal, setShowActiveModal] = useState(false);
  const [existingPlanName, setExistingPlanName] = useState("Current");
  const [toasts, setToasts]                   = useState<Toast[]>([]);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [formData, setFormData] = useState<FormData>({
    companyName:"", email:"", phone:"", address:"", city:"", state:"", pincode:"", gstNumber:"",
  });

  const CLIENT_ID = getClientId();

  const showToast = useCallback((message: string, type: ToastType) => {
    const id = Date.now();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast  = useCallback((id: number) => setToasts(p => p.filter(t => t.id !== id)), []);
  const handleChange = (field: keyof FormData, value: string) => setFormData(p => ({ ...p, [field]: value }));

  // Load plan from LMS
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${LMS_BASE_URL}/api/license/public/licenses-by-product/${PRODUCT_ID}`, { headers: { "x-api-key": LMS_API_KEY } });
        const data = await res.json();
        const licenses = data.licenses || data.data || data || [];
        const matched  = licenses.find((lic: any) => {
          const lt = lic.licenseTypeId || lic.licenseType;
          return (lt?.price?.amount ?? 0) > 0 && lt?.name?.toLowerCase() !== "enterprise";
        }) || licenses[0];
        if (!matched) throw new Error("Plan not found");
        const lt = matched.licenseTypeId || matched.licenseType;
        if (lt.price?.amount === undefined || lt.price?.amount === null) throw new Error("Price missing");
        let userCount = 1;
        const rawFeatures = lt.features || [];
        if (Array.isArray(rawFeatures)) {
          for (const f of rawFeatures) {
            if (typeof f === "object" && f.featureType === "limit") {
              const slug = (f.featureSlug || f.featureKey || "").toLowerCase();
              const val  = f.limitValue ?? f.value;
              if (slug.includes("user") && typeof val === "number") { userCount = val; break; }
            }
          }
        }
        setLmsPlan({
          licenseId:      matched._id,
          planName:       lt.name,
          pricePerUser:   lt.price.amount,
          includedUsers:  userCount,
          features:       Array.isArray(rawFeatures) ? rawFeatures.filter((f: any) => typeof f === "object" && f.uiLabel) : [],
          discountConfig: lt.discountConfig ?? { monthly:0, quarterly:0, "half-yearly":0, yearly:0 },
        });
      } catch (err) {
        console.error("LMS fetch failed:", err);
        showToast("Failed to load plan details. Please refresh and try again.", "error");
      } finally { setLoading(false); }
    })();
  }, []);

  // Pre-fill email + check existing license
  useEffect(() => {
    try {
      const raw = localStorage.getItem("user");
      if (!raw) return;
      const user = JSON.parse(raw);
      if (user?.email) {
        setFormData(p => ({ ...p, email: user.email }));
        fetch(`${LMS_BASE_URL}/api/external/actve-license/${user.email}?productId=${PRODUCT_ID}`, { headers: { "x-api-key": LMS_API_KEY } })
          .then(r => r.json())
          .then(d => {
            if (d.activeLicense?.status === "active") {
              const lt = d.activeLicense.licenseTypeId || d.activeLicense.licenseType || {};
              setExistingPlanName(lt.name || "Current");
              setShowActiveModal(true);
            }
          }).catch(() => {});
      }
    } catch {}
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lmsPlan?.licenseId) { showToast("Plan not loaded. Please try again.", "error"); return; }
    setSubmitting(true);
    try {
      // 1. Load Razorpay SDK
      const { loadRazorpay } = await import("../../src/utils/loadRazorpay");
      if (!loaded) { showToast("Failed to load payment gateway. Please try again.", "error"); setSubmitting(false); return; }

      // 2. Compute final amount (with GST, after discount)
      const discountPct  = lmsPlan.discountConfig[billingCycle] ?? 0;
      const months       = CYCLES.find(c => c.key === billingCycle)!.months;
      const baseTotal    = lmsPlan.pricePerUser * months;
      const discountAmt  = Math.round((baseTotal * discountPct) / 100);
      const subtotal     = baseTotal - discountAmt;
      const gst          = Math.round(subtotal * 0.18 * 100) / 100;
      const totalAmount  = Math.round((subtotal + gst) * 100) / 100;

      // 3. Create Razorpay order via your backend
      const orderRes = await fetch(`${APP_BASE_URL}/purchase/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount:   totalAmount,
          currency: "INR",
          clientId: CLIENT_ID,
          planName: lmsPlan.planName,
        }),
      });
      const orderData = await orderRes.json();
      if (!orderData.success) throw new Error(orderData.message || "Order creation failed");

      // 4. Open Razorpay checkout
      const options = {
        key:          RAZORPAY_KEY_ID,
        amount:       orderData.amount * 100,
        currency:     orderData.currency,
        name:         "Middleware",
        description:  `${lmsPlan.planName} — ${billingCycle}`,
        order_id:     orderData.orderId,
        prefill: {
          name:    formData.companyName,
          email:   formData.email,
          contact: formData.phone,
        },
        notes: {
          address:    `${formData.address}, ${formData.city}, ${formData.state} - ${formData.pincode}`,
          gstNumber:  formData.gstNumber,
          billingCycle,
        },
        theme: { color: "#0d7a8a" },
        handler: async (response: any) => {
          try {
            // 5. Verify payment + activate license
            const verifyRes = await fetch(`${APP_BASE_URL}/purchase/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id:   response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature:  response.razorpay_signature,
                clientId:            CLIENT_ID,
                customerEmail:       formData.email,
                planId:              lmsPlan.licenseId,
                billingCycle,
              }),
            });
            const verifyData = await verifyRes.json();
            if (!verifyData.success) throw new Error(verifyData.message || "Verification failed");
            showToast("🎉 Payment successful! License activated.", "success");
            // Give user 2 seconds to see the toast, then redirect back to dashboard
            setTimeout(() => {
              const dashUrl = `https://tally-bitrix-middleware.onrender.com/dashboard-ui?clientId=${CLIENT_ID}`;
              window.location.href = dashUrl;
            }, 2000);
          } catch (err: any) {
            showToast(err?.message || "Payment verification failed. Contact support.", "error");
          } finally {
            setSubmitting(false);
          }
        },
        modal: {
          ondismiss: () => {
            showToast("Payment cancelled.", "error");
            setSubmitting(false);
          },
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    } catch (err: any) {
      showToast(err?.message || "Something went wrong. Please try again.", "error");
      setSubmitting(false);
    }
  };

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {showActiveModal && <AlreadyActiveModal planName={existingPlanName} onClose={() => setShowActiveModal(false)} />}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; }

        .pc-root { font-family:'Inter',sans-serif; min-height:100vh; background:#f8fafc; color:#0f172a; }

        /* TOPBAR */
        .pc-topbar { background:white; border-bottom:1px solid #e8ecf0; padding:0 32px; height:60px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:30; box-shadow:0 1px 3px rgba(0,0,0,0.04); }
        .pc-brand { display:flex; align-items:center; gap:10px; }
        .pc-brand-icon { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#0d7a8a 0%,#0a3d5c 100%); display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(13,122,138,0.3); }
        .pc-brand-name { font-size:15px; font-weight:700; color:#0f172a; letter-spacing:-0.02em; }
        .pc-steps { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:500; }
        .pc-step { display:flex; align-items:center; gap:5px; color:#94a3b8; }
        .pc-step.done { color:#0d7a8a; }
        .pc-step.active { color:#0f172a; font-weight:600; }
        .pc-step-dot { width:20px; height:20px; border-radius:50%; background:#e2e8f0; color:#94a3b8; font-size:10px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; }
        .pc-step.done .pc-step-dot { background:#dcfce7; color:#16a34a; }
        .pc-step.active .pc-step-dot { background:linear-gradient(135deg,#0d7a8a,#0a3d5c); color:white; }
        .pc-step-sep { color:#d1d5db; font-size:14px; }

        /* PAGE */
        .pc-page { max-width:1100px; margin:0 auto; padding:36px 24px 80px; }
        .pc-back { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; color:#64748b; background:none; border:none; cursor:pointer; padding:0; font-family:'Inter',sans-serif; margin-bottom:20px; transition:color 0.15s; }
        .pc-back:hover { color:#0d7a8a; }

        /* PLAN HERO */
        .pc-plan-hero { text-align:center; margin-bottom:40px; padding-top:12px; }
        .pc-plan-hero-tag { display:inline-flex; align-items:center; gap:6px; background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d; font-size:11px; font-weight:600; padding:4px 12px; border-radius:100px; margin-bottom:14px; letter-spacing:0.03em; }
        .pc-plan-hero-title { font-size:clamp(1.8rem,3.5vw,2.6rem); font-weight:800; color:#0f172a; letter-spacing:-0.04em; margin:0 0 8px; line-height:1.1; }
        .pc-plan-hero-sub { font-size:15px; color:#64748b; margin:0 auto 32px; max-width:480px; font-weight:400; }

        /* BILLING CYCLE PILLS */
        .pc-cycle-selector { display:inline-grid; grid-template-columns:repeat(3, 1fr); gap:6px; background:white; border:1px solid #e8ecf0; border-radius:16px; padding:6px; box-shadow:0 2px 12px rgba(0,0,0,0.06); margin-bottom:36px; width:460px; }
        .pc-cycle-pill { padding:12px 16px; border-radius:10px; border:1.5px solid #e8ecf0; font-size:13px; font-weight:600; font-family:'Inter',sans-serif; cursor:pointer; text-align:center; transition:all 0.18s; color:#64748b; background:#fafbfc; display:flex; align-items:center; justify-content:center; gap:7px; white-space:nowrap; }
        .pc-cycle-pill:hover { color:#0d7a8a; background:#f0fdfc; }
        .pc-cycle-pill.active { background:linear-gradient(135deg,#0d7a8a,#0a3d5c); color:white; box-shadow:0 4px 14px rgba(13,122,138,0.28); }
        .pc-cycle-pill-disc { display:inline-block; font-size:10px; font-weight:700; padding:2px 7px; border-radius:100px; background:#d1fae5; color:#065f46; letter-spacing:0.02em; }
        .pc-cycle-pill.active .pc-cycle-pill-disc { background:rgba(255,255,255,0.22); color:white; }

        /* SINGLE PLAN CARD */
        .pc-single-plan-wrap { display:flex; justify-content:center; margin-bottom:48px; }
        .pc-single-plan-card { width:100%; max-width:540px; background:white; border:2px solid #99e6f0; border-radius:22px; overflow:hidden; box-shadow:0 8px 40px rgba(13,122,138,0.12),0 2px 8px rgba(0,0,0,0.04); position:relative; }
        .pc-single-plan-card::before { content:''; position:absolute; top:0; left:0; right:0; height:4px; background:linear-gradient(90deg,#0d7a8a,#0a3d5c); }
        .pc-single-plan-top { background:linear-gradient(135deg,#f0fdfc 0%,#e6f4f8 100%); padding:32px 32px 24px; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .pc-single-plan-name { display:inline-flex; align-items:center; gap:7px; background:linear-gradient(135deg,#0d7a8a,#0a3d5c); color:white; font-size:13px; font-weight:700; padding:6px 16px; border-radius:100px; margin-bottom:12px; box-shadow:0 2px 8px rgba(13,122,138,0.3); letter-spacing:-0.01em; }
        .pc-single-plan-users { display:flex; align-items:center; gap:5px; font-size:13px; color:#0d7a8a; font-weight:500; }
        .pc-single-plan-price-block { text-align:right; flex-shrink:0; }
        .pc-single-plan-original { font-size:14px; color:#94a3b8; text-decoration:line-through; margin-bottom:2px; font-weight:400; }
        .pc-single-plan-price { font-size:2.8rem; font-weight:800; color:#0d7a8a; letter-spacing:-0.05em; line-height:1; }
        .pc-single-plan-period { font-size:12px; color:#94a3b8; font-weight:400; margin-top:4px; }
        .pc-single-plan-save { display:inline-block; background:#d1fae5; color:#065f46; font-size:11px; font-weight:700; padding:3px 10px; border-radius:100px; margin-top:6px; }
        .pc-single-plan-feats { padding:22px 32px 26px; display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .pc-single-plan-feat { display:flex; align-items:center; gap:8px; font-size:13px; color:#374151; font-weight:500; }
        .pc-single-plan-feat-check { width:18px; height:18px; border-radius:50%; background:#dcfce7; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .pc-single-plan-cta { padding:0 32px 28px; }
        .pc-single-plan-btn { width:100%; height:52px; border-radius:13px; border:none; background:linear-gradient(135deg,#0d7a8a 0%,#0a3d5c 100%); color:white; font-size:15px; font-weight:700; font-family:'Inter',sans-serif; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:transform 0.15s,box-shadow 0.15s; box-shadow:0 4px 16px rgba(13,122,138,0.3); letter-spacing:-0.01em; }
        .pc-single-plan-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(13,122,138,0.38); }

        /* CHECKOUT DIVIDER */
        .pc-checkout-divider { display:flex; align-items:center; gap:16px; margin-bottom:32px; }
        .pc-checkout-divider-line { flex:1; height:1px; background:#e8ecf0; }
        .pc-checkout-divider-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:#94a3b8; white-space:nowrap; }

        /* GRID */
        .pc-grid { display:grid; grid-template-columns:1fr 360px; gap:20px; align-items:start; }
        @media (max-width:860px) { .pc-grid { grid-template-columns:1fr; } }

        /* CARDS */
        .pc-card { background:white; border:1px solid #e8ecf0; border-radius:18px; padding:28px; margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,0.03),0 4px 16px rgba(0,0,0,0.03); position:relative; overflow:hidden; }
        .pc-card:last-child { margin-bottom:0; }
        .pc-card::before { content:''; position:absolute; top:0; left:28px; right:28px; height:2px; background:linear-gradient(90deg,#0d7a8a,#0a5c8a); border-radius:0 0 2px 2px; opacity:0; transition:opacity 0.2s; }
        .pc-card:hover::before { opacity:1; }
        .pc-card-header { display:flex; align-items:center; gap:8px; margin-bottom:20px; }
        .pc-step-badge { width:24px; height:24px; border-radius:50%; background:linear-gradient(135deg,#0d7a8a,#0a3d5c); color:white; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 2px 6px rgba(13,122,138,0.3); }
        .pc-card-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:#94a3b8; }

        /* PLAN BOX (recap) */
        .pc-plan-box { background:linear-gradient(135deg,#f0fdfc 0%,#e6f4f8 100%); border:1.5px solid #99e6f0; border-radius:14px; padding:22px; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
        .pc-plan-name-chip { display:inline-flex; align-items:center; gap:6px; background:linear-gradient(135deg,#0d7a8a,#0a3d5c); color:white; font-size:12px; font-weight:600; padding:5px 13px; border-radius:100px; margin-bottom:10px; box-shadow:0 2px 8px rgba(13,122,138,0.25); }
        .pc-plan-users-row { display:flex; align-items:center; gap:5px; font-size:13px; color:#0d7a8a; font-weight:500; margin-bottom:14px; }
        .pc-plan-feats { display:flex; flex-direction:column; gap:6px; }
        .pc-plan-feat { display:flex; align-items:center; gap:7px; font-size:12.5px; color:#374151; }
        .pc-plan-feat-check { width:16px; height:16px; border-radius:50%; background:#dcfce7; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .pc-price-block { text-align:right; flex-shrink:0; }
        .pc-price-amount { font-size:2.2rem; font-weight:800; color:#0d7a8a; letter-spacing:-0.05em; line-height:1; }
        .pc-price-period { font-size:12px; color:#94a3b8; font-weight:400; margin-top:3px; }

        /* FORM */
        .pc-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
        .pc-field { display:flex; flex-direction:column; gap:5px; }
        .pc-field-full { grid-column:1 / -1; }
        .pc-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#94a3b8; }
        .pc-req { color:#ef4444; margin-left:2px; }
        .pc-opt { text-transform:none; font-weight:400; color:#cbd5e1; letter-spacing:0; }
        .pc-input-wrap { position:relative; }
        .pc-input-ico { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#cbd5e1; pointer-events:none; transition:color 0.15s; }
        .pc-input { width:100%; height:44px; padding:0 14px; border:1.5px solid #e8ecf0; border-radius:10px; font-size:13.5px; font-family:'Inter',sans-serif; color:#0f172a; background:#fafbfc; outline:none; transition:border-color 0.15s,background 0.15s,box-shadow 0.15s; }
        .pc-input::placeholder { color:#c8d0da; }
        .pc-input:focus { border-color:#0d7a8a; background:white; box-shadow:0 0 0 3px rgba(13,122,138,0.09); }
        .pc-input-ico-pad { padding-left:38px; }
        .pc-input-readonly { background:#f1f5f9 !important; color:#94a3b8 !important; cursor:not-allowed; border-color:#e8ecf0 !important; box-shadow:none !important; }
        .pc-submit-row { grid-column:1 / -1; display:flex; justify-content:flex-end; margin-top:4px; }
        .pc-submit { display:inline-flex; align-items:center; gap:8px; padding:0 28px; height:48px; border-radius:12px; border:none; background:linear-gradient(135deg,#0d7a8a 0%,#0a3d5c 100%); color:white; font-size:14px; font-weight:600; font-family:'Inter',sans-serif; cursor:pointer; transition:transform 0.15s,box-shadow 0.15s; box-shadow:0 4px 14px rgba(13,122,138,0.28); letter-spacing:-0.01em; }
        .pc-submit:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 6px 20px rgba(13,122,138,0.38); }
        .pc-submit:disabled { opacity:0.6; cursor:not-allowed; }

        /* SECURITY */
        .pc-security { display:flex; align-items:center; justify-content:center; gap:28px; margin-top:16px; flex-wrap:wrap; }
        .pc-sec-item { display:flex; align-items:center; gap:6px; font-size:12px; color:#94a3b8; font-weight:500; }

        /* LOADING */
        .pc-loading { min-height:100vh; background:#f8fafc; display:flex; align-items:center; justify-content:center; font-family:'Inter',sans-serif; }
        .pc-spinner { width:36px; height:36px; border:3px solid #e2e8f0; border-top-color:#0d7a8a; border-radius:50%; animation:pc-spin 0.75s linear infinite; margin:0 auto 12px; }
        @keyframes pc-spin { to { transform:rotate(360deg); } }
        .pc-loading-txt { font-size:13px; color:#94a3b8; text-align:center; margin:0; }
      `}</style>

      {loading ? (
        <div className="pc-loading">
          <div>
            <div className="pc-spinner" />
            <p className="pc-loading-txt">Loading plan…</p>
          </div>
        </div>
      ) : !lmsPlan ? (
        <div className="pc-loading">
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:14 }}>⚠️</div>
            <p style={{ fontSize:16, fontWeight:700, color:"#0f172a", margin:"0 0 6px", fontFamily:"'Inter',sans-serif" }}>Could not load plan details</p>
            <p style={{ fontSize:13, color:"#94a3b8", margin:"0 0 22px", fontFamily:"'Inter',sans-serif" }}>Unable to fetch pricing from the server. Please check your connection and try again.</p>
            <button onClick={() => window.location.reload()}
              style={{ padding:"11px 28px", borderRadius:11, border:"none", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"'Inter',sans-serif", boxShadow:"0 4px 14px rgba(13,122,138,0.28)" }}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="pc-root">

          {/* TOPBAR */}
          <div className="pc-topbar">
            <div className="pc-brand">
              <div className="pc-brand-icon"><CreditCard size={16} color="white" /></div>
              <span className="pc-brand-name">Middleware Checkout</span>
            </div>
            <div className="pc-steps">
              <span className={`pc-step ${checkoutVisible ? "done" : "active"}`}>
                {checkoutVisible ? <CheckCircle2 size={13} /> : <span className="pc-step-dot">1</span>} Select Plan
              </span>
              <span className="pc-step-sep">›</span>
              <span className={`pc-step ${checkoutVisible ? "active" : ""}`}>
                <span className="pc-step-dot">2</span> Billing Details
              </span>
              <span className="pc-step-sep">›</span>
              <span className="pc-step">
                <span className="pc-step-dot">3</span> Payment
              </span>
            </div>
          </div>

          <div className="pc-page">
            {onBack && (
              <motion.button className="pc-back" onClick={onBack}
                initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }} transition={{ duration:0.3 }}>
                <ArrowLeft size={14} /> Back
              </motion.button>
            )}

            {/* PLAN HERO + CYCLE SELECTOR */}
            <motion.div className="pc-plan-hero"
              initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ duration:0.4 }}>
              <div className="pc-plan-hero-tag">
                <Check size={11} /> One-time setup · Instant access
              </div>
              <h1 className="pc-plan-hero-title">Pricing</h1>
              <p className="pc-plan-hero-sub">Choose a billing cycle that works for you and get started instantly</p>

              <div style={{ display:"flex", justifyContent:"center" }}>
                <div className="pc-cycle-selector">
                  {([
                    { key:"quarterly"   as BillingCycle, label:"Quarterly",   disc: lmsPlan.discountConfig.quarterly },
                    { key:"half-yearly" as BillingCycle, label:"Half Yearly", disc: lmsPlan.discountConfig["half-yearly"] },
                    { key:"yearly"      as BillingCycle, label:"Yearly",      disc: lmsPlan.discountConfig.yearly },
                  ]).map(({ key, label, disc }) => (
                    <button key={key}
                      className={`pc-cycle-pill${billingCycle === key ? " active" : ""}`}
                      onClick={() => setBillingCycle(key)}>
                      {label}
                      {disc > 0 && <span className="pc-cycle-pill-disc">-{disc}%</span>}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* SINGLE PLAN CARD */}
            <motion.div className="pc-single-plan-wrap"
              initial={{ opacity:0, y:24 }} animate={{ opacity:1, y:0 }} transition={{ duration:0.45, delay:0.12 }}>
              <div className="pc-single-plan-card">
                <div className="pc-single-plan-top">
                  <div>
                    <div className="pc-single-plan-name"><Zap size={12} /> {lmsPlan.planName}</div>
                    <div className="pc-single-plan-users"><Users size={14} /> Includes {lmsPlan.includedUsers} users</div>
                  </div>
                  <div className="pc-single-plan-price-block">
                    {(() => {
                    const disc       = lmsPlan.discountConfig[billingCycle] ?? 0;
                    const months     = CYCLES.find(c => c.key === billingCycle)!.months;
                    const baseTotal  = lmsPlan.pricePerUser * months;
                    const discountAmt = Math.round((baseTotal * disc) / 100);
                    const subtotal   = baseTotal - discountAmt;
                    const gst        = Math.round(subtotal * 0.18 * 100) / 100;
                    const total      = Math.round((subtotal + gst) * 100) / 100;
                    const baseTotalWithGst = Math.round((baseTotal * 1.18) * 100) / 100;

                    return (
                        <>
                        {disc > 0 && (
                            <div className="pc-single-plan-original">
                            ₹{baseTotalWithGst.toLocaleString("en-IN")}
                            </div>
                        )}
                        <div className="pc-single-plan-price">₹{total.toLocaleString("en-IN")}</div>
                        <div className="pc-single-plan-period">/{BILLING_PERIOD_LABEL[billingCycle]} · incl. GST</div>
                        {disc > 0 && <div className="pc-single-plan-save">Save {disc}%</div>}
                        </>
                    );
                    })()}
                  </div>
                </div>
                {lmsPlan.features.length > 0 && (
                  <div className="pc-single-plan-feats">
                    {lmsPlan.features.slice(0, 6).map(f => (
                      <div key={f.featureSlug} className="pc-single-plan-feat">
                        <span className="pc-single-plan-feat-check"><Check size={10} strokeWidth={3} color="#16a34a" /></span>
                        {f.uiLabel}
                      </div>
                    ))}
                  </div>
                )}
                <div className="pc-single-plan-cta">
                  <button className="pc-single-plan-btn"
                    onClick={() => {
                      setCheckoutVisible(true);
                      setTimeout(() => document.getElementById("pc-checkout-anchor")?.scrollIntoView({ behavior:"smooth" }), 50);
                    }}>
                    <CreditCard size={16} /> Get Started
                  </button>
                </div>
              </div>
            </motion.div>

            {/* CHECKOUT SECTION */}
            {checkoutVisible && (
              <motion.div id="pc-checkout-anchor"
                initial={{ opacity:0, y:32 }} animate={{ opacity:1, y:0 }} transition={{ duration:0.5 }}>
                <div className="pc-checkout-divider">
                  <div className="pc-checkout-divider-line" />
                  <span className="pc-checkout-divider-label">Complete Your Order</span>
                  <div className="pc-checkout-divider-line" />
                </div>

                <div className="pc-grid">
                  {/* LEFT */}
                  <div>
                    {/* Plan recap */}
                    {/* <div className="pc-card">
                      <div className="pc-card-header">
                        <span className="pc-step-badge">1</span>
                        <span className="pc-card-title">Selected Plan</span>
                      </div>
                      <div className="pc-plan-box">
                        <div>
                          <div className="pc-plan-name-chip"><Zap size={11} /> {lmsPlan.planName}</div>
                          <div className="pc-plan-users-row"><Users size={13} /> Includes {lmsPlan.includedUsers} users</div>
                          <div className="pc-plan-feats">
                            {lmsPlan.features.slice(0, 5).map(f => (
                              <div key={f.featureSlug} className="pc-plan-feat">
                                <span className="pc-plan-feat-check"><Check size={9} strokeWidth={3} color="#16a34a" /></span>
                                {f.uiLabel}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="pc-price-block">
                          <div className="pc-price-amount">₹{lmsPlan.pricePerUser.toLocaleString("en-IN")}</div>
                          <div className="pc-price-period">/user/month</div>
                        </div>
                      </div>
                    </div> */}

                    {/* Billing form */}
                    <div className="pc-card">
                      <div className="pc-card-header">
                        <span className="pc-step-badge">2</span>
                        <span className="pc-card-title">Billing Information</span>
                      </div>
                      <BillingForm
                        formData={formData}
                        onChange={handleChange}
                        onSubmit={handleSubmit}
                        submitting={submitting}
                      />
                    </div>

                    {/* Security badges */}
                    <div className="pc-security">
                      {[
                        { icon: <Lock size={13} />,      label: "SSL Secured" },
                        { icon: <ShieldCheck size={13} />, label: "256-bit Encryption" },
                        { icon: <BadgeCheck size={13} />,  label: "PCI Compliant" },
                      ].map(({ icon, label }) => (
                        <div key={label} className="pc-sec-item">{icon} {label}</div>
                      ))}
                    </div>
                  </div>

                  {/* RIGHT – Summary */}
                  <div>
                    <CheckoutSummary
                      plan={lmsPlan}
                      billingCycle={billingCycle}
                      onCycleChange={setBillingCycle}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default PricingAndCheckout;