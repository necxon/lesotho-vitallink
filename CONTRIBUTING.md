# Contributing to the Lesotho Health System Sandbox

Thank you for your interest in improving the Lesotho Health System Sandbox environment. We welcome community input, suggestions, and structural fixes to keep the simulation layer performant and realistic.

## Maintaining Architecture & Operational Policy

To prevent regressions against the validated national healthcare specification stacks, **this repository operates under a strict, centralized governance structure**:

1. **Gatekeeping and Approvals:** The repository maintainer is the sole administrator empowered to review, sign off on, and merge incoming changes.
2. **Main Branch Lockdown:** The `main` branch is protected. Direct commits or unreviewed pushes are completely blocked by automated branch protection rules.
3. **Review Lifecycle:** Every contribution must pass through an isolated fork or local feature branch before being submitted as a GitHub Pull Request (PR) against the central `main` branch.

---

## Structural Requirements for Pull Requests

Before you submit a Pull Request, ensure that your modifications strictly satisfy the following criteria:

* **No Environment Leakage:** Ensure your scripts contain absolutely no absolute local paths (e.g., hardcoded file links specific to a single operating system user). Use dynamic, relative, environment-independent variables.
* **No Inline Production Secrets:** If adding configurations or testing patterns, do not embed credentials inside executable logic. Utilize dynamic references mapping cleanly against uncommitted environment configurations (`.env`).
* **Test Verification:**
    * All JavaScript components must pass unit validation specs via: `make test`
    * The deployment stack must satisfy complete end-to-end validation without standard runtime exceptions via: `bash scripts/e2e-test.sh`

---

## How to Submit Changes

1. **Fork the Repository:** Create your own localized copy of the source code.
2. **Isolate Your Changes:** Cut a clear feature branch detailing your work (e.g., `feature/update-fhir-mappings`).
3. **Commit Cleanly:** Write semantic, clear commit logs.
4. **Open a Pull Request:** Explicitly document the scope of your change, what issue it resolves, and verify that all automated integration test scripts ran successfully in your workspace environment.
5. **Await Review:** Your code will be reviewed by the repository owner. If modifications are requested, please address the feedback and push updates to your branch — the PR will be re-reviewed until it is ready to merge.
