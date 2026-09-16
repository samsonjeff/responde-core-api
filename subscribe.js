require("dotenv").config();
const axios = require("axios");

axios
    .post(
        "https://graph.facebook.com/v21.0/me/subscribed_apps",
        { subscribed_fields: ["messages"] },
        { params: { access_token: process.env.PAGE_ACCESS_TOKEN } }
    )
    .then((res) => console.log("Subscribed:", res.data))
    .catch((err) => console.error("Error:", err.response?.data || err.message));