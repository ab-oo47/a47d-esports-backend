const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// ================= IMB =================
const IMB_API_TOKEN = process.env.IMB_API_TOKEN;

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// =================================================
// CREATE ORDER
// =================================================
app.post("/create-order-imb", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    const orderId = "IMB" + Date.now();

    const response = await axios.post(
      "https://secure-stage.imb.org.in/api/create-order",
      new URLSearchParams({
        customer_mobile: mobile,
        user_token: IMB_API_TOKEN,
        amount: Number(amount),
        order_id: orderId,
        redirect_url: "",
        remark1: userId,
        remark2: "coins",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const paymentUrl =
      response.data.payment_url ||
      response.data?.result?.payment_url;

    if (!paymentUrl) {
      return res.status(400).json({ error: "Payment failed" });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
    });

    res.json({
      payment_url: paymentUrl,
      order_id: orderId,
    });

  } catch (err) {
    res.status(500).json({ error: "Create order failed" });
  }
});

// =================================================
// 🔥 COMMON CREDIT FUNCTION (REUSABLE)
// =================================================
const creditCoinsIfNeeded = async (orderId) => {
  const ref = db.collection("payments").doc(orderId);
  const snap = await ref.get();

  if (!snap.exists) return "no_payment";

  const payment = snap.data();

  // ✅ ALREADY CREDITED → STOP
  if (payment.credited) return "already";

  // 🔍 CHECK STATUS FROM IMB
  const response = await axios.post(
    "https://secure-stage.imb.org.in/api/check-order-status",
    new URLSearchParams({
      user_token: IMB_API_TOKEN,
      order_id: orderId,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const status =
    response.data.status ||
    response.data?.result?.txnStatus ||
    response.data?.result?.status;

  // ❌ NOT SUCCESS → STOP
  if (status !== "SUCCESS" && status !== "COMPLETED") {
    return "pending";
  }

  // ✅ CREDIT COINS
  await db.collection("users").doc(payment.userId).update({
    wallet_balance: admin.firestore.FieldValue.increment(payment.amount),
  });

  await ref.update({ credited: true });

  return "credited";
};

// =================================================
// VERIFY (MANUAL BACKUP)
// =================================================
app.post("/verify-imb", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const result = await creditCoinsIfNeeded(orderId);

    res.json({ status: result });

  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK (AUTO CREDIT)
// =================================================
app.post("/imb-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", req.body);

    const orderId =
      req.body.order_id ||
      req.body.orderId ||
      req.body?.result?.orderId;

    if (!orderId) return res.send("No order");

    const result = await creditCoinsIfNeeded(orderId);

    console.log("WEBHOOK RESULT:", result);

    res.send("OK");

  } catch (err) {
    console.log("WEBHOOK ERROR:", err.message);
    res.status(500).send("Error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running 🚀");
});