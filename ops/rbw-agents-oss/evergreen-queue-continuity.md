# Evergreen queue continuity — approved 4 October 2026

A live schedule does not prove that qualified outbound work is available.
The queue report distinguishes new qualified contacts, potential due followups,
later followups, held historical work, research pending and low-water refill.
Zero qualified supply stays visible; repeated mail never fills a counter.

The approved standalone queue policy preserves the campaign scope and quotas.
The reserve target is three business days of the approved eventual allocation:
30 press, 36 SME, 24 ETI. Free registry refill is reserved before each request,
at most once per hour and eight attempts/day/lane. Successful proof retains its
seven-day lifetime; failed qualification and failed domain discovery retry after
24 hours. Company discovery is lane-specific. Search terms originate in freshly
fetched public registry data, not unverified labels from the internal queue.
Website contact/team links expand primary discovery without guessed addresses.

The human requested old-contact followups. Only previously sent media-authority
contacts with an existing candidate enter the historical audit (two/maintenance).
Operator holds, HDF quarantine and suppression remain unchanged. The original
Gmail message must exist, be SENT, have the exact sole recipient and Thibault
sender, a known subject/body/Message-ID, and at least ten completed business days.
Any reply or later touch holds the sequence. Historical negative replies cause
global suppression without becoming adverse metrics for a new cohort.

Fresh primary qualification is still required. Before one permitted followup,
the original Gmail effect hash is checked again and relationship searches run
again in both directions across Gmail threads, including later manual outbound. The original sender, subject and thread are retained. No original touch
is synthesized, no fake maturation reward is created, and no legacy initial is
replayed. The resulting real followup has the existing durable reservation,
single POST and exact SENT checks. Ambiguous effects reconcile without resend.
A held original does not starve other work. Read failures and not-yet-due
originals retry after bounded backoff; replies and operator holds do not.

Both additive schemas are snapshotted before creation. Native deployment applies
dependencies/code first, queue policy last, with archived atomic replacements and
no infrastructure or worker restart. DEV fixtures test quotas, failed/valid proof
retry, public-origin searches, history integrity, original-thread dispatch,
concurrent replies, historical optout and lost-response reconciliation.

No finite contact database, bounded sequence or external provider can guarantee
a positive ready-to-send count forever. Continuous refill/qualification work is
the operational invariant; dispatch still waits for verified eligibility.
