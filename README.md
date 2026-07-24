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
