# Shortly

A responsive URL shortener with click analytics, custom aliases, and Razorpay Checkout.

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## Configure payments

Create test API keys in the Razorpay dashboard, then start the app with the credentials in the environment:

```bash
RAZORPAY_KEY_ID=rzp_test_your_key \
RAZORPAY_KEY_SECRET=your_secret \
npm start
```

Use Razorpay test credentials while developing. The secret is read only by the Express server and is never sent to the browser. Orders are created server-side and successful checkouts are verified with an HMAC signature before being accepted.

## Test

```bash
npm test
```
