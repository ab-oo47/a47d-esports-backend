const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ================= FIREBASE INIT =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

// ================= ZAPUPI KEYS =================
const TOKEN_KEY = "4b63fb4ebfbb9671aa5f47d6e3a49c21";
const SECRET_KEY = "a062630e79e1682b3e305c895f9f503c";

// ================= SHADOWPAY =================
const SHADOWPAY_TOKEN = process.env.SHADOWPAY_TOKEN;

// =================================================
// HEALTH CHECK
// =================================================
app.get("/", (req, res) => {
  res.send("Backend Running (ZapUPI + ShadowPay)");
});

// =================================================
// CREATE PAYMENT (ZAPUPI)
// =================================================
app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({
        error: "Missing userId or amount",
      });
    }

    const orderId = "ORD" + Date.now();

    const response = await axios.post(
      "https://api.zapupi.com/api/create-order",
      new URLSearchParams({
        token_key: TOKEN_KEY,
        secret_key: SECRET_KEY,
        amount: Number(amount),
        order_id: orderId,
        custumer_mobile: mobile || "",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("ZapUPI Response:", response.data);

    if (response.data.status !== "success") {
      return res.status(400).json({
        error: response.data.message,
      });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      gateway: "zapupi",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      payment_url: response.data.payment_url,
      order_id: orderId,
    });
  } catch (error) {
    console.error(
      "ZapUPI Error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Payment creation failed",
    });
  }
});

// =================================================
// CREATE ORDER (SHADOWPAY)
// =================================================
app.post("/create-order-shadowpay", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({
        error: "Missing userId or amount",
      });
    }

    const orderId = "SP" + Date.now();

    const params = new URLSearchParams();
    params.append("customer_mobile", mobile || "");
    params.append("user_token", SHADOWPAY_TOKEN);
    params.append("amount", amount);
    params.append("order_id", orderId);
    params.append(
      "redirect_url",
      "https://yourapp.flutterflow.app/success"
    );

    const response = await axios.post(
      "https://www.pay.shadowlink.in/api/create-order",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("ShadowPay Response:", response.data);

    // Accept true or "true"
    if (
      response.data.status !== true &&
      response.data.status !== "true"
    ) {
      return res.status(400).json({
        error: response.data.message || "ShadowPay failed",
      });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      gateway: "shadowpay",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      payment_url: response.data.result.payment_url,
      order_id: orderId,
    });
  } catch (error) {
    console.error(
      "ShadowPay Error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "ShadowPay failed",
    });
  }
});

// =================================================
// VERIFY PAYMENT (ZAPUPI)
// =================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        error: "Missing orderId",
      });
    }

    const response = await axios.post(
      "https://api.zapupi.com/api/order-status",
      new URLSearchParams({
        token_key: TOKEN_KEY,
        secret_key: SECRET_KEY,
        order_id: orderId,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data.status !== "success") {
      return res.json({ status: "pending" });
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({
        error: "Payment not found",
      });
    }

    const paymentData = paymentSnap.data();

    if (paymentData.credited) {
      return res.json({ status: "already_credited" });
    }

    await db.collection("users").doc(paymentData.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(
        paymentData.amount
      ),
    });

    await paymentRef.update({
      credited: true,
    });

    return res.json({ status: "credited" });
  } catch (error) {
    console.error("ZapUPI Verify Error:", error.message);

    return res.status(500).json({
      error: "Verification failed",
    });
  }
});

// =================================================
// VERIFY PAYMENT (SHADOWPAY)
// =================================================
app.post("/verify-shadowpay", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        error: "Missing orderId",
      });
    }

    const params = new URLSearchParams();
    params.append("user_token", SHADOWPAY_TOKEN);
    params.append("order_id", orderId);

    const response = await axios.post(
      "https://www.pay.shadowlink.in/api/check-order-status",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const data = response.data;

    console.log("ShadowPay Verify:", data);

    // ✅ Correct status check
    if (data.status !== "COMPLETED") {
      return res.json({ status: "pending" });
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({
        error: "Payment not found",
      });
    }

    const paymentData = paymentSnap.data();

    if (paymentData.credited) {
      return res.json({ status: "already_credited" });
    }

    await db.collection("users").doc(paymentData.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(
        paymentData.amount
      ),
    });

    await paymentRef.update({
      credited: true,
    });

    return res.json({ status: "credited" });
  } catch (error) {
    console.error(
      "Shadow Verify Error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Verification failed",
    });
  }
});

// =================================================
// WEBHOOK (SHADOWPAY)
// =================================================
app.post("/shadow-webhook", async (req, res) => {
  try {
    console.log("Webhook:", req.body);

    const order_id = req.body.order_id;
    const status = req.body.status;

    if (!order_id || status !== "COMPLETED") {
      return res.send("Ignored");
    }

    const paymentRef = db.collection("payments").doc(order_id);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.send("No payment");
    }

    const paymentData = paymentSnap.data();

    if (paymentData.credited) {
      return res.send("Already credited");
    }

    await db.collection("users").doc(paymentData.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(
        paymentData.amount
      ),
    });

    await paymentRef.update({
      credited: true,
    });

    return res.send("Credited");
  } catch (err) {
    console.log("Webhook Error:", err.message);
    return res.status(500).send("Error");
  }
});

// =================================================
// START SERVER
// =================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});