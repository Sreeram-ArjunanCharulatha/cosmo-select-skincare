# COSMO SELECT

Premium skincare recommendation website built with HTML, CSS, and vanilla JavaScript.

## Project structure

```text
cosmo-select-gitlab/
├── index.html
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── images/
├── assets/
│   └── videos/
└── .gitlab-ci.yml
```

## Run locally

Because the recommendation system calls the TriplyDB SPARQL endpoint, serve the folder through a local web server instead of opening `index.html` directly.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Upload to GitLab

1. Create an empty GitLab project.
2. Upload the contents of this folder to the repository root.
3. Commit and push to the `main` branch.
4. GitLab Pages will publish the static website using `.gitlab-ci.yml`.

The TriplyDB endpoint, SPARQL query, filters, product rendering, local image fallbacks, video assets, and responsive behavior are preserved.

## Visual skin-screening prototype (experimental)

An optional "Analyse your skin" button in **Find Your Match** opens an
experimental browser-assisted cosmetic screening prototype. It uses
MediaPipe facial landmarks and OpenCV-based visible-feature measurements
(served by a local Python Flask API in `skin-analysis-api/`) to *suggest*
concerns for user confirmation before the existing knowledge-graph product
retrieval runs. It is **not** a medical diagnosis: MediaPipe only locates
facial landmarks, the concern signals are custom image-processing
heuristics, and results vary with lighting, camera, angle, skin tone,
facial hair, makeup and compression. Images are processed in memory and
never stored.

Run both servers:

```bash
# Terminal 1 — Python analysis API
cd skin-analysis-api
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip -r requirements.txt
python3 app.py            # http://127.0.0.1:5050/api/health

# Terminal 2 — frontend
python3 -m http.server 8080   # open http://localhost:8080
```

If the API is not running, the site still works fully — the screening
modal simply reports that the service is unavailable and users select
concerns manually. See `skin-analysis-api/README.md` for deployment notes
(static host for the frontend, a Python host such as Render/Railway/Fly.io
for the API, `window.COSMO_SKIN_API_URL` to point at a deployed API).

## Fairness limitations and future validation

**No fairness claim is made.** This system is not unbiased, not clinically
validated, not dermatologist-approved, not medically accurate, and has not
been shown to be equally accurate across skin tones.

One specific structural bias has been designed out. Instead of comparing every
user against fixed absolute colour thresholds, **every signal is measured
relative to regions of the same user's own face**: redness locates clusters of
pixels warmer than the skin immediately around them, judged against each
region's own baseline; blemish detection uses a morphological top-hat that
removes large-scale tone before counting spots; and texture signals are
fine-to-coarse detail ratios that cancel brightness and contrast.

Fixed thresholds inherit whatever skin tones were present in the data used to
choose them, so deeper skin falls outside those ranges and normal melanin gets
read as an abnormal signal. Removing that dependence eliminates one known
source of bias.

**It does not establish equal performance across skin tones.** Specifically:

* The project has **no dermatologist-labelled, skin-tone-diverse validation
  dataset**, so nothing has been measured against expert ground truth.
* Verification so far is an invariance test on synthetically re-toned images.
  That shows the maths is not tone-dependent by construction; it says nothing
  about real people, cameras or conditions.
* Under-detection is also a fairness failure. Redness on deeply pigmented skin
  may be hard to observe in visible light at all, and this has not been
  measured.
* Camera auto-exposure, white balance and device processing alter the image
  before it reaches this code and cannot always be corrected afterwards.

**The system must not be presented as a medical diagnostic tool.**

Future evaluation must report performance **separately by skin-tone group**,
computing sensitivity, specificity, precision, recall, false-positive rate and
false-negative rate for every analysed condition, with small groups explicitly
flagged as unreliable rather than quoted.

### Research resources

References for building a **separate** validation and auditing pipeline. Their
skin-tone estimation must not be inserted into the live diagnosis logic, and
an estimated skin tone must never be treated as ground truth about a person.

1. **Google SCIN Dataset** — https://github.com/google-research-datasets/scin
2. **Sony Skin Tone Extraction** — https://github.com/SonyResearch/skin-tone-extraction
3. **Revisiting Skin Tone Fairness** — https://github.com/tkalbl/RevisitingSkinToneFairness
4. **Awesome Medical Imaging Fairness** — https://github.com/XuZikang/Awesome-MedIA-Fairness

### Where to look

* `docs/fairness-limitations.md` — full statement of what is and is not claimed
* `evaluation/` — offline schema and metrics tooling for a validation pipeline
  (never imported by the live analysis code)
