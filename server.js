const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
const qs = require("querystring");

const app = express();
app.use(cors());
app.use(express.json());

/* =====================================
   🔐 FIREBASE INITIALIZATION
===================================== */

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

/* =====================================
   💳 CREATE PAYMENT (ZapUPI)
===================================== */

app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount || amount < 10) {
      return res.status(400).json({
        error: "Invalid data. Minimum ₹10 required.",
      });
    }

    const orderId = "ORD_" + Date.now();

    // Save payment as pending
    await db.collection("payments").doc(orderId).set({
      userId,
      amount,
      status: "pending",
      createdAt: new Date(),
    });

    // Call ZapUPI Create Order
    const response = await axios.post(
      "https://api.zapupi.com/api/create-order",
      qs.stringify({
        token_key: process.env.ZAP_TOKEN_KEY,
        secret_key: process.env.ZAP_SECRET_KEY,
        amount: amount,
        order_id: orderId,
        custumer_mobile: mobile,
        redirect_url:
          "https://a47d-esports-backend.onrender.com/zap-return",
        remark: "Wallet Topup",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data.status !== "success") {
      return res.status(400).json({
        error: response.data.message || "Failed to create order",
      });
    }

    return res.json({
      payment_url: response.data.payment_url,
      order_id: orderId,
    });

  } catch (error) {
    console.error("Create Payment Error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Payment creation failed" });
  }
});

/* =====================================
   🔎 VERIFY PAYMENT
===================================== */

app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID required" });
    }

    const response = await axios.post(
      "https://api.zapupi.com/api/order-status",
      qs.stringify({
        token_key: process.env.ZAP_TOKEN_KEY,
        secret_key: process.env.ZAP_SECRET_KEY,
        order_id: orderId,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const zapStatus = response.data.status;

    if (zapStatus === "success") {
      const paymentRef = db.collection("payments").doc(orderId);
      const paymentDoc = await paymentRef.get();

      if (paymentDoc.exists && paymentDoc.data().status !== "success") {
        const { userId, amount } = paymentDoc.data();

        await db.collection("users").doc(userId).update({
          wallet_balance: admin.firestore.FieldValue.increment(amount),
        });

        await paymentRef.update({
          status: "success",
          updatedAt: new Date(),
        });
      }

      return res.json({ status: "credited" });
    }

    return res.json({ status: "pending" });

  } catch (error) {
    console.error("Verify Error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/* =====================================
   🔁 REDIRECT BACK TO APP
===================================== */

app.get("/zap-return", (req, res) => {
  res.redirect("a47d://a47d.com/payment-success");
});

/* =====================================
   🚀 START SERVER
===================================== */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});