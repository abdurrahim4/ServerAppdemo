# Delta Kebab latest MongoDB V2 server — Expo notifications (STAGING)

Changes: Expo push token registration/unregistration, bounded branch-indexed token storage, nonblocking notification dispatch after successful order creation, and atomic preparation-time acceptance endpoint.

Routes:
POST /api/v1/management/push-tokens {token,branchId}
DELETE /api/v1/management/push-tokens {branchId}
PATCH /api/v1/management/branches/:branchId/orders/:orderId/estimate {minutes:40}

Requires STORAGE_DRIVER=mongodb_v2, MongoDB Atlas, Node 20+, reachable HTTPS Expo push service and device Expo tokens from an EAS build. Server creates two indexes on order-push-tokens at startup. Push dispatch happens AFTER order creation and does not block checkout. Dispatch bounded at 200 tokens per branch, 5 concurrent dispatches, and 4-second external HTTP timeout per batch.

IMPORTANT: This is staging source, not a production-tested deployment. No live DB/API/device testing or load test has been completed. No durable queue, retry, or Expo push receipt processing yet. A powered-off phone cannot receive notifications until reconnecting. Do not replace production server until tested and backed up.

Original .env intentionally excluded; preserve existing secrets and production configuration. The Expo app must use a reachable server URL, not localhost on a phone.
