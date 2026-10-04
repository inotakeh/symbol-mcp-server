# Certificate fixtures

Two synthetic X.509 certificates for the `certificate` item of `symbol-mcp-server check`
(`src/cli/certificate.ts`). They were made for these tests only and belong to no node.

| File | Subject | notAfter (UTC) |
|---|---|---|
| `node-a.crt` | `CN=test-node-a` | 2099-12-31T23:59:59Z |
| `node-b.crt` | `CN=test-node-b` | 2098-12-31T23:59:59Z |

Both are PEM text, self-signed, with an Ed25519 key, valid from 2026-01-01T00:00:00Z. The tests
read the fingerprint from the files and expect the subject and the notAfter of the table above, so
regenerate them with exactly the commands below: only the key, and with it the fingerprint, then
changes.

## The rule

- **`.pem` and `.key` are for real keys and certificates only, and an agent never reads them.**
  The guard hook, the sandbox and `.gitignore` all treat those two extensions as secrets.
- **A synthetic test certificate is made without storing its key, and is committed as `.crt`.**
  The key goes to `/dev/null` while the certificate is made, so no key exists to leak.
- **Never use the certificate of a real node** (it holds the node's public key).
- Files that a test writes to a temporary directory follow the same rule: no `.pem` and no `.key`
  in their names. A test that needs a file with a private key makes the key at run time
  (`generateKeyPairSync`) and writes it to the temporary directory; no such file is committed.
- `test/unit/cli-certificate.test.ts` checks that no file in this directory, this README
  included, holds a PEM private key block (a `BEGIN … PRIVATE KEY` line), that the `.crt` files do
  not contain the words `PRIVATE KEY` at all, and that no file here is named `.pem` or `.key`.

## How they were made

OpenSSL 3.4 or newer (`-not_before` / `-not_after`; made with 3.6.4), from the repository root:

```
openssl req -x509 -newkey ed25519 -noenc -keyout /dev/null \
  -subj "/CN=test-node-a" -not_before 20260101000000Z -not_after 20991231235959Z \
  -out test/fixtures/cert/node-a.crt
openssl req -x509 -newkey ed25519 -noenc -keyout /dev/null \
  -subj "/CN=test-node-b" -not_before 20260101000000Z -not_after 20981231235959Z \
  -out test/fixtures/cert/node-b.crt
```

To look at one:

```
openssl x509 -in test/fixtures/cert/node-a.crt -noout -subject -enddate -fingerprint -sha256
```
