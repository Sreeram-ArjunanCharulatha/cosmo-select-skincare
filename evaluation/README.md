# Evaluation and fairness auditing

This directory is a **separate, offline auditing pipeline**. Nothing here runs
during a scan, and none of it is imported by the live analysis code in
`skin-analysis-api/`. Its only job is to answer one question on a dataset you
supply:

> Does this system behave differently for different skin-tone groups?

It cannot make the system fair. It can only measure whether a difference
exists, which is the necessary first step and is currently **unmeasured** for
this project.

## Files

| File                      | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `schema.json`             | JSON Schema for one evaluation record                            |
| `build_reference_set.py`  | Runs the real pipeline over a labelled dataset, emits records     |
| `metrics.py`              | Computes per-condition metrics, overall and per skin-tone group   |
| `example-results.json`    | **Synthetic** sample data showing the format and output           |

## The images in `images/concerns/` are NOT a reference set

Those four pictures are decorative UI assets. They are captioned stock
photos with no expert labels, they stage each condition (a photo captioned
"acne" may show a few lesions on one cheek, whereas real presentation is
usually spread across the face), and they contain no skin-tone diversity.

The scale anchors in `skin_metrics.py` and the thresholds in
`concern_mapper.py` were set by eyeballing them. **That is not calibration**,
and re-running the pipeline on the same pictures cannot validate it: it only
shows the algorithm agrees with a caption. Replacing those anchors with
values derived from labelled data is the point of this directory.

## Getting a real dataset

Do not scrape condition photos from a web image search. It reproduces the
exact problem it appears to solve: no dermatologist labels, no skin-tone
metadata, no consent from the people depicted, and unclear copyright on
medical images of identifiable faces.

Use a dataset published for research instead:

* **SCIN** (Google/Stanford) — 10,000+ images, dermatologist labels, plus
  self-reported and estimated Fitzpatrick and Monk Skin Tone labels,
  contributed with informed consent. Note the structural caveat: SCIN is
  close-ups of affected areas across all body sites, so only the subset that
  contains a front-facing face will pass this pipeline's face detection.
  <https://github.com/google-research-datasets/scin>
* **ACNE04** — ~1,450 facial photographs graded for acne severity by
  dermatologists with per-lesion boxes. Faces, so it suits this pipeline, but
  it covers acne only and its skin-tone distribution is not documented.
* **Fitzpatrick17k** — large, with Fitzpatrick annotations; note the published
  data-quality critiques before relying on it.

### Two honest caveats

1. **"Dehydration" is not a dermatological diagnosis.** It is a cosmetic
   marketing category, so no clinical dataset labels it. That signal cannot
   be validated against expert ground truth at all, which is why the
   interface always presents it as requiring user confirmation.
2. **Condition taxonomies will not line up.** Clinical labels are things like
   erythema, rosacea or xerosis; this project's four concerns are cosmetic
   groupings. Any mapping you write is itself a judgement that belongs in
   your write-up.

## Building records from a dataset

Write a CSV manifest, then run the pipeline over it:

```csv
image_path,ground_truth,skin_tone_group,skin_tone_scale,lighting_condition
images/0001.jpg,Acne,monk-3,monk-10,even-daylight
images/0002.jpg,Redness|Dryness,fitzpatrick-5,fitzpatrick-6,directional
images/0003.jpg,,monk-8,monk-10,low-light
```

```bash
cd ../skin-analysis-api && source .venv/bin/activate && cd ../evaluation
python3 build_reference_set.py manifest.csv --root /path/to/dataset --output results.json
python3 metrics.py results.json
```

`build_reference_set.py` also reports **why images were excluded, broken down
by skin-tone group**. If one group is dropped far more often (face detection
failing, quality gates rejecting under-exposed images), that is a fairness
finding in itself, before a single score is compared.

`example-results.json` contains randomly generated records with a deliberately
injected group difference, so you can see what a disparity looks like in the
report. It is not real data, not dermatologist-labelled, and is not a result.

## Running it

```bash
cd evaluation
python3 metrics.py example-results.json
python3 metrics.py your-results.json --min-samples 50
python3 metrics.py your-results.json --json > report.json
```

No third-party packages are required.

## What it reports

Per condition (Acne, Redness, Dryness, Dehydration), overall and per group:

* sample count
* accuracy
* sensitivity (recall)
* specificity
* precision
* false-positive rate
* false-negative rate
* confusion matrix (TP / FP / TN / FN)

Any metric with a zero denominator is reported as `n/a`, never as 0% or 100%,
so an unmeasurable value is never mistaken for a good one.

## Reading the output responsibly

* **Any group below `--min-samples` is flagged and must not be quoted.** Small
  groups produce dramatic-looking rates that are pure noise. The default
  minimum is 30, which is a floor for a rough signal, not a target.
* **High overall accuracy can hide a serious disparity.** Always read the
  per-group table. A system can score 90% overall while failing badly for the
  smallest group.
* **Look hardest at the false-positive rate.** For this application, wrongly
  telling somebody they have acne or redness is the harm that matters most,
  and it is exactly the failure mode that fixed colour thresholds produce for
  deeper skin.
* **A single run proves nothing about a different dataset**, camera, or
  lighting setup.

## Where the data must come from

You need a dataset that is dermatologist-labelled and skin-tone-diverse. This
project does not ship one, and building one properly is a research task in its
own right.

`skin_tone_group` must be a label **supplied by the dataset**. Do not infer it
from the image inside this project, do not treat an estimated tone as ground
truth about a person, and do not feed it back into the live decision
thresholds. It exists here solely to stratify reported metrics.

## In-app user feedback

The scan interface lets a user mark each suggested condition as "this looks
correct", "I don't have this" or "not sure". Those responses are kept in that
browser's own localStorage under `cosmo-scan-feedback-v1`, alongside the
confidence score, lighting score, capture-quality codes, image source,
timestamp and algorithm version. No image, identity or demographic data is
recorded, and nothing is transmitted anywhere.

There is no export button in the interface: the records exist so the user's
disagreement is registered rather than discarded, not as a data-collection
feature. They also carry **no ground-truth labels and no skin-tone groups**,
so they are not a validation set and cannot substitute for one. A genuine
evaluation needs the dermatologist-labelled dataset described above.
