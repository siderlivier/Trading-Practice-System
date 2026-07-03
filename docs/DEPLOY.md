# Deploying to GitHub Pages

This project is 100% static — no build step required. GitHub Pages hosts it for free with automatic HTTPS.

## Quick setup (5 minutes)

### Step 1 — Create the GitHub repo & push
```bash
cd "trading practice"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/trading-practice.git
git push -u origin main
```

### Step 2 — Enable Pages
1. Go to your repo on GitHub → **Settings** → **Pages** (left sidebar)
2. Under **Source**, choose **GitHub Actions**
3. That's it. The workflow file `.github/workflows/deploy.yml` handles the rest.

### Step 3 — Wait for the first deploy
- Push triggers the workflow automatically
- Go to the **Actions** tab to watch progress (~30 seconds)
- When it's green, your site is live at:
  ```
  https://YOUR_USERNAME.github.io/trading-practice/
  ```

### Step 4 — Update the README's demo link
Replace `YOUR_USERNAME` in `README.md` with your actual GitHub username, commit and push. The site will redeploy automatically.

---

## How it works

- `.github/workflows/deploy.yml` runs on every push to `main`
- Uploads the entire repo as a static artifact (no build needed)
- Deploys via `actions/deploy-pages@v4` — the modern, first-party GitHub Pages action

- `.nojekyll` at repo root tells GitHub Pages: "Don't try to process this with Jekyll." Important because:
  - Files/folders starting with `_` (Jekyll ignores them by default) would break
  - Without `.nojekyll`, Pages processes markdown which we don't want

---

## Local testing before push

The tool works via `file://` protocol, but `localStorage` may be flaky. Better to use a local server:

```bash
# Python 3
python -m http.server 8000

# Or Node
npx serve

# Then open http://localhost:8000
```

---

## Common issues

**Q: My deploy shows "Get Pages site failed" the first time.**
A: Normal — first deploy hasn't run yet. Just push once more.

**Q: The site loads but I get 404 for CSS/JS.**
A: Check your paths in `index.html` are relative (e.g. `assets/app.js`, not `/assets/app.js`). Absolute paths break under `/repo-name/` subdirectory.

**Q: `localStorage` doesn't persist between page reloads.**
A: Some browsers restrict `localStorage` on `file://`. Always test with a real server (or the Pages URL).

**Q: Can I use a custom domain?**
A: Yes. Settings → Pages → **Custom domain**. Add a `CNAME` file to repo root with your domain, then configure DNS. HTTPS is automatic.

---

## Alternative: manual branch deployment

If you don't want the Actions workflow, you can also deploy from a branch:

1. **Settings** → **Pages** → **Source: Deploy from a branch**
2. **Branch**: `main`, **Folder**: `/` (root)
3. Save. GitHub will deploy on every push.

The Actions workflow is more visible (you see progress in the Actions tab) and easier to customize later, so I recommend that as the default.
