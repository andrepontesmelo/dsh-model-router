# Security Policy

## Scope

dsh-model-router is a routing facade: it decides WHICH configured provider/model serves a
request. It does not hold credentials — provider keys live in the DSH profile, not here.

## Supported versions

Only the latest tag on `main` receives security fixes.

## Reporting a vulnerability

Email the owner via the contact on the GitHub profile (andrepontesmelo) rather than
opening a public issue. Include: affected version/commit, a route config that reproduces
the issue (redact anything private), and expected vs actual behavior. You will get an
acknowledgement within 7 days and a fix or a documented mitigation for anything
confirmed.

## What is NOT a vulnerability

- A route dispatching to a candidate you configured — routing to every listed candidate
  is the product's purpose. Audit unfamiliar route configs before installing them.
- `NO_CANDIDATE` errors, backoff windows, or provenance annotations surfaced in errors —
  those are the designed observability surface. Error text contains provider/model ids
  and timing, never credentials.
