# FairExit public preview deployment

This repository is prepared for Claude's existing Build 2 public preview and Build 2.1 deployment. It contains infrastructure only until Claude adds the approved preview. No application has been deployed by the infrastructure setup.

- Repository: https://github.com/alexanderjackson1982-boop/fairexit-norwich
- Default branch: `main`
- Pages source: GitHub Actions
- Deployment workflow: `.github/workflows/pages.yml`
- Trigger: manual only, from `main`; pushes do not publish automatically
- Static artifact directory: `site/`
- Expected site URL after the first successful deployment: https://alexanderjackson1982-boop.github.io/fairexit-norwich/
- Hosting: free GitHub Pages; use the standard `ubuntu-latest` runner, no larger runners or paid services

## Claude: deploy Build 2.1

1. Work from the existing completed Build 2 public preview. Do not start another application.
2. Place only its reviewed static output in `site/`, with `site/index.html` at the root. Preserve the existing application's implementation; this workflow deliberately does not choose a new framework or run a build. If a build is needed, use the existing project's own build process before copying its public output.
3. Verify assets and routing work at the project path `/fairexit-norwich/`. Do not assume deployment at the domain root. If the existing preview is incompatible, resolve that in Claude's existing build before deployment.
4. Verify all six locations receive equal demonstration coverage: Longwater Retail Park; Castle Quarter Car Park 1; Castle Quarter Car Park 2; McDonald's Riverside; Morrisons Riverside; IKEA Hall Road. The infrastructure does not assert this application check has already passed.
5. Review the public output and commit only explicitly selected files. Do not upload API credentials, real secret environment files, private monitoring/backend code, restricted traffic payloads, personal information, or the private handover/workspace. Never use the entire workspace as a Pages artifact. A browser bundle, source map, JSON fixture or public URL must not contain a secret. The workflow's basic filename check is not a comprehensive security scan.
6. Commit/push the public preview to `main`. With GitHub write access, open Actions, choose **Deploy public preview to GitHub Pages**, select **Run workflow**, branch **main**, and run it. A commit alone will not deploy.
7. Wait for the Pages deployment to succeed, open the returned HTTPS URL, and verify all six locations, assets, navigation and source/status labels. Initial setup has not run this workflow.

The job uses the built-in ephemeral `GITHUB_TOKEN` with `contents: read`, `pages: write` and `id-token: write`, and the `github-pages` environment. No TomTom secret, personal access token, deploy key or third-party hosting secret is needed in the workflow. Repository token defaults may remain read-only because the deploy job declares its narrower required permissions.

Claude needs authenticated repository write access to upload and dispatch; changing workflow files also needs workflow-write permission in whichever GitHub App/token it uses. For a fine-grained token, use repository-limited Contents and Actions write, plus Workflows write if editing this workflow. Repository Administration/Pages write is only needed if changing settings. Do not broaden an integration's permissions without owner approval.

## Scope

GitHub Pages serves static public content. It is not the private traffic-monitoring backend, a secret store or a licence to republish provider data. Clearly distinguish demonstration content from genuine live evidence. Retention and derived-data rights remain source-specific.

The first application deployment is intentionally left to Claude. No custom domain, paid subscription, upgrade, monitoring job or external data-service purchase is part of this repository setup.

