# Contributing to Legacy's Helios

Thank you for your interest in contributing to **Legacy's Helios**! We aim to build a clean, production-grade AI Operating System, and we welcome contributions from developers, researchers, and creators.

Following these guidelines helps ensure a smooth, collaborative workflow for everyone.

---

## Code of Conduct

By participating in this project, you agree to abide by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please report any violations or inappropriate behavior to the project maintainers.

## How Can I Contribute?

### 1. Reporting Bugs
- Search existing issues to verify the bug has not been reported already.
- Use the **Bug Report** template when opening a new issue.
- Provide clear steps to reproduce, environment info, and log snippets.

### 2. Proposing Features
- We encourage new modules, tools, and agent templates!
- Open an issue using the **Feature Request** template.
- Explain the user persona, why it is needed, and any proposed design.

### 3. Submitting Pull Requests (PRs)
- Fork the repository and create your branch from `main`.
- Follow the branch naming conventions:
  - `feature/your-feature-name`
  - `bugfix/your-bugfix-name`
  - `docs/your-doc-changes`
  - `chore/cleanup-or-config`
- Run linting and unit tests locally before pushing.
- Ensure your PR corresponds to an open issue.
- Keep PRs focused. Do not mix unrelated refactoring with a feature.

---

## Development Standards

### Code Style
- **Python**: Follow [PEP 8](https://peps.python.org/pep-0008/). Use `black` and `ruff` for formatting and linting.
- **JavaScript / TypeScript**: Use `eslint` and `prettier` with 2-space indentation.
- **Git Commit Messages**: Use structured, semantic commit messages (e.g. `feat: add memory isolation`, `fix: handle null token weights`, `docs: clarify setup guidelines`).

### Code Documentation
- Maintain high docstring standards.
- Add comments explaining *why* something is done, not just *what* the code does.
- Update relevant architecture decisions (`docs/decisions/`) if proposing breaking core changes.

## Review and Merge Process

1. Once a PR is opened, CI workflows will validate formatting, type checks, and tests.
2. A project maintainer will review the code changes.
3. Once approved and checks pass, your changes will be merged into `main`!
