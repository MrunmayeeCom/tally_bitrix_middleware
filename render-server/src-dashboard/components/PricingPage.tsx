import React, { useState, useEffect, useCallback } from "react";
import { User, BillingCycle, LMSPlan } from "../types";
import { fetchPlansForProduct } from "../api/lms";
import { createOrder, verifyPayment } from "../api/payment";
import { linkLicense } from "../api/middleware";

const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID;
const APP_BASE_URL    = import.meta.env.VITE_APP_BASE_URL;

const CYCLES = [
  { key: "quarterly"   as BillingCycle, label: "Quarterly",   months: 3  },
  { key: "half-yearly" as BillingCycle, label: "Half-Yearly", months: 6  },
  { key: "yearly"      as BillingCycle, label: "Yearly",      months: 12 },
];

const BILLING_PERIOD_LABEL: Record<BillingCycle, string> = {
  quarterly: "3 months", "half-yearly": "6 months", yearly: "12 months",
};

interface Props {
  clientId: string;
  user: User | null;
  onPurchased: () => void;
}

interface Toast { id: number; message: string; type: "success" | "error"; }

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, type: "success" | "error") => {
    const id = Date.now();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);
  const remove = (id: number) => setToasts(p => p.filter(t => t.id !== id));
  return { toasts, show, remove };
}

export default function PricingPage({ clientId, user, onPurchased }: Props) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("quarterly");
  const [plan, setPlan]                 = useState<LMSPlan | null>(null);
  const [loading, setLoading]           = useState(true);
  const [submitting, setSubmitting]     = useState(false);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [formData, setFormData] = useState({
    companyName: "", phone: "", address: "", city: "", state: "", pincode: "", gstNumber: "",
  });
  const { toasts, show: showToast, remove: removeToast } = useToast();

  useEffect(() => {
    fetchPlansForProduct()
      .then(setPlan)
      .catch(() => showToast("Failed to load plan. Please refresh.", "error"))
      .finally(() => setLoading(false));
  }, []);

  const calcPrices = (p: LMSPlan, cycle: BillingCycle) => {
    const disc        = p.discountConfig[cycle] ?? 0;
    const months      = CYCLES.find(c => c.key === cycle)!.months;
    const baseTotal   = p.pricePerUser * months;
    const discountAmt = Math.round((baseTotal * disc) / 100);
    const subtotal    = baseTotal - discountAmt;
    const gst         = Math.round(subtotal * 0.18 * 100) / 100;
    const total       = Math.round((subtotal + gst) * 100) / 100;
    const originalWithGst = Math.round(baseTotal * 1.18 * 100) / 100;
    return { disc, discountAmt, subtotal, gst, total, originalWithGst };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plan || !user) return;
    setSubmitting(true);
    try {
      // Load Razorpay SDK
      await new Promise<void>((resolve, reject) => {
        if ((window as any).Razorpay) { resolve(); return; }
        const s = document.createElement("script");
        s.src = "https://checkout.razorpay.com/v1/checkout.js";
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Razorpay load failed"));
        document.body.appendChild(s);
      });

      const { total } = calcPrices(plan, billingCycle);

      // Create order via LMS
      const orderData = await createOrder({
        userId:      user._id,
        licenseId:   plan.licenseId,
        billingCycle,
        amount:      Math.round(total * 100) / 100,
      });

      const options = {
        key:         RAZORPAY_KEY_ID,
        amount:      orderData.amount * 100,
        currency:    orderData.currency || "INR",
        name:        "TallyBitrixSync",
        description: `${plan.planName} — ${billingCycle}`,
        order_id:    orderData.orderId,
        prefill:     { name: formData.companyName, email: user.email, contact: formData.phone },
        notes:       {
          address:      `${formData.address}, ${formData.city}, ${formData.state} - ${formData.pincode}`,
          gstNumber:    formData.gstNumber,
          billingCycle,
        },
        theme: { color: "#0d7a8a" },
        handler: async (response: any) => {
          try {
            // Verify payment via LMS
            const verifyData = await verifyPayment({
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
              userId:              user._id,
              licenseId:           plan.licenseId,
              billingCycle,
              amount:              Math.round(total * 100) / 100,
            });

            // Link license to Bitrix portal
            await linkLicense({
              clientId,
              customerEmail: user.email,
              licenseId:     verifyData.licenseId || plan.licenseId,
              licensePlan:   plan.planName,
              licenseStatus: "active",
            });

            showToast("🎉 Payment successful! License activated.", "success");
            setTimeout(() => onPurchased(), 2000);
          } catch(err: any) {
            showToast(err?.message || "Payment verification failed.", "error");
          } finally { setSubmitting(false); }
        },
        modal: { ondismiss: () => { showToast("Payment cancelled.", "error"); setSubmitting(false); } },
      };

      new (window as any).Razorpay(options).open();
    } catch(err: any) {
      showToast(err?.message || "Something went wrong.", "error");
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',sans-serif" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ width:36, height:36, border:"3px solid #e2e8f0", borderTopColor:"#0d7a8a", borderRadius:"50%", animation:"spin 0.75s linear infinite", margin:"0 auto 12px" }} />
        <p style={{ color:"#94a3b8", fontSize:13 }}>Loading plan…</p>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );

  if (!plan) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',sans-serif" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:40, marginBottom:14 }}>⚠️</div>
        <p style={{ fontSize:16, fontWeight:700 }}>Could not load plan</p>
        <button onClick={() => window.location.reload()} style={{ marginTop:16, padding:"11px 28px", borderRadius:11, border:"none", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:14, fontWeight:600, cursor:"pointer" }}>
          Retry
        </button>
      </div>
    </div>
  );

  const { disc, discountAmt, subtotal, gst, total, originalWithGst } = calcPrices(plan, billingCycle);

  const s: Record<string, React.CSSProperties> = {
    page:      { minHeight:"100vh", background:"#f8fafc", fontFamily:"'Inter',sans-serif", color:"#0f172a" },
    topbar:    { background:"white", borderBottom:"1px solid #e8ecf0", padding:"0 24px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:30 },
    content:   { maxWidth:960, margin:"0 auto", padding:"32px 20px 80px" },
    hero:      { textAlign:"center", marginBottom:32 },
    cycleWrap: { display:"flex", justifyContent:"center", marginBottom:32 },
    cycleGrid: { display:"inline-grid", gridTemplateColumns:"repeat(3,1fr)", gap:6, background:"white", border:"1px solid #e8ecf0", borderRadius:14, padding:5, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" },
    planCard:  { maxWidth:500, margin:"0 auto 40px", background:"white", border:"2px solid #99e6f0", borderRadius:20, overflow:"hidden", boxShadow:"0 8px 32px rgba(13,122,138,0.1)" },
    planTop:   { background:"linear-gradient(135deg,#f0fdfc,#e6f4f8)", padding:"28px 28px 20px", display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:16 },
    checkout:  { display:"grid", gridTemplateColumns:"1fr 340px", gap:20, alignItems:"start" },
    card:      { background:"white", border:"1px solid #e8ecf0", borderRadius:16, padding:24, marginBottom:16 },
    input:     { width:"100%", height:42, padding:"0 12px", border:"1.5px solid #e8ecf0", borderRadius:9, fontSize:13, fontFamily:"'Inter',sans-serif", color:"#0f172a", background:"#fafbfc", outline:"none", boxSizing:"border-box" as any },
    label:     { fontSize:11, fontWeight:600, textTransform:"uppercase" as any, letterSpacing:"0.06em", color:"#94a3b8", display:"block", marginBottom:5 },
    summCard:  { background:"white", border:"1px solid #e5e7eb", borderRadius:14, overflow:"hidden", position:"sticky" as any, top:72 },
  };

  return (
    <div style={s.page}>
      {/* Toasts */}
      <div style={{ position:"fixed", top:16, right:16, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
        {toasts.map(t => (
          <div key={t.id} style={{ display:"flex", gap:10, background:"white", border:"1px solid #e5e7eb", borderLeft:`3px solid ${t.type==="success"?"#4ade80":"#f87171"}`, borderRadius:12, padding:"12px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.1)", minWidth:260, fontSize:13 }}>
            <span>{t.type==="success"?"✓":"✕"}</span>
            <span style={{ flex:1 }}>{t.message}</span>
            <button onClick={()=>removeToast(t.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#94a3b8" }}>×</button>
          </div>
        ))}
      </div>

      {/* Topbar */}
      <div style={s.topbar}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>⚡</div>
          <span style={{ fontWeight:700, fontSize:14 }}>TallyBitrixSync — Pricing</span>
        </div>
        {user && <span style={{ fontSize:12, color:"#64748b" }}>👤 {user.email}</span>}
      </div>

      <div style={s.content}>
        {/* Hero */}
        <div style={s.hero}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"#f0fdf4", border:"1px solid #bbf7d0", color:"#15803d", fontSize:11, fontWeight:600, padding:"4px 12px", borderRadius:100, marginBottom:12 }}>
            ✓ One-time setup · Instant access
          </div>
          <h1 style={{ fontSize:"clamp(1.6rem,3vw,2.2rem)", fontWeight:800, margin:"0 0 8px", letterSpacing:"-0.04em" }}>Choose Your Plan</h1>
          <p style={{ color:"#64748b", fontSize:14, margin:0 }}>Select a billing cycle and get started instantly</p>
        </div>

        {/* Billing cycle */}
        <div style={s.cycleWrap}>
          <div style={s.cycleGrid}>
            {CYCLES.map(c => {
              const d = plan.discountConfig[c.key] ?? 0;
              const active = billingCycle === c.key;
              return (
                <button key={c.key} onClick={() => setBillingCycle(c.key)} style={{
                  padding:"10px 16px", borderRadius:9, border:`1.5px solid ${active?"transparent":"#e8ecf0"}`,
                  background: active ? "linear-gradient(135deg,#0d7a8a,#0a3d5c)" : "#fafbfc",
                  color: active ? "white" : "#64748b", fontWeight:600, fontSize:12,
                  cursor:"pointer", fontFamily:"'Inter',sans-serif", display:"flex", alignItems:"center", gap:6,
                  boxShadow: active ? "0 4px 12px rgba(13,122,138,0.25)" : "none",
                  transition:"all 0.15s",
                }}>
                  {c.label}
                  {d > 0 && <span style={{ fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:100, background: active ? "rgba(255,255,255,0.2)" : "#d1fae5", color: active ? "white" : "#065f46" }}>-{d}%</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Plan card */}
        <div style={s.planCard}>
          <div style={{ height:4, background:"linear-gradient(90deg,#0d7a8a,#0a3d5c)" }} />
          <div style={s.planTop}>
            <div>
              <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:12, fontWeight:700, padding:"5px 14px", borderRadius:100, marginBottom:10, boxShadow:"0 2px 8px rgba(13,122,138,0.3)" }}>
                ⚡ {plan.planName}
              </div>
              <div style={{ fontSize:13, color:"#0d7a8a", fontWeight:500 }}>👥 Includes {plan.includedUsers} users</div>
            </div>
            <div style={{ textAlign:"right", flexShrink:0 }}>
              {disc > 0 && <div style={{ fontSize:13, color:"#94a3b8", textDecoration:"line-through", marginBottom:2 }}>₹{originalWithGst.toLocaleString("en-IN")}</div>}
              <div style={{ fontSize:"2.4rem", fontWeight:800, color:"#0d7a8a", letterSpacing:"-0.05em", lineHeight:1 }}>₹{total.toLocaleString("en-IN")}</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>/{BILLING_PERIOD_LABEL[billingCycle]} · incl. GST</div>
              {disc > 0 && <div style={{ display:"inline-block", background:"#d1fae5", color:"#065f46", fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:100, marginTop:6 }}>Save {disc}%</div>}
            </div>
          </div>
          {plan.features.length > 0 && (
            <div style={{ padding:"18px 28px 22px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {plan.features.slice(0,6).map(f => (
                <div key={f.featureSlug} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#374151", fontWeight:500 }}>
                  <span style={{ width:16, height:16, borderRadius:"50%", background:"#dcfce7", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:9, color:"#16a34a", fontWeight:800 }}>✓</span>
                  {f.uiLabel}
                </div>
              ))}
            </div>
          )}
          <div style={{ padding:"0 28px 24px" }}>
            <button onClick={() => { setCheckoutVisible(true); setTimeout(() => document.getElementById("checkout-anchor")?.scrollIntoView({ behavior:"smooth" }), 50); }}
              style={{ width:"100%", height:48, borderRadius:12, border:"none", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"'Inter',sans-serif", boxShadow:"0 4px 14px rgba(13,122,138,0.28)", transition:"all 0.15s" }}>
              💳 Get Started
            </button>
          </div>
        </div>

        {/* Checkout */}
        {checkoutVisible && (
          <div id="checkout-anchor">
            <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:28 }}>
              <div style={{ flex:1, height:1, background:"#e8ecf0" }} />
              <span style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.1em", color:"#94a3b8" }}>Complete Your Order</span>
              <div style={{ flex:1, height:1, background:"#e8ecf0" }} />
            </div>
            <div style={s.checkout}>
              {/* Left - form */}
              <div>
                <div style={s.card}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20 }}>
                    <div style={{ width:22, height:22, borderRadius:"50%", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:11, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center" }}>2</div>
                    <span style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.07em", color:"#94a3b8" }}>Billing Information</span>
                  </div>
                  <form onSubmit={handleSubmit}>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
                      {[
                        { label:"Company Name", key:"companyName", full:true, placeholder:"Acme Pvt Ltd" },
                        { label:"Email", key:"email", full:false, placeholder:user?.email||"", readonly:true },
                        { label:"Phone", key:"phone", full:false, placeholder:"+91 98765 43210" },
                        { label:"Address", key:"address", full:true, placeholder:"Street address" },
                        { label:"City", key:"city", full:false, placeholder:"City" },
                        { label:"State", key:"state", full:false, placeholder:"State" },
                        { label:"Pincode", key:"pincode", full:false, placeholder:"400001" },
                        { label:"GST Number (Optional)", key:"gstNumber", full:false, placeholder:"22AAAAA0000A1Z5" },
                      ].map(f => (
                        <div key={f.key} style={{ gridColumn: f.full ? "1 / -1" : undefined }}>
                          <label style={s.label}>{f.label}</label>
                          <input
                            style={{ ...s.input, ...(f.readonly ? { background:"#f1f5f9", color:"#94a3b8", cursor:"not-allowed" } : {}) }}
                            placeholder={f.placeholder}
                            value={f.key === "email" ? (user?.email || "") : (formData as any)[f.key]}
                            readOnly={f.readonly}
                            required={!f.key.includes("gst") && !f.readonly}
                            onChange={f.readonly ? undefined : e => setFormData(p => ({ ...p, [f.key]: e.target.value }))}
                          />
                        </div>
                      ))}
                      <div style={{ gridColumn:"1 / -1", display:"flex", justifyContent:"flex-end", marginTop:4 }}>
                        <button type="submit" disabled={submitting} style={{ display:"inline-flex", alignItems:"center", gap:8, padding:"0 28px", height:46, borderRadius:11, border:"none", background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", color:"white", fontSize:14, fontWeight:600, cursor:submitting?"not-allowed":"pointer", opacity:submitting?0.6:1, fontFamily:"'Inter',sans-serif", boxShadow:"0 4px 12px rgba(13,122,138,0.25)" }}>
                          💳 {submitting ? "Processing…" : "Proceed to Payment"}
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
                <div style={{ display:"flex", justifyContent:"center", gap:24, flexWrap:"wrap" }}>
                  {["🔒 SSL Secured","🛡 256-bit Encryption","✅ PCI Compliant"].map(t => (
                    <span key={t} style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>{t}</span>
                  ))}
                </div>
              </div>

              {/* Right - summary */}
              <div style={s.summCard}>
                <div style={{ background:"linear-gradient(135deg,#0d7a8a,#0a3d5c)", padding:"18px 20px", color:"white" }}>
                  <p style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:"rgba(255,255,255,0.6)", margin:"0 0 8px" }}>ORDER SUMMARY</p>
                  <div style={{ display:"inline-block", background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.25)", borderRadius:20, padding:"3px 12px", fontSize:13, fontWeight:600, marginBottom:8 }}>{plan.planName}</div>
                  <div style={{ fontSize:13, color:"rgba(255,255,255,0.8)" }}>👥 {plan.includedUsers} users included</div>
                </div>
                <div style={{ padding:"16px 20px" }}>
                  {[
                    { label:"Plan price", value:`₹${plan.pricePerUser.toLocaleString("en-IN")}` },
                    { label:"Billing period", value: BILLING_PERIOD_LABEL[billingCycle], bold:true },
                  ].map(r => (
                    <div key={r.label} style={{ display:"flex", justifyContent:"space-between", marginBottom:8, fontSize:13 }}>
                      <span style={{ color:"#6b7280" }}>{r.label}</span>
                      <span style={{ fontWeight: r.bold ? 600 : 500 }}>{r.value}</span>
                    </div>
                  ))}
                  {disc > 0 && (
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8, fontSize:13 }}>
                      <span style={{ color:"#0d7a8a" }}>Discount ({disc}%)</span>
                      <span style={{ color:"#0d7a8a", fontWeight:600 }}>-₹{discountAmt.toLocaleString("en-IN")}</span>
                    </div>
                  )}
                </div>
                <div style={{ height:1, background:"#f3f4f6", margin:"0 20px" }} />
                <div style={{ padding:"12px 20px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8, fontSize:13 }}>
                    <span style={{ color:"#6b7280" }}>Subtotal</span>
                    <span>₹{subtotal.toLocaleString("en-IN")}</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13 }}>
                    <span style={{ color:"#6b7280" }}>GST (18%)</span>
                    <span>₹{gst.toLocaleString("en-IN")}</span>
                  </div>
                </div>
                <div style={{ margin:"0 16px 16px", background:"#0f172a", borderRadius:10, padding:"14px 18px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ color:"white", fontWeight:600, fontSize:14 }}>Total</span>
                  <span style={{ color:"white", fontWeight:700, fontSize:18 }}>₹{total.toLocaleString("en-IN")}</span>
                </div>
                <div style={{ padding:"0 20px 16px", display:"flex", flexDirection:"column", gap:6 }}>
                  {["Secure payment","Money-back guarantee","Cancel anytime"].map(t => (
                    <div key={t} style={{ fontSize:12, color:"#6b7280", display:"flex", alignItems:"center", gap:6 }}>🔒 {t}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}