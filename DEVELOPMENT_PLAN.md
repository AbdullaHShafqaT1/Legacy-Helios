# Development Plan & Local Setup Guide

This document outlines standard development patterns, environment dependencies, testing setups, and code deployment patterns for developers contributing code to **Legacy's Predator**.

---

## 🛠️ System Prerequisites

To run and compile Predator OS locally, your development machine should have:

1. **Python 3.10+** (using `venv` or `poetry` for package dependencies).
2. **Node.js 18+** (with `pnpm` or `npm` for building the visual web interface).
3. **Docker** (recommended for running local sandboxed tool execution containers).
4. **Git** (for code version control).

---

## 🚀 Step-by-Step Environment Bootstrapping

### 1. Clone and Setup Workspace
```bash
git clone https://github.com/AbdullaHShafqaT1/Legacys-Predator.git
cd Legacys-Predator
```

### 2. Configure Virtual Environment (Python)
Create and source a Python virtual environment to manage library dependencies cleanly:
```bash
python -m venv .venv
# On Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# On Linux/macOS:
source .venv/bin/activate

# Install development dependencies
pip install --upgrade pip
pip install -r requirements-dev.txt
```

### 3. Initialize Visual dashboard UI (Node)
Navigate to the web client and install modules:
```bash
cd apps/web-dashboard
npm install
```

---

## 🧪 Testing Guidelines

We enforce **Test-Driven Development (TDD)** for all core orchestrator modules.

- **Unit Tests**: Test single class behaviors and parsing logic (run with `pytest tests/unit`).
- **Integration Tests**: Validate tool execution pipelines and model message generation routines (run with `pytest tests/integration`).
- **Mocking**: Use mock wrappers for LLM provider API requests to avoid API charges during unit test runs.

All unit tests must pass before merging pull requests.
