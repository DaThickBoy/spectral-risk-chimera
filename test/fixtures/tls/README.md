# Test-only TLS certificate and private key

**These are not production credentials.** They protect nothing and must never be used outside the local test suite.

| File | Contents |
|---|---|
| `untrusted-localhost.cert.pem` | Self-signed certificate. Subject and issuer: `CN=localhost (spectral-risk-chimera test only)`. Subject alternative names: `localhost` and `127.0.0.1`. Not a CA certificate. |
| `untrusted-localhost.key.pem` | The matching private key, published on purpose so that the tests can start a local HTTPS or `wss://` server. |

## Why they are committed

The tests check that TLS certificate verification is always on (AT-SEC-23). To do that, they start a server on `127.0.0.1` with this certificate and confirm two things:

- a client rejects it by default, because no system trusts it;
- a client accepts it only when a test explicitly adds it as a trusted certificate inside that test.

## Where they are used

They are used only by these tests:

- `test/integration/tls.test.ts`
- `test/integration/secTransport.test.ts`
- `test/integration/sentimentWs.test.ts`
- `test/soak/sentiment.soak.test.ts`

- **Not used by the application.** Nothing under `src/` reads them. `test/integration/tls.test.ts` fails if any source file refers to them.
- **Secret scanning.** `.gitleaks.toml` allowlists the key's exact path only, so the secret scan still covers every other file.

## Rules

- Never use this key or certificate for a real server, a deployment, or any non-local connection.
- Never add this certificate to a system or browser trust store.
- Anyone can read the key in this public repository. Treat it as compromised by design.
- To replace the pair, generate a new self-signed localhost certificate and key and replace both files together. Keep the file names, and update this README.
