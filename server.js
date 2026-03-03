const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   🔐 FIREBASE INITIALIZATION
================================ */

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

/* ================================
   💳 CREATE PAYMENT
================================ */

app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount || amount < 10) {
      return res.status(400).json({
        error: "Invalid data. Minimum ₹10 required.",
      });
    }

    const orderId = "WALLET_" + Date.now();

    // Save payment as pending
    await db.collection("payments").doc(orderId).set({
      userId,
      amount,
      status: "pending",
      createdAt: new Date(),
    });

    // Call Spacepay API
    const response = await axios.post(
      "https://spacepay.in/api/payment/v1/pay",
      {
        public_key: process.env.SPACEPAY_PUBLIC_KEY,
        secret_key: process.env.SPACEPAY_SECRET_KEY,
        customer_mobile: mobile,
        amount,
        order_id: orderId,
        redirect_url: "https://yourapp.com/payment-status",
        note: "Wallet Top-up",
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error("Payment error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Payment failed" });
  }
});

/* ================================
   🔔 SPACEPAY WEBHOOK
================================ */

app.post("/webhook", async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (!order_id) {
      return res.status(400).send("Invalid webhook");
    }

    if (status === "SUCCESS") {
      const paymentRef = db.collection("payments").doc(order_id);
      const paymentDoc = await paymentRef.get();

      if (paymentDoc.exists && paymentDoc.data().status !== "success") {
        const { userId, amount } = paymentDoc.data();

        // Add coins to user wallet
        await db.collection("users").doc(userId).update({
          wallet_balance: admin.firestore.FieldValue.increment(amount),
        });

        // Mark payment successful
        await paymentRef.update({
          status: "success",
          updatedAt: new Date(),
        });
      }
    }

    return res.send("OK");
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(500).send("Error");
  }
});

/* ================================
   🚀 START SERVER
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
