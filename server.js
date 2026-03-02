const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔐 Firebase initialization will be added after service account

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!amount || amount < 10) {
      return res.status(400).json({ error: "Minimum ₹10 required" });
    }

    const orderId = "WALLET_" + Date.now();

    await db.collection("payments").doc(orderId).set({
      userId,
      amount,
      status: "pending",
      createdAt: new Date(),
    });

    const response = await axios.post(
      "https://spacepay.in/api/payment/v1/pay",
      {
        public_key: "YOUR_PUBLIC_KEY",
        secret_key: "YOUR_SECRET_KEY",
        customer_mobile: mobile,
        amount,
        order_id: orderId,
        redirect_url: "https://yourapp.com/payment-status",
        note: "Wallet Top-up",
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Payment failed" });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (status === "SUCCESS") {
      const paymentRef = db.collection("payments").doc(order_id);
      const paymentDoc = await paymentRef.get();

      if (paymentDoc.exists && paymentDoc.data().status !== "success") {
        const { userId, amount } = paymentDoc.data();

        await db.collection("users").doc(userId).update({
          wallet_balance: admin.firestore.FieldValue.increment(amount),
        });

        await paymentRef.update({ status: "success" });
      }
    }

    res.send("OK");
  } catch (err) {
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
