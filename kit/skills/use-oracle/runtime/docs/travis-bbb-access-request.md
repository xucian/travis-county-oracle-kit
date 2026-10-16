# Travis County BBB access request (draft, not submitted)

Status: **drafted 2026-10-16, not submitted.** Submission is an operator action through
`https://developer.bbb.org/` (the official BBB API access request). Nothing in this file has
been sent anywhere, and no request to any `bbb.org` host has been made from this machine.

Why a request is required (per `bbb-harvest`): bbb.org returned a bot challenge and HTTP 403
to scripted access when probed on 2026-10-16 from outside the US. The kit does not accept a
non-US probe as evidence, so the single bounded probe is re-run only from the approved AWS
US-egress runtime (`operator_machine: false`); a 403 there stops every remaining BBB
request. Until the API grants access, Travis coverage carries
`source_access_status: blocked`, `source_access_complete: false`,
`incomplete_reason: http_403_source_block`, and every contractor ships with
`bbb: {rating: null, status: "blocked"}`.

## Request text

Subject: `API access request - contractor reputation data for Travis County, Texas roofing lead research`

```text
Organization: <operator organization>            Contact: <operator name, email>
Use case: Read-only enrichment of public building-permit records for Travis County,
Texas (Austin BBB service area, "Austin and Central Texas") with the current BBB
rating and accreditation status of the contractor named on the permit, for a
property-intelligence pipeline that identifies aged roofs and open roofing
permits. Ratings are displayed beside the permit's printed contractor name; they
are never used to establish the contractor's legal identity.

Categories requested: roofing contractors, solar energy contractors, heating and
air conditioning contractors, general contractors, located in or serving Travis
County, Texas (Austin, Pflugerville, Round Rock, Cedar Park, Leander, Lakeway,
Bee Cave, Manor, Lago Vista, Jonestown, Elgin and the smaller villages).

Fields requested: business name, BBB business id, accreditation status, rating,
rating date, address, phone, license numbers on file, profile URL.

Volume: one-time load of the matching Austin-area profiles (expected low
thousands), then a monthly refresh. Expected request rate under 1 request per
second with backoff on any 429 or 5xx response.

Egress: requests originate from an AWS region in the United States (us-east-1 or
us-east-2); none originate from personal machines, proxies or browser automation.

Attribution and terms: we will display the BBB rating with attribution and a link
to the BBB profile, store only the fields listed above, honor any retention or
display terms attached to the grant, and stop immediately on request.

Prior access: a single scripted probe on 2026-10-16 received HTTP 403 with a bot
challenge; we stopped and are requesting approved access instead of changing
egress, fingerprints or challenge behavior.
```

## Record in the run manifest once submitted

```yaml
bbb_access_request:
  submitted_at: <ISO timestamp>
  submitted_by: <operator>
  recipient: https://developer.bbb.org/
  scope: Austin and Central Texas; roofing, solar, HVAC and general contractors
  reference: <ticket or confirmation id>
  status: pending
```
