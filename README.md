# HomeFix Backend

Backend API for **HomeFix**, a home service booking platform that connects customers with technicians. This service manages authentication sessions, technician profiles, service listings, bookings, notifications, payments, and administrative operations.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Stripe](https://img.shields.io/badge/Stripe-Payments-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/license/isc-license-txt)

## Live Repositories

- [HomeFix Client](https://github.com/mehrabislam00/HomeFix)
- [HomeFix Backend](https://github.com/mehrabislam00/HomeFix-Backend)

## Related Projects

Use the client repository with this backend to run the complete application. The client provides the customer, technician, and admin interfaces and exchanges authentication sessions with the API.

## Features

- Better Auth cookie session verification
- Short-lived JWT access tokens
- Role-based authorization for customers, technicians, and admins
- Customer and technician profile management
- Technician service creation and approval workflow
- Public service discovery by category or service ID
- Booking creation, status updates, cancellation, and history
- Role-specific notifications and unread notification counts
- Admin dashboard, user management, reports, and moderation
- Stripe Checkout, payment verification, and webhook processing
- MongoDB transaction support for verified payment records
- CORS-enabled REST API
- Vercel deployment support

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **Database:** MongoDB / MongoDB Atlas
- **Authentication:** Better Auth sessions and JOSE JWT
- **Payments:** Stripe Checkout and Stripe Webhooks
- **Security:** HMAC session signatures and timing-safe signature verification
- **Deployment:** Vercel

## Project Structure

```text
HomeFix-Backend/
├── index.js         # API server, routes, authentication, database, and payments
├── .env.example     # Required environment variable template
├── vercel.json      # Vercel serverless deployment configuration
├── package.json
└── package-lock.json
```

## Requirements

- Node.js 20 or newer
- npm
- MongoDB Atlas or a MongoDB instance
- Better Auth configured in the client application
- A Stripe account for payment features

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/mehrabislam00/HomeFix-Backend.git
cd HomeFix-Backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
PORT=5000
MONGODB_USERNAME=your_mongodb_username
MONGODB_PASSWORD=your_mongodb_password

BETTER_AUTH_SECRET=your_shared_better_auth_secret
JWT_SECRET=your_random_jwt_secret
HOMEFIX_PAYMENT_API_SECRET=your_shared_payment_api_secret

STRIPE_SECRET_KEY=sk_test_or_live_key
STRIPE_WEBHOOK_SECRET=whsec_webhook_secret
```

Copy `.env.example` as a starting point:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. Start the server

```bash
npm run dev
```

The API is available at:

```text
http://localhost:5000
```

## Environment Variables

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port. Defaults to `5000`. |
| `MONGODB_USERNAME` | MongoDB Atlas database username. |
| `MONGODB_PASSWORD` | MongoDB Atlas database password. |
| `BETTER_AUTH_SECRET` | Secret shared with the Better Auth client server. Used to verify signed session cookies. |
| `JWT_SECRET` | Random secret of at least 32 characters used to sign API access tokens. |
| `HOMEFIX_PAYMENT_API_SECRET` | Shared secret used for protected notification API requests. |
| `STRIPE_SECRET_KEY` | Stripe secret key for the account and mode used by the application. |
| `STRIPE_WEBHOOK_SECRET` | Stripe endpoint signing secret. |

## Authentication

The API uses a two-part authentication flow:

1. The client authenticates through Better Auth and sends the session cookie.
2. The client calls `POST /auth/token` to exchange the valid session cookie for a 15-minute JWT access token.
3. Protected requests include the token:

```http
Authorization: Bearer <access_token>
```

Use `POST /auth/refresh` to issue a new access token from an active Better Auth session. Call `POST /auth/logout` to revoke the current session.

## API Overview

### Authentication

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/auth/token` | Exchange a Better Auth session cookie for a JWT |
| `POST` | `/auth/refresh` | Refresh an access token |
| `POST` | `/auth/logout` | Revoke the current session |

### Users and Profiles

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/customers` | List customers |
| `GET` | `/customers/:id` | Get a customer |
| `PATCH` | `/customers/:id` | Update a customer profile |
| `GET` | `/technicians` | List technicians |
| `GET` | `/technicians/:id` | Get a technician |
| `PATCH` | `/technicians/:id` | Update a technician profile |
| `GET` | `/users` | List users |
| `GET` | `/users/:id` | Get a user |
| `PATCH` | `/users/:id` | Update a user |

### Services

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/services` | List approved, publicly visible services |
| `GET` | `/services/category/:category` | List approved services by category |
| `GET` | `/services/:id` | Get service details |
| `GET` | `/technicians/:id/services` | List a technician's services |
| `POST` | `/technicians/:id/services` | Submit a new service |
| `PATCH` | `/services/:id` | Update a service |
| `DELETE` | `/services/:id` | Remove a service |

### Bookings

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/bookings` | Create a booking |
| `GET` | `/customers/:id/bookings` | List customer bookings |
| `GET` | `/technicians/:id/bookings` | List technician bookings |
| `GET` | `/customers/:id/bookings/:bookingId` | Get a customer booking |
| `GET` | `/technicians/:id/bookings/:bookingId` | Get a technician booking |
| `PATCH` | `/bookings/:id/cancel` | Cancel an eligible booking |
| `PATCH` | `/bookings/:id` | Update a booking |

### Notifications

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/notifications/:role/:userId` | Get notifications |
| `GET` | `/notifications/:role/:userId/unread-count` | Get unread notification count |
| `PATCH` | `/notifications/:role/:userId/read-all` | Mark all notifications as read |
| `PATCH` | `/notifications/:role/:userId/:notificationId/read` | Mark a notification as read |
| `DELETE` | `/notifications/:role/:userId/:notificationId` | Delete a notification |

### Admin

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/admin/:adminId/dashboard` | Get dashboard statistics |
| `GET` | `/admin/:adminId/users` | List all users |
| `GET` | `/admin/:adminId/users/:userId` | Get user details |
| `PATCH` | `/admin/:adminId/users/:userId` | Update a user |
| `PATCH` | `/admin/:adminId/users/:userId/ban` | Ban or unban a user |
| `DELETE` | `/admin/:adminId/users/:userId` | Delete a user |
| `GET` | `/admin/:adminId/customers` | List customers |
| `GET` | `/admin/:adminId/technicians` | List technicians |
| `GET` | `/admin/:adminId/services/pending` | List pending services |
| `GET` | `/admin/:adminId/services` | List all services |
| `PATCH` | `/admin/:adminId/services/:serviceId/approval` | Approve or reject a service |
| `GET` | `/admin/:adminId/bookings` | List all bookings |
| `PATCH` | `/admin/:adminId/bookings/:bookingId` | Update a booking |
| `GET` | `/admin/:adminId/reports` | Get report data |

### Payments

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/payments/checkout/:sessionId/confirm` | Confirm a customer Stripe Checkout session |
| `POST` | `/webhooks/stripe` | Receive and verify Stripe webhook events |
| `GET` | `/customers/:id/payments/stats` | Get customer payment statistics |
| `GET` | `/customers/:id/payments` | List customer payments |
| `GET` | `/technicians/:id/payments/stats` | Get technician payment statistics |
| `GET` | `/technicians/:id/payments` | List technician payments |
| `GET` | `/admin/:adminId/payments/stats` | Get admin payment statistics |
| `GET` | `/admin/:adminId/payments` | List all payments |

## Stripe Webhook Setup

Configure a Stripe webhook endpoint that points to:

```text
https://your-api-domain.com/webhooks/stripe
```

For local development, use the Stripe CLI:

```bash
stripe listen --forward-to localhost:5000/webhooks/stripe
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by the CLI or shown in the Stripe Dashboard.

## Deployment

The repository includes `vercel.json` for Vercel serverless deployment.

1. Import the backend repository into Vercel.
2. Add all required environment variables in **Project Settings > Environment Variables**.
3. Deploy the project.
4. Configure the Stripe webhook URL using the deployed API domain.
5. Connect the client application to the deployed API URL.

The MongoDB Atlas network access rules must allow the deployment environment to connect.

## Health Check

```http
GET /
```

Response:

```text
Hello World!
```

## Security Notes

- Never commit `.env` or real credentials.
- Use different secrets for JWT, Better Auth, and notification requests.
- Use at least 32 characters for `JWT_SECRET`.
- Keep Stripe webhook verification enabled in production.
- Restrict MongoDB database access using least-privilege credentials and network rules.
- Replace the fixed MongoDB Atlas connection configuration with environment-based configuration before distributing a fork.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the server with Node.js watch mode |
| `npm test` | No automated test script is configured yet |

## Contributing

1. Fork the repository.
2. Create a feature branch:

```bash
git checkout -b feature/your-feature-name
```

3. Make your changes.
4. Commit and push the branch.
5. Open a pull request.

## License

This project is licensed under the [ISC License](https://opensource.org/license/isc-license-txt).
