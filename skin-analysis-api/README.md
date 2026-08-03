# COSMO SELECT — Visual Skin-Screening API

An experimental browser-assisted cosmetic screening prototype using
MediaPipe facial landmarks and OpenCV-based visible-feature measurements
to suggest concerns for user confirmation before knowledge-graph product
retrieval.

**This is not a medical device.** MediaPipe locates facial landmarks only —
it does not classify acne, dryness, redness or dehydration. The concern
signals are custom image-processing heuristics whose output varies with
lighting, camera, angle, skin tone, facial hair, makeup and compression.
A clinically reliable system would require a labelled dataset, expert
annotations, training and validation, calibration, bias testing and
external clinical evaluation.

Images are processed in memory and never stored.

## Local setup

Recommended Python: 3.10–3.12 (a version supported by the pinned MediaPipe
release).

```bash
cd skin-analysis-api
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
python3 app.py
```

The API is then available at `http://127.0.0.1:5050`.
Health check: `http://127.0.0.1:5050/api/health`

Run the frontend from the project root in a second terminal:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. Both servers must remain running.

## Endpoints

| Method | Path                | Description                              |
| ------ | ------------------- | ---------------------------------------- |
| GET    | `/api/health`       | `{"status": "ok"}`                       |
| POST   | `/api/analyse-skin` | multipart `image` field → JSON analysis  |

Errors return clear JSON (`error`, `message`) with 400/413/422/500 codes.
GET on `/api/analyse-skin` returns 405 — analysis requires POST.

## Configuration

| Variable          | Default                                            |
| ----------------- | -------------------------------------------------- |
| `ALLOWED_ORIGINS` | localhost:8080 / 127.0.0.1:8080 / :8765 / `null`   |

For production set `ALLOWED_ORIGINS` to the deployed frontend origin(s).

## Deployment

GitHub Pages (or any static host) can serve only the frontend. Deploy this
API to a Python host (Render, Railway, Fly.io, …):

```bash
gunicorn app:app
```

A `Procfile` is included. Note that low-memory free plans may struggle with
MediaPipe + OpenCV. Point the frontend at the deployed API by defining,
before the main scripts load:

```html
<script>
  window.COSMO_SKIN_API_URL = "https://your-api-host.com/api/analyse-skin";
</script>
```
