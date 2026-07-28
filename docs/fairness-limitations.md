# Fairness limitations

This document states plainly what the COSMO SELECT visual screening prototype
does about skin-tone bias, what it does not do, and what would be required to
make a fairness claim. It is written to be read by an examiner, a reviewer, or
a user who wants to know whether to trust a result.

## The short version

The system is **not** unbiased, **not** clinically validated, **not**
dermatologist-approved, **not** medically accurate, and **not** demonstrated to
be equally accurate across skin tones. No such claim is made anywhere in the
project, and none should be made on its behalf.

One specific and well-known source of bias has been designed out. That is a
narrow, structural improvement. It is not fairness.

## What was changed, and why

### The problem with absolute thresholds

The obvious way to detect "redness" is to test whether a skin pixel's colour
exceeds a fixed value. That value has to come from somewhere, and in practice
it comes from whatever faces the developer had to hand. Deeper skin sits
outside ranges derived from lighter skin, so normal melanin gets read as an
abnormal signal. The result is a system that tells darker-skinned users they
have conditions they do not have.

This project reproduced exactly that failure in an earlier version, where
thresholds had been tuned against a handful of light-skinned stock
photographs.

### The relative-baseline design

Every colour and texture signal is now measured **against the same user's own
face**:

* **Redness** finds clusters of pixels that are warmer than the skin around
  them, region by region across forehead, both cheeks, nose and chin, using
  LAB a* and red-minus-green together. The detection threshold and the
  baseline both come from that region's own skin, so baseline complexion
  cancels. (An earlier version compared region medians. That was blind to
  localised inflammation by construction: a median ignores outliers, and the
  inflammation around a pimple *is* the outlier. It returned an identical
  reading for a face of red pimples and a uniformly flushed face.)
* **Blemish-like spots** use a morphological top-hat, which responds only to
  features brighter than their immediate surroundings. Large-scale tone is
  removed mathematically before any spot is counted, and the significance
  threshold is derived from that person's own skin noise.
* **Texture** signals are a ratio of fine-scale to coarse-scale detail. Both
  scale with contrast, so the ratio cancels brightness and contrast. An
  earlier version divided by mean brightness, which *over-corrected* for dark
  skin and inflated its scores; that was a second, separate bias. Inflamed
  pixels are excluded before texture is measured, so acne is not reported as
  dryness.

Results are reported in calibrated bands (low, mild, moderate, high) or as
**uncertain** when exposure or lighting makes colour untrustworthy, so a
washed-out or badly lit photograph never produces a confident "low".

This removes the dependence on a fixed reference colour. Verified by an
invariance test: the same face, rendered across a wide simulated complexion
range with facial structure held pixel-identical, produces the same output
(clear skin, no concern suggested) at every tone.

### Why that is still not fairness

* An invariance test on **one** synthetically re-toned face is not a study. It
  shows the maths is not tone-dependent by construction. It says nothing about
  real people, real cameras, or real skin conditions.
* Synthetic re-toning changes luminance. It does not reproduce the genuine
  optical differences of melanin-rich skin, its specular behaviour, or how
  conditions such as erythema actually present on it.
* **Redness on deeply pigmented skin may be genuinely difficult or impossible
  to see in visible-light photography.** A signal that never fires is not the
  same as a signal that works. Under-detection is a fairness failure too, and
  this project has not measured it.
* No dermatologist-labelled, skin-tone-diverse validation data has been used.
  Nothing has been measured against expert ground truth.

## What happens before the code runs

Camera hardware and firmware make irreversible decisions before a pixel
reaches this application:

* auto-exposure meters routinely under-expose deeper skin
* auto white balance shifts colour balance
* vendor noise reduction and "beautification" erase or invent texture
* lossy compression discards fine detail

None of this can be reliably undone afterwards. Brightening an under-exposed
frame amplifies noise rather than recovering detail, and clipped information
is simply gone. The system therefore **detects poor capture conditions and
asks for a better photograph** instead of silently analysing a degraded image
and presenting a confident-looking result. The texture signals in particular
still drift with exposure, which is why their thresholds sit deliberately
above that drift band.

## What the interface tells the user

The results panel carries a visible, non-collapsed section titled *About skin
tone and accuracy*, in normal body text rather than fine print. It states that
signals are measured against the user's own face, that this reduces but does
not eliminate bias, that proper evaluation requires a skin-tone-diverse
dermatologist-labelled dataset with per-group error rates, that device
processing affects the image beforehand, and that the user should trust their
own observation over the result.

Every suggested condition can be marked *This looks correct*, *I don't have
this*, or *Not sure*. Disagreeing is as easy as agreeing, and the suggestion
never auto-submits a product search.

## What would be required to make a fairness claim

1. A dermatologist-labelled dataset with documented skin-tone group labels
   from a published scale, with meaningful representation in every group.
2. Sensitivity, specificity, precision, recall, false-positive rate and
   false-negative rate computed **separately for every group and every
   condition**, with confidence intervals.
3. An explicit, justified fairness criterion (for example, comparable
   false-positive rates across groups) with a stated tolerance.
4. Analysis of capture conditions as a confounder, since lighting quality is
   not independent of skin tone.
5. Documented failure modes and an appeal route for users.
6. Independent review; self-assessment is not evaluation.

Until all of that exists, the correct description is: an experimental
browser-assisted cosmetic screening prototype whose fairness is **unmeasured**.

## Explicit non-goals

This project does not and must not:

* infer ethnicity or race
* estimate a user's skin tone during a live scan
* treat any estimated skin tone as ground truth about a person
* vary decision thresholds by skin tone without validated evidence
* store face images
* present algorithmic scores as medical probabilities

## Reference material for a validation pipeline

These are resources for building a **separate** evaluation and auditing
pipeline. They are references, not dependencies, and their skin-tone
estimation must not be wired into the live diagnosis logic.

* Google SCIN Dataset — https://github.com/google-research-datasets/scin
* Sony Skin Tone Extraction — https://github.com/SonyResearch/skin-tone-extraction
* Revisiting Skin Tone Fairness — https://github.com/tkalbl/RevisitingSkinToneFairness
* Awesome Medical Imaging Fairness — https://github.com/XuZikang/Awesome-MedIA-Fairness

See `evaluation/` for the schema and metrics tooling that such a pipeline
would feed.
