# lasso-fastapi

Release-backed FastAPI app service for Service Lasso.

This repo packages a FastAPI application service and its Python dependencies into a Service Lasso archive. The service exposes `API_URL` and `API_PORT`, starts through the `@python` provider, and verifies HTTP readiness on `/healthcheck`.

## Service Contract

- Service ID: `fastapi`
- Default port: `8000`
- Provider dependency: `@python`
- Health: HTTP `GET /healthcheck` expects `200`
- Runtime data: `${SERVICE_ROOT}/runtime/data`
- Runtime logs: `${SERVICE_ROOT}/runtime/logs`

## Release Assets

Protected pushes to `main` create a timestamped `yyyy.m.d-<shortsha>` GitHub release with:

- `lasso-fastapi-0.1.0-win32.zip`
- `service.json`
- `SHA256SUMS.txt`

Only Windows is published while the canonical `@python` provider is Windows-only. Linux/macOS FastAPI artifacts should be added after the Python provider has a supported portable runtime strategy for those platforms.

## Local Verification

```powershell
npm test
```

The verification packages the current platform, extracts the archive, starts FastAPI, waits for `/healthcheck`, and stops the process.
