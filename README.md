[README-PUBLISH.md](https://github.com/user-attachments/files/27389661/README-PUBLISH.md)
# OzProps Publish Automation

This folder is wired for auto-publishing to GitHub Pages.

## One-time setup

1. Create a GitHub repo (example name: `ozprops-deploy`).
2. In this folder, connect remote:

```bash
git remote add origin https://github.com/<your-username>/ozprops-deploy.git
```

1. In GitHub repo settings:
  - Open **Settings -> Pages**
  - Set **Source** to **GitHub Actions**

## Ongoing publish flow

Run:

```bash
./publish.command
```

What it does:

- copies `../ozprops.html` into `index.html`
- initializes git (if needed)
- commits changes
- pushes `main`
- GitHub Actions deploys automatically to Pages

