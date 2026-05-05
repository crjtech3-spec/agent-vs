# Azure Foundry Agent

Azure Foundry Agent is a VS Code sidebar extension backed by a local Python agent runtime and the Azure OpenAI Responses REST API.

No SDK is used. Model calls go through `requests` to the Azure OpenAI Responses endpoint.

## Marketplace status

This repository is now structured so it can be packaged for the VS Code Marketplace. The GitHub metadata is set to the expected repository location:

- `https://github.com/crjtech3-spec/agent-vs`
- `https://github.com/crjtech3-spec/agent-vs/issues`
- the `UNLICENSED` placeholder if you plan to publish under a real license
- your final VS Code Marketplace publisher slug, if it differs from `crjtech`

## Quick start for an installed extension

1. Install Python 3.9+ on the machine that runs VS Code.
2. Install the extension.
3. Open a folder in VS Code. Azure Foundry Agent only edits files inside the active workspace root.
4. Open the `Azure Foundry Agent` sidebar.
5. Paste your Azure AI Foundry connection details:
   - endpoint in the sidebar config form, or `agentVs.foundryEndpoint`
   - model or deployment name in the sidebar config form, or `agentVs.foundryModel`
   - API key in the sidebar config form, or `Azure Foundry Agent: Set Azure Foundry API Key`
6. Click `Save Config`.
7. Click `Install Backend` once, or run `Azure Foundry Agent: Install Backend Dependencies`.
8. Click `Test API`.
9. Enter a goal and click `Run`.

If you prefer env files, Azure Foundry Agent still reads workspace values from `.agentvs/config.env` and `.env`. The extension also accepts both legacy Azure OpenAI variable names and Foundry-flavored names:

```dotenv
AZURE_OPENAI_API_KEY=<your-key>
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/openai/v1/
AZURE_OPENAI_MODEL=<deployment-or-model-name>
```

or

```dotenv
AZURE_FOUNDRY_API_KEY=<your-key>
AZURE_FOUNDRY_ENDPOINT=https://your-resource.services.ai.azure.com/openai/v1/
AZURE_FOUNDRY_MODEL=<deployment-or-model-name>
```

## Extension commands

- `Azure Foundry Agent: Open Sidebar`
- `Azure Foundry Agent: Install Backend Dependencies`
- `Azure Foundry Agent: Show Output`
- `Azure Foundry Agent: Set Azure Foundry API Key`
- `Azure Foundry Agent: Clear Azure Foundry API Key`
- `Azure Foundry Agent: Open Settings`

## Extension settings

- `agentVs.foundryEndpoint`: Azure AI Foundry endpoint or full responses URL
- `agentVs.foundryModel`: model or deployment name used for requests
- `agentVs.pythonPath`: Python executable used to launch the backend
- `agentVs.envFile`: workspace-relative env file loaded before reading Foundry settings
- `agentVs.maxIterations`: default iteration cap for new runs
- `agentVs.promptInstallDependencies`: prompt to install missing Python modules automatically

## Runtime layout

Runtime artifacts are stored under:

```text
<workspace>/.agentvs/
```

That folder contains:

- `state.json`
- `memory.json`
- `agent.log`

## Python dependencies

For the VS Code extension backend only:

```powershell
pip install -r requirements-vscode.txt
```

For the full local project, including the browser GUI:

```powershell
pip install -r requirements.txt
```

`requirements.txt` includes Flask for the browser GUI. The extension itself only needs `requests`.

## Local development

### Run in VS Code from source

1. Open this repository in VS Code.
2. Install Python dependencies:

```powershell
pip install -r requirements-vscode.txt
```

3. Set Azure settings in either:
   - your shell environment
   - `workspace/.agentvs/config.env`
   - a source-only root `.env` for local development
4. Press `F5` to launch an Extension Development Host.
5. In the development host, open a workspace folder and use the `Azure Foundry Agent` sidebar.

### Run as CLI

```powershell
python -m agent.main "Build a FastAPI app with a /health endpoint and a test"
```

Resume a saved goal:

```powershell
python -m agent.main --resume
```

Cap the loop:

```powershell
python -m agent.main --max-iterations 30 "Refactor utils.py to remove globals"
```

### Run the browser GUI

```powershell
pip install -r requirements.txt
python run_gui.py
```

## Packaging for Marketplace

Install `vsce` and package from the repo root:

```powershell
npm install
npm run package:vsix
```

This repository pins a local `@vscode/vsce` version that works with Node 18. Using the project-local package command is more reliable than a newer global `vsce`.

Before you package or publish:

1. Verify that the GitHub repository exists at `crjtech3-spec/agent-vs`, or update the manifest URLs if you choose a different repo name.
2. Review `SUPPORT.md` and `CHANGELOG.md`.
3. Remove or rename any local root `.env` file. `vsce` may block packaging when env files containing secrets are present.
4. Verify the icon at `vscode/media/icon.png`.

Publish after you have created a Marketplace publisher and logged in with `vsce`:

```powershell
vsce login <publisher-id>
vsce publish
```

## Architecture

`agent/`
- `main.py`: CLI entry point
- `agent.py`: plan -> act -> observe -> reflect loop
- `session.py`: reusable runtime/session manager for hosts
- `vscode_bridge.py`: JSON-lines bridge used by the VS Code extension
- `planner.py`, `reflection.py`, `executor.py`, `tools.py`: agent behavior and tool dispatch
- `workspace.py`: workspace path safety, indexing, search, ranked context
- `memory.py`: persistent state and history
- `logger.py`: structured logging plus event pub/sub
- `config.py`: workspace-aware environment, runtime paths, and safety settings

`gui/`
- `server.py`: Flask host that reuses the shared session manager
- `static/`: browser GUI assets

`vscode/`
- `extension.js`: VS Code extension host
- `media/`: webview UI assets

## Agent tools

| Tool | Purpose |
|---|---|
| `read_file` | Read a workspace file |
| `write_file` | Create or overwrite a workspace file |
| `append_file` | Append to a workspace file |
| `list_files` | List a workspace directory |
| `search_code` | Regex-or-literal search across workspace files |
| `run_terminal` | Run a shell command scoped to the workspace |
| `run_tests` | Convenience wrapper around `python -m pytest -q` |
| `install_dependencies` | `pip install ...` with package-name validation |
| `finish` | Declare the goal complete |

## Safety

- Workspace path resolution blocks escaping the active workspace root.
- Protected paths like `.git`, `.env`, and SSH keys are blocked.
- `run_terminal` rejects a list of obviously dangerous shell patterns.
- Command execution is time-limited by `TOOL_TIMEOUT_SECONDS`.
- Dependency installation validates package names before invoking `pip`.
