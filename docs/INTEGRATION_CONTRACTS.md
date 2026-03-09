# Integration Contracts

This document defines the external systems Briefly needs before premium and cloud sync can be considered production-ready.

## Auth

### `POST /auth/google/start`

Starts OAuth for the extension client.

Response:

```json
{
  "authorizationUrl": "https://accounts.google.com/..."
}
```

### `POST /auth/google/complete`

Completes OAuth and returns the user session.

Request:

```json
{
  "code": "oauth-code",
  "redirectUri": "chrome-extension://..."
}
```

Response:

```json
{
  "user": {
    "id": "usr_123",
    "email": "user@example.com"
  },
  "session": {
    "accessToken": "token",
    "expiresAt": "2026-03-09T12:00:00.000Z"
  }
}
```

## Billing

### `POST /billing/checkout`

Creates a Stripe Checkout session for the signed-in user.

Request:

```json
{
  "userId": "usr_123",
  "priceId": "price_pro_monthly"
}
```

Response:

```json
{
  "checkoutUrl": "https://checkout.stripe.com/..."
}
```

### `GET /billing/entitlement`

Returns premium entitlement state for the current user.

Response:

```json
{
  "isPremium": true,
  "plan": "pro",
  "status": "active",
  "renewsAt": "2026-04-09T00:00:00.000Z"
}
```

## Cloud Sync

### `POST /sync/workspaces/push`

Pushes local workspace mutations.

Request:

```json
{
  "userId": "usr_123",
  "workspaces": []
}
```

### `GET /sync/workspaces/pull`

Pulls the latest remote workspaces for the user.

Response:

```json
{
  "workspaces": []
}
```

## Telemetry

### `POST /telemetry/events`

Accepts product analytics events from the extension until direct PostHog ingestion is wired.

Request:

```json
{
  "event": "summary_generated",
  "properties": {
    "provider": "gemini",
    "videoCount": 3
  },
  "timestamp": "2026-03-09T12:00:00.000Z"
}
```
