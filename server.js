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
const IMB_BASE_URL = "https://secure.imb.org.in/api"; // ✅ LIVE

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// =================================================
// CREATE ORDER (FIXED URL ISSUE)
// =================================================
app.post("/create-order-imb", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    const orderId = "IMB" + Date.now();

    const response = await axios.post(
      `${IMB_BASE_URL}/create-order`,
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

    console.log("IMB FULL RESPONSE:", response.data);

    // ✅ HANDLE ALL POSSIBLE URL TYPES
    const paymentUrl =
      response.data.payment_url ||
      response.data?.result?.payment_url ||
      response.data?.result?.payment_link ||
      response.data?.result?.upi_link;

    if (!paymentUrl) {
      return res.status(400).json({
        error: "No payment URL",
        raw: response.data,
      });
    }

    // SAVE PAYMENT
    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      status: "PENDING",
      createdAt: new Date(),
    });

    res.json({
      payment_url: paymentUrl,
      order_id: orderId,
    });

  } catch (err) {
    console.error("CREATE ORDER ERROR:", err.message);
    res.status(500).json({ error: "Create order failed" });
  }
});

// =================================================
// VERIFY (BACKUP ONLY)
// =================================================
const verifyIMBPayment = async (orderId) => {
  try {
    const response = await axios.post(
      `${IMB_BASE_URL}/check-order-status`,
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

    const apiStatus = response.data.status;
    const txnStatus = response.data?.result?.txnStatus;

    return {
      success:
        apiStatus === "SUCCESS" ||
        txnStatus === "COMPLETED" ||
        txnStatus === "SUCCESS",
    };
  } catch (err) {
    console.error("VERIFY ERROR:", err.message);
    return { success: false };
  }
};

// =================================================
// CREDIT (SAFE)
// =================================================
const creditCoins = async (orderId) => {
  const ref = db.collection("payments").doc(orderId);
  const snap = await ref.get();

  if (!snap.exists) return "no_payment";

  const payment = snap.data();

  // prevent double credit
  if (payment.credited) return "already";

  await db.collection("users").doc(payment.userId).update({
    wallet_balance: admin.firestore.FieldValue.increment(payment.amount),
  });

  await ref.update({
    credited: true,
    status: "SUCCESS",
    updatedAt: new Date(),
  });

  console.log("✅ COINS CREDITED:", orderId);

  return "credited";
};

// =================================================
// CHECK STATUS (APP)
// =================================================
app.get("/check-payment-status", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const verify = await verifyIMBPayment(orderId);

    if (!verify.success) {
      return res.json({ status: "pending" });
    }

    const result = await creditCoins(orderId);

    res.json({ status: result });

  } catch (err) {
    console.error("CHECK ERROR:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// =================================================
// VERIFY API (MANUAL)
// =================================================
app.post("/verify-imb", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const verify = await verifyIMBPayment(orderId);

    if (!verify.success) {
      return res.json({ status: "pending" });
    }

    const result = await creditCoins(orderId);

    res.json({ status: result });

  } catch (err) {
    console.error("VERIFY ERROR:", err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK (FINAL SOURCE OF TRUTH)
// =================================================
app.post("/imb-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", req.body);

    const orderId =
      req.body.order_id ||
      req.body.orderId ||
      req.body?.result?.orderId;

    const status = req.body.status;
    const txnStatus = req.body?.result?.txnStatus;

    if (!orderId) {
      return res.status(200).send("No orderId");
    }

    // ✅ DIRECT CREDIT (NO VERIFY DELAY)
    if (
      status === "SUCCESS" ||
      txnStatus === "COMPLETED" ||
      txnStatus === "SUCCESS"
    ) {
      const result = await creditCoins(orderId);

      console.log("WEBHOOK CREDIT RESULT:", result);

      return res.status(200).send("OK");
    }

    return res.status(200).send("Ignored");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    return res.status(200).send("Error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running 🚀 on port", PORT);
});