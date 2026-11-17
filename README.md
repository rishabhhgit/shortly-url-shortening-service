# Shortly — Full-Stack URL Shortener with Analytics & Payments

A responsive, production-ready URL shortening web application featuring custom short aliases, real-time click analytics, QR code generation, and Razorpay payment checkout integration.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com/)
[![Razorpay](https://img.shields.io/badge/Razorpay-Payment%20Gateway-blue.svg)](https://razorpay.com/)

---

## About Shortly

Shortly transforms long, unwieldy URLs into clean, memorable links while providing deep telemetry on click volumes, referrers, and user engagement. It also includes an optional monetization tier powered by Razorpay Checkout for premium features like branded vanity URLs and password-protected links.

### Features

- **Instant URL Shortening**: Generates compact, collision-resistant 6-character nanoids or base62 short slugs.
- **Custom Vanity Aliases**: Users can claim custom URLs (e.g. `short.ly/my-portfolio`).
- **Real-Time Click Analytics**: Tracks total visits, timestamps, browser user-agents, and referrer sources.
- **QR Code Generation**: Instantly renders downloadable QR codes for offline and mobile sharing.
- **Payment Gateway Integration**: Secure server-side Razorpay order creation with cryptographic HMAC SHA-256 signature verification.
- **Responsive UI**: Clean, mobile-friendly interface designed with vanilla JavaScript and modern CSS.

---

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: In-memory / MongoDB persistence
- **Payments**: Razorpay Node.js SDK
- **Security**: Cryptographic HMAC signature verification, helmet security headers
- **Frontend**: Semantic HTML5, CSS3 Flexbox/Grid, Vanilla JS

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/shorten` | Shorten a URL (accepts optional custom alias) |
| `GET` | `/:code` | Redirects to the original destination URL |
| `GET` | `/api/analytics/:code` | Retrieve click statistics & referrer telemetry |
| `POST` | `/api/create-order` | Initialize server-side Razorpay payment order |
| `POST` | `/api/verify-payment` | Verify checkout signature via HMAC SHA-256 |

---

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm or pnpm

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/rishabhhgit/shortly-url-shortening-service.git
   cd shortly-url-shortening-service
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment**:
   ```bash
   export RAZORPAY_KEY_ID="rzp_test_your_key_id"
   export RAZORPAY_KEY_SECRET="your_secret_key"
   export PORT=3000
   ```

4. **Run the server**:
   ```bash
   npm start
   ```
   Open `http://localhost:3000` in your browser.

5. **Run test suite**:
   ```bash
   npm test
   ```

---

## Security

Payment verification uses cryptographic HMAC SHA-256 signatures:
Secrets are strictly confined to the Express server environment and are never exposed to the client.

---

## License

MIT License.
