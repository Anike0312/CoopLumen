# SEP-12 KYC Requirements

This document records the requirements for integrating CoopLumen with a
Stellar Ecosystem Proposal 12 (SEP-12) KYC service. It is based on the
canonical SEP-12 specification, version 1.15.0, and the related SEP-1,
SEP-9, SEP-10, and SEP-45 specifications linked in [References](#references).

SEP-12 defines the protocol between a wallet or application and an anchor's
customer information service. It does not define which checks a jurisdiction
requires, replace legal review, or make a provider responsible for CoopLumen's
privacy and retention obligations.

## Roles and discovery

- **Client:** CoopLumen, acting for an authenticated member.
- **Server:** the anchor or KYC provider that implements SEP-12.
- **Discovery:** read `KYC_SERVER` from the provider's `stellar.toml`. SEP-12
  permits falling back to `TRANSFER_SERVER` when `KYC_SERVER` is absent.
- **Authentication:** every SEP-12 request must carry a bearer token issued by
  either SEP-10 or SEP-45. A CoopLumen application session is not, by itself, a
  SEP-10 or SEP-45 token.

The provider's `SIGNING_KEY`, also published in `stellar.toml`, is used to
verify signed callback requests.

## Protocol endpoints

Paths below are relative to the discovered KYC server URL.

| Method   | Path                  | Purpose                                                                               |
| -------- | --------------------- | ------------------------------------------------------------------------------------- |
| `GET`    | `/customer`           | Read the customer's current status and any required or previously provided fields.    |
| `PUT`    | `/customer`           | Create or update a customer and submit text, numeric, date, or binary KYC fields.     |
| `PUT`    | `/customer/callback`  | Register a URL where the provider can notify the client that customer status changed. |
| `DELETE` | `/customer/{account}` | Request deletion of customer data when supported and legally permitted.               |
| `POST`   | `/customer/files`     | Upload a file separately when the provider supports the optional file API.            |
| `GET`    | `/customer/files`     | Retrieve a previously uploaded file when the provider supports the optional file API. |

`PUT /customer/verification` is deprecated and must not be used for a new
integration. Providers that accept binary data directly on `PUT /customer`
use `multipart/form-data`; otherwise requests use JSON. Clients should enforce
the provider's advertised file rules and treat 10 MB as the default maximum
when no smaller limit is published.

## Customer identity and type

The provider infers the Stellar account from the authenticated SEP-10 or
SEP-45 token subject. A SEP-10 subject can also carry a memo for a shared
account, while a SEP-45 subject can identify a contract account. Explicit
`account` request parameters are retained only for backward compatibility and
must match the authenticated subject. After the server returns a customer
`id`, CoopLumen should persist the opaque identifier as `provider_reference`
and prefer it on subsequent calls.

The optional `type` parameter selects a provider-defined customer profile and
can change required fields and verification policy. CoopLumen must use a
configured allowlist of provider types rather than accepting arbitrary values
from a browser. `type` is required when a SEP-12 request is associated with a
`transaction_id`.

## Fields and files

Providers return a `fields` object when more information is needed. Field names
should use SEP-9 names where SEP-9 defines them, for example `first_name`,
`last_name`, `birth_date`, `address`, and `photo_id_front`. SEP-12 field types
are `string`, `binary`, `number`, and `date`.

The API layer must not hard-code a universal identity form. It should render or
map the provider's requested fields, submit only those fields, and preserve the
provider's descriptions and choices. Sensitive documents must not be placed in
`kyc_records.metadata`, logs, analytics, URLs, or client-side persistence.
Store provider references and status locally; let the provider retain document
content unless a documented product requirement says otherwise.

## Status mapping

SEP-12 and CoopLumen use different status vocabularies. The integration should
apply this mapping consistently:

| SEP-12 status | Meaning                                      | CoopLumen `kyc_records.status` | Public API status |
| ------------- | -------------------------------------------- | ------------------------------ | ----------------- |
| no customer   | The provider has no customer record yet.     | no row                         | `none`            |
| `NEEDS_INFO`  | Additional or corrected fields are required. | `pending`                      | `pending`         |
| `PROCESSING`  | The provider is reviewing submitted data.    | `submitted`                    | `pending`         |
| `ACCEPTED`    | Verification succeeded.                      | `verified`                     | `approved`        |
| `REJECTED`    | Verification failed or cannot proceed.       | `rejected`                     | `rejected`        |

`expired` is a CoopLumen lifecycle state for a verification that must be
renewed; it is not a SEP-12 status. A `NEEDS_INFO` response must include the
required `fields`. A `REJECTED` response must include a user-safe message.
Provider messages may contain sensitive detail and must be filtered before
being exposed or logged.

## Initiation and polling flow

1. Authenticate the member and require the submitted address to match the
   authenticated Stellar address.
2. Confirm that the address is an active member of the selected community.
3. Create or reuse the community-address `kyc_records` row. Repeated initiation
   while a request is pending must be idempotent.
4. Discover and allowlist the provider URL, obtain a SEP-10 or SEP-45 token,
   and call `GET /customer` with the configured customer type.
5. Return the fields required by the provider, without returning provider
   credentials or raw internal errors.
6. Submit member-supplied fields with `PUT /customer`, then persist the returned
   customer ID and mapped status.
7. Poll `GET /customer` while processing, or register a signed callback URL.
8. Record status transitions and timestamps in an audit trail without copying
   identity documents into the application database.

Provider calls need strict timeouts, bounded retries with jitter, and stable
idempotency behavior. A provider timeout must not be interpreted as a rejection.

## Callback verification

SEP-12 callbacks include a `Signature` header containing a timestamp and a
base64 signature. Verify the signature with the provider's `SIGNING_KEY` over
the exact SEP-12 signing payload, using the unmodified request body and the
registered wallet host. Reject malformed signatures, timestamps outside a
short freshness window (the specification recommends one to two minutes), and
replayed payloads before changing a KYC record.

Callback URLs must be HTTPS in production. Provider base URLs and callback
destinations must be configuration-controlled to prevent server-side request
forgery. Status updates should be monotonic where possible and duplicate
callbacks must be harmless.

## Privacy and operational requirements

- Encrypt transport and sensitive stored values, and restrict database access
  to the minimum services and operators that need it.
- Redact bearer tokens, personal fields, provider responses, and uploaded files
  from logs and error monitoring.
- Define retention and deletion rules with legal counsel. Use the SEP-12 delete
  operation when appropriate, but do not promise deletion where law requires
  retention.
- Record consent, provider, customer reference, status transitions, and the
  policy version used for each verification.
- Rate-limit initiation, submission, polling, and callback endpoints.
- Keep provider credentials in secret storage and rotate them independently of
  CoopLumen session keys.
- Expose errors through the standard `{ data, meta?, error? }` envelope and use
  user-safe messages; keep diagnostic details server-side.

## Current CoopLumen implementation

Migration `017_create_kyc_records.sql` defines one record per community and
Stellar address, provider references, local statuses, timestamps, and optional
metadata. This is storage groundwork only. The current authentication flow
issues a CoopLumen HMAC session after a wallet challenge; it has not been
verified as a complete SEP-10 or SEP-45 implementation.

The repository does not yet provide provider discovery, SEP-10/SEP-45 token
exchange, dynamic field submission, file handling, signed callbacks, provider
polling, or customer deletion. Those capabilities must be completed and tested
against the selected provider before the application claims SEP-12 support.

## References

- [SEP-12: KYC API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)
- [SEP-1: `stellar.toml`](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)
- [SEP-9: Standard KYC fields](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md)
- [SEP-10: Web authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [SEP-45: Web authentication for contract accounts](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md)
