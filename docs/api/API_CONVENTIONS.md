# API conventions

- REST + JSON under `/api/v1`; OpenAPI 3 generated from the NestJS code.
- Users: `Authorization: Bearer <JWT>` (short-lived) + rotating refresh token. Apps/partners: `X-API-Key` with scoped permissions.
- Every endpoint checks permission (`module.resource.action`) **and** data scope (own / team / department / branch / all) on the server.
- Pagination: cursor based — `?limit=50&cursor=...`. Filtering: `?filter[stage]=won`. Sorting: `?sort=-createdAt`.
- `Idempotency-Key` header required on creates that move money or send messages.
- Errors: `{ "code": "LEAD_NOT_FOUND", "message": "...", "details": {}, "traceId": "..." }`.
- Money in paise (integer). Timestamps ISO-8601 UTC.
- Outgoing webhooks signed with HMAC-SHA256 (`X-UBOS-Signature`), retried with exponential backoff.

The endpoint catalogue is in section 21 of the blueprint PDF.
