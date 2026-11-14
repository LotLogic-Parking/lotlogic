# Plate identity: one formula for "same vehicle"

Gabe, 2026-11-14: "there needs to be something that catches the similarity of the plates and accounts for plate recognizer reading a plate slightly wrong at one point or another, cant be having a misread being counted as another car" and "read all of our plate recognizer and charlotte travel plaza to determine how to eliminate this misread problem and develop a formula for it".

## What existed

A code map (2026-11-14) found 47 places that decide whether two plate strings are one vehicle, with at least twelve different rules: `plateSimilar` in two modes, `exitFuzzyMatch`, `twinSimilar`, `likeSimilar`, `plateMatchesPartial`, `lev1`, `similarPlate`, a SQL `plate_confusable_match`, and more. The main ingest matcher switched to a stricter "anchored" mode once a visit had three reads at 0.9 or better, which then refused any read of a different length. That is what split `TAK983` from `AK983`. The confusion table was a hand-written list of letter-for-digit lookalikes (O/0, I/1, S/5).

## What the data says

14 days of reads at Mayfield (1,573 reads, two SC211 cameras, Plate Recognizer cloud) and Charlotte (422 reads, onboard Milesight plus Plate Recognizer).

| Finding | Number |
|---|---|
| Gate passes (bursts of reads within 60 s on one camera) where PR returned more than one plate string | 74 of 205 at Mayfield |
| Top-confidence reads (0.95+) that were six characters, mostly a seven-character plate with an edge character missing | 403 of 1,220 |
| Reads at 0.90–0.95 that agreed with the other frames of their burst | 50% |
| Reads at 0.95+ that agreed with the other frames of their burst | 86% |
| Commonest substitutions inside a burst | 8/0 (14), 4/9 (10), 8/9 (8), M/L, 3/8, 2/4, H/N (6 each), 5/6, C/M, 0/4, 6/3 (5 each) |
| Pairs of distinct well-read plates inside one two-minute window, one or two edits apart | 12, every one the same car |
| Pairs of distinct well-read plates inside one two-minute window, three edits apart | 0 |
| Pairs of distinct well-read plates inside one two-minute window, four or more edits apart | 16, every one two cars |
| Distinct well-read plates across the 14 days that are one edit apart | 6 pairs, mostly a fleet of vans with sequential plates (69664W, 69665W, 69610W, 69614W …), all genuinely different vehicles |

So: inside a gate pass, string distance separates one car from two cleanly. Across hours it does not, because real plates one digit apart exist. Score is a weak truth signal on its own. Edge truncation at full confidence is the single biggest error.

## The formula (`supabase/functions/camera-snapshot/plate_identity.ts`)

**Distance.** A weighted edit distance between two normalized plates:

| Edit | Cost |
|---|---|
| Substitution of a measured confusable pair | 0.5 |
| Any other substitution | 1.0 |
| A character dropped or added at either end (truncation), up to three | 0.3 each |
| An interior insertion or deletion | 1.0 |

The confusable set is the old lookalike table plus every pair seen three or more times inside one burst in the measurement window (listed in the module).

**Verdict.** The threshold depends on what is being compared.

| Comparison | Same vehicle when | Why |
|---|---|---|
| `burst`: two reads of one gate pass (within 120 s on the same gate) | cost ≤ 2.0 | the clean gap in the window data |
| `visit`: a read against an open visit's plate, any age | cost ≤ 0.6, and not two reads at 0.95+ that disagree only on digits | one lookalike or a two-character truncation; fleet neighbours stay apart |
| `registered`: a read against a plate a person typed (pass, resident, tow list) | cost ≤ 1.0, both at least six characters | one plain edit or two lookalikes; the Charlotte false close MBD8497 → WBD3427 scores 2.0 |

**Consensus plate.** A visit carries the plate its reads agree on, not the first read: cluster the reads around the best-scoring one (burst distance), then take the string with the most reads at 0.9+, never a truncation of a longer string in the cluster. A visit is "confirmed" once two reads at 0.9+ agree on the string.

**Knobs.** `PLATE_IDENTITY_CONFIG` (Supabase secret, JSON) overrides any number: `burstSeconds`, `burstMax`, `visitMax`, `registeredMax`, `registeredMinLen`, `confusableCost`, `edgeCost`, `maxEdgeDrop`, `digitGuardScore`.

## Where it is applied

| Place | Before | Now |
|---|---|---|
| `findSimilarOpenSession` fuzzy stage (every entry, exit and paired read) | anchored/unanchored `plateSimilar`, latest visit wins | `burst`; the closest visit wins |
| PR lock (same camera, 180 s) | anchored | `burst` |
| Camera pairing at an apartment gate (10 s) | anchored | `burst` |
| Best-frame attach, recently-closed lookup | anchored | `burst` |
| Twin join and post-open twin merge (`apartment_entry.ts`) | `plateSimilar` or Levenshtein ≤2 | `burst` |
| Like join, any age (`apartment_entry.ts`) | unanchored `plateSimilar` | `visit` with the digit guard |
| Visit plate rewrite | higher score or longer | consensus of all the visit's reads |
| Late exit match and burst-noise guard (`apartment_close.ts`, cron `exit_sweep.ts`) | unanchored | `visit` / `burst` |
| Registration match on entry (`matchPairedRow`) | exact, anchored, partial | exact, `registered`, partial |
| Boot stand-down registration match | anchored | `registered` |
| Truck plaza exit close (`exitFuzzyMatch`) | ≤1 true edit and ≤2 total diffs, same length | `registered` |
| Truck plaza weak-read flush pass match | anchored, no length floor | `registered` (adds the six-character floor) |
| No-registration pass window | anchored if ≥6 | `registered` |

Not changed: exact lookups for cooldown and holds, the dHash image match, the backend SQL `plate_confusable_match`, the frontend grouping, and `cron-plate-pair-learn`. Those are display or audit paths, or compare typed values with typed values.

## Test cases

`plate_identity.test.ts` holds the production pairs: 23 one-car pairs from Mayfield bursts, 4 two-car bursts, 5 different-vehicle pairs across days, 4 same-car pairs across hours, and the Charlotte false close. The formula must keep all of them on the right side.

## What this does not fix

A car the exit camera never photographs cannot be closed by any formula. Camera D at Mayfield posts in short bursts and sleeps between them; that is a camera setting.
