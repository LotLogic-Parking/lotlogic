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

## Plate Recognizer's candidates

Every PR read carries a `candidates` list: the other strings it considered, with scores. On the misread frames of one car at Mayfield the right plate was in that list 10 times out of 15. When the plate being compared is one of the read's candidates, the distance is capped at 0.3 ("PR candidate"), which passes every threshold. The digit guard still applies, so two confident reads disagreeing on a digit stay two plates even when PR offered the other digit. Candidates flow through the session lookup, twin and like joins, late exit, the cron exit sweep, and registration matching.

## Read quality (`read_quality.ts`, apartments)

The photos behind Mayfield's stray tiles (2026-11-14): a decorative front plate on a car driving out past the entry camera; lettering on a van read once at night; real plates cut off by the frame edge, read as five characters at full confidence; a distant car and a trailer with no plate in view. Over 14 days, 1,598 agreed reads against 42 lone unrepeated reads: PR's detection score is below 0.5 on 31% of the lone reads and 4% of the agreed ones; eight or more candidates on 60% against 8%; five characters on 21% against 1%.

| Grade | When | Effect |
|---|---|---|
| reject | dscore < 0.5, box wider than 3.2× its height, or under 20 px tall | logged as not a plate, never matched |
| tentative | cut by the frame edge, a format not seen at our properties, 8+ candidates, or score under 0.80 | may join an open visit; opens a new one only with a second agreeing read on the same camera within two minutes (a cut plate needs a longer read) |
| solid | none of the above | opens a visit on its own |

Known formats are the shapes seen 20 or more times at full confidence: AAA9999, 99999A, AA9999, AAA999, AA99AA, 9AA999. A vanity plate in another shape still opens after two agreeing frames of the same burst. `READ_QUALITY_CONFIG` (JSON) overrides any number.

**Orientation.** With the PR make-model-colour add-on enabled (`PR_MMC_ENABLED`), each read says whether it saw the Front or Rear of the car. At an apartment gate a front plate faces the camera: at the entry camera it is a car driving out, so the read is treated as an exit; at the exit camera it is the car at the keypad on its way in, so it closes nothing. Without the add-on this rule is inert.

## Approach (`approach.ts`, apartments)

A plate getting closer to the entry camera is a car driving out. Over 14 days, in all 34 bursts of a car that certainly entered (the exit camera later read it leaving) the plate box shrank and moved up the frame by 32 to 217 px; in the one burst of a car certainly leaving past the entry camera it grew 18 px and moved down 230 px. The rule: the box top moved down by more than 40 px, or grew by more than 8 px while moving down, compared with an earlier frame of the same car on the same camera within 60 s. A read that fires is treated as an exit, and it closes the visit its own first frame opened seconds before (the parking buffer does not apply). Single-frame bursts get no verdict.

## Test cases

`plate_identity.test.ts` holds the production pairs: 23 one-car pairs from Mayfield bursts, 4 two-car bursts, 5 different-vehicle pairs across days, 4 same-car pairs across hours, and the Charlotte false close. The formula must keep all of them on the right side.

## What this does not fix

A car the exit camera never photographs cannot be closed by any formula. Camera D at Mayfield posts in short bursts and sleeps between them; that is a camera setting.
