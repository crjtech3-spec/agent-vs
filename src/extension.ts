import * as cp from "child_process";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";

const REQUIRED_PYTHON_MODULES = ["requests"];
const BACKEND_REQUIREMENTS_FILE = "requirements-vscode.txt";
const SIDEBAR_VIEW_ID = "agentVs.sidebar";
const ACTIVITY_CONTAINER_ID = "agentVs";
const API_KEY_SECRET = "agentVs.foundryApiKey";
const DEFAULT_MAX_ITERATIONS = 60;
const EDITOR_CONTEXT_CHAR_LIMIT = 8000;

interface BackendEvent {
    type?: string;
    ts?: number;
    [key: string]: unknown;
}

interface PlanStep {
    title: string;
    done?: boolean;
}

interface SessionState {
    plan: PlanStep[];
    running: boolean;
    finished: boolean;
    iteration?: number;
}

interface WorkspaceEntry {
    path: string;
    name: string;
    is_dir: boolean;
}

interface BackendSnapshot {
    health: Record<string, unknown>;
    state: SessionState;
    files: { files: WorkspaceEntry[] };
    events: BackendEvent[];
}

interface HydratePayload extends BackendSnapshot {
    workspaceMissing: boolean;
    workspacePath?: string;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: Error) => void;
    method: string;
}

interface PythonInspection {
    python?: string;
    version?: string;
    missing: string[];
}

interface FoundryConfigSnapshot {
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    apiKey?: string;
}

class FoundryConfigStore {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async getSnapshot(includeSecret = false): Promise<FoundryConfigSnapshot> {
        const config = vscode.workspace.getConfiguration("agentVs");
        const endpoint = String(config.get("foundryEndpoint") ?? "").trim();
        const model = String(config.get("foundryModel") ?? "").trim();
        const apiKey = (await this.context.secrets.get(API_KEY_SECRET))?.trim() ?? "";

        return {
            endpoint,
            model,
            hasApiKey: Boolean(apiKey),
            apiKey: includeSecret ? apiKey : undefined,
        };
    }

    async saveConnection(details: {
        endpoint: string;
        model: string;
        apiKey?: string;
    }): Promise<void> {
        const config = vscode.workspace.getConfiguration("agentVs");
        await config.update(
            "foundryEndpoint",
            String(details.endpoint ?? "").trim(),
            vscode.ConfigurationTarget.Global
        );
        await config.update(
            "foundryModel",
            String(details.model ?? "").trim(),
            vscode.ConfigurationTarget.Global
        );

        const nextApiKey = String(details.apiKey ?? "").trim();
        if (nextApiKey) {
            await this.context.secrets.store(API_KEY_SECRET, nextApiKey);
        }
    }

    async setApiKey(apiKey: string): Promise<void> {
        const value = apiKey.trim();
        if (!value) {
            return;
        }
        await this.context.secrets.store(API_KEY_SECRET, value);
    }

    async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(API_KEY_SECRET);
    }

    async toBackendEnv(): Promise<NodeJS.ProcessEnv> {
        const snapshot = await this.getSnapshot(true);
        const env: NodeJS.ProcessEnv = {};

        if (snapshot.endpoint) {
            env.AZURE_FOUNDRY_ENDPOINT = snapshot.endpoint;
            env.AZURE_OPENAI_ENDPOINT = snapshot.endpoint;
        }
        if (snapshot.model) {
            env.AZURE_FOUNDRY_MODEL = snapshot.model;
            env.AZURE_OPENAI_MODEL = snapshot.model;
        }
        if (snapshot.apiKey) {
            env.AZURE_FOUNDRY_API_KEY = snapshot.apiKey;
            env.AZURE_OPENAI_API_KEY = snapshot.apiKey;
        }

        return env;
    }
}

class AgentBackendClient implements vscode.Disposable {
    private proc?: cp.ChildProcessWithoutNullStreams;
    private stdoutReader?: readline.Interface;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly listeners = new Set<(event: BackendEvent) => void>();
    private sequence = 0;
    private startPromise?: Promise<void>;
    private readonly dependencyPrompts = new Set<string>();
    private suppressNextExitNotification = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly configStore: FoundryConfigStore
    ) {}

    dispose(): void {
        this._shutdown("Agent backend was disposed.", false);
        this.listeners.clear();
    }

    restart(reason: string): void {
        this.output.appendLine(`[backend] restarting: ${reason}`);
        this._shutdown(reason, true);
    }

    onEvent(listener: (event: BackendEvent) => void): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    async initialize(workspacePath: string): Promise<BackendSnapshot> {
        await this.ensureStarted(workspacePath);
        return (await this.request("initialize", { workspace: workspacePath })) as BackendSnapshot;
    }

    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        await this.ensureStarted();
        if (!this.proc?.stdin) {
            throw new Error("Agent backend is not running.");
        }

        const id = String(++this.sequence);
        const payload = JSON.stringify({ id, method, params });

        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, {
                resolve,
                reject: (reason?: Error) => reject(reason),
                method,
            });

            this.proc?.stdin.write(payload + "\n", "utf8", (error) => {
                if (!error) {
                    return;
                }
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    async ensureStarted(workspacePath = ""): Promise<void> {
        if (this.proc) {
            return;
        }
        if (!this.startPromise) {
            this.startPromise = this._spawnWithFallbacks(workspacePath).finally(() => {
                this.startPromise = undefined;
            });
        }
        await this.startPromise;
    }

    async installDependencies(preferredExecutable = "", workspacePath = ""): Promise<{ executable: string }> {
        let lastError: unknown;
        const candidates = preferredExecutable ? [preferredExecutable] : this._pythonCandidates();

        for (const executable of candidates) {
            try {
                await this._installDependencies(executable, workspacePath);
                return { executable };
            } catch (error) {
                lastError = error;
                this.output.appendLine(
                    `[setup] dependency install failed with ${executable}: ${asErrorMessage(error)}`
                );
            }
        }

        throw (lastError as Error | undefined) ?? new Error("Could not install backend dependencies.");
    }

    private _shutdown(reason: string, suppressExitNotification: boolean): void {
        const pending = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of pending) {
            entry.reject(new Error(reason));
        }

        if (this.stdoutReader) {
            this.stdoutReader.close();
            this.stdoutReader = undefined;
        }

        const proc = this.proc;
        this.proc = undefined;
        this.startPromise = undefined;

        if (proc) {
            this.suppressNextExitNotification = suppressExitNotification;
            try {
                proc.kill();
            } catch {
                this.suppressNextExitNotification = false;
            }
        }
    }

    private async _spawnWithFallbacks(workspacePath = ""): Promise<void> {
        let lastError: unknown;

        for (const executable of this._pythonCandidates()) {
            try {
                let inspection = await this._inspectPython(executable, workspacePath);
                if (inspection.missing.length) {
                    const installed = await this._offerDependencyInstall(
                        executable,
                        inspection,
                        workspacePath
                    );
                    if (installed) {
                        inspection = await this._inspectPython(executable, workspacePath);
                    }
                    if (inspection.missing.length) {
                        throw new Error(`Missing Python modules: ${inspection.missing.join(", ")}.`);
                    }
                }

                await this._spawn(executable, workspacePath);
                this.output.appendLine(
                    `[backend] started with ${inspection.python ?? executable}`
                );
                return;
            } catch (error) {
                lastError = error;
                this.output.appendLine(
                    `[backend] failed with ${executable}: ${asErrorMessage(error)}`
                );
            }
        }

        throw (lastError as Error | undefined) ?? new Error("Could not start the Python backend.");
    }

    private _pythonCandidates(): string[] {
        const configured = String(
            vscode.workspace.getConfiguration("agentVs").get("pythonPath") ?? "python"
        ).trim();
        const values = new Set<string>();

        if (configured) {
            values.add(configured);
        }
        if (process.platform === "win32" && configured.toLowerCase() !== "py") {
            values.add("py");
        }

        return Array.from(values);
    }

    private _pythonArgs(executable: string, args: string[]): string[] {
        if (process.platform === "win32" && executable.toLowerCase() === "py") {
            return ["-3", ...args];
        }
        return args;
    }

    private async _backendEnv(workspacePath = ""): Promise<NodeJS.ProcessEnv> {
        const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
        const configuredEnvFile = String(
            vscode.workspace.getConfiguration("agentVs").get("envFile") ?? ""
        ).trim();

        if (configuredEnvFile) {
            env.AGENT_ENV_FILE = configuredEnvFile;
        }
        if (workspacePath) {
            env.AGENT_WORKSPACE = workspacePath;
        }

        Object.assign(env, await this.configStore.toBackendEnv());
        return env;
    }

    private _requirementsPath(): string {
        return path.join(this.context.extensionPath, BACKEND_REQUIREMENTS_FILE);
    }

    private async _inspectPython(executable: string, workspacePath = ""): Promise<PythonInspection> {
        const script = [
            "import importlib.util, json, sys",
            `required = ${JSON.stringify(REQUIRED_PYTHON_MODULES)}`,
            "missing = [name for name in required if importlib.util.find_spec(name) is None]",
            "print(json.dumps({'python': sys.executable, 'version': sys.version.split()[0], 'missing': missing}))",
        ].join("; ");

        return new Promise<PythonInspection>(async (resolve, reject) => {
            const env = await this._backendEnv(workspacePath);
            cp.execFile(
                executable,
                this._pythonArgs(executable, ["-c", script]),
                {
                    cwd: this.context.extensionPath,
                    env,
                    windowsHide: true,
                },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(
                            new Error(
                                String(stderr || stdout || error.message || "Python probe failed.").trim()
                            )
                        );
                        return;
                    }

                    try {
                        resolve(JSON.parse(String(stdout || "").trim()) as PythonInspection);
                    } catch {
                        reject(
                            new Error(
                                `Python probe returned invalid output: ${String(stdout || "").trim()}`
                            )
                        );
                    }
                }
            );
        });
    }

    private async _offerDependencyInstall(
        executable: string,
        inspection: PythonInspection,
        workspacePath = ""
    ): Promise<boolean> {
        const shouldPrompt = Boolean(
            vscode.workspace.getConfiguration("agentVs").get("promptInstallDependencies", true)
        );
        if (!shouldPrompt) {
            return false;
        }

        const key = `${executable}:${inspection.missing.join(",")}`;
        if (this.dependencyPrompts.has(key)) {
            return false;
        }
        this.dependencyPrompts.add(key);

        const action = await vscode.window.showWarningMessage(
            `Azure Foundry Agent is missing Python modules (${inspection.missing.join(", ")}) for ${
                inspection.python ?? executable
            }.`,
            "Install Dependencies",
            "Show Output"
        );

        if (action === "Show Output") {
            this.output.show(true);
            return false;
        }
        if (action !== "Install Dependencies") {
            return false;
        }

        try {
            await this._installDependencies(executable, workspacePath);
            vscode.window.showInformationMessage(
                "Azure Foundry Agent backend dependencies installed. Reopen the panel or retry your action."
            );
            return true;
        } catch (error) {
            this.output.show(true);
            vscode.window.showErrorMessage(
                `Could not install Azure Foundry Agent backend dependencies: ${asErrorMessage(error)}`
            );
            return false;
        }
    }

    private async _installDependencies(executable: string, workspacePath = ""): Promise<void> {
        const requirementsPath = this._requirementsPath();
        const args = this._pythonArgs(executable, ["-m", "pip", "install", "-r", requirementsPath]);

        this.output.show(true);
        this.output.appendLine(`[setup] installing backend dependencies with ${executable}`);

        return new Promise<void>(async (resolve, reject) => {
            const env = await this._backendEnv(workspacePath);
            const proc = cp.spawn(executable, args, {
                cwd: this.context.extensionPath,
                env,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });

            let combined = "";
            proc.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                combined += text;
                this.output.append(text);
            });
            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                combined += text;
                this.output.append(text);
            });
            proc.once("error", (error) => reject(error));
            proc.once("exit", (code) => {
                if (code === 0) {
                    this.output.appendLine("[setup] dependency install completed");
                    resolve();
                    return;
                }
                reject(
                    new Error((combined.trim() || `pip exited with code ${code}.`).slice(-1200))
                );
            });
        });
    }

    private async _spawn(executable: string, workspacePath = ""): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const args = this._pythonArgs(executable, ["-u", "-m", "agent.vscode_bridge"]);
            const env = await this._backendEnv(workspacePath);
            const proc = cp.spawn(executable, args, {
                cwd: this.context.extensionPath,
                env,
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            let reader: readline.Interface | undefined;
            let stderrBuffer = "";
            let settled = false;

            const startupTimer = setTimeout(() => {
                fail(new Error("Timed out waiting for the Python backend to start."));
            }, 15000);

            const fail = (error: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(startupTimer);
                reader?.close();
                try {
                    proc.kill();
                } catch {
                    // Best effort.
                }
                const tail = stderrBuffer.trim().slice(-800);
                if (tail) {
                    reject(new Error(`${error.message}\n${tail}`));
                    return;
                }
                reject(error);
            };

            const succeed = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(startupTimer);
                this.proc = proc;
                this.stdoutReader = reader;
                proc.on("exit", (code, signal) => this._handleExit(code, signal));
                resolve();
            };

            proc.once("error", (error) => fail(error));
            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                stderrBuffer += text;
                this.output.append(text);
            });

            reader = readline.createInterface({ input: proc.stdout });
            reader.on("line", (line) => {
                const message = this._safeParseMessage(line);
                if (!message) {
                    return;
                }
                if (message.type === "ready") {
                    succeed();
                    return;
                }
                this._handleMessage(message);
            });

            proc.once("exit", (code, signal) => {
                if (!settled) {
                    fail(
                        new Error(
                            `Python backend exited before ready (code ${code}, signal ${
                                signal ?? "none"
                            }).`
                        )
                    );
                }
            });
        });
    }

    private _safeParseMessage(line: string): Record<string, unknown> | undefined {
        const text = String(line || "").trim();
        if (!text) {
            return undefined;
        }
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch {
            this.output.appendLine(`[backend] non-JSON stdout: ${text}`);
            return undefined;
        }
    }

    private _handleMessage(message: Record<string, unknown>): void {
        if (message.type === "response") {
            const pending = this.pending.get(String(message.id ?? ""));
            if (!pending) {
                return;
            }
            this.pending.delete(String(message.id ?? ""));
            if (message.ok) {
                pending.resolve(message.result);
            } else {
                pending.reject(new Error(String(message.error ?? "Unknown backend error.")));
            }
            return;
        }

        if (message.type === "event") {
            const event = (message.event ?? {}) as BackendEvent;
            for (const listener of this.listeners) {
                try {
                    listener(event);
                } catch {
                    // Listener failures should not break the bridge.
                }
            }
        }
    }

    private _handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        const description = `Agent backend exited (code ${code}, signal ${signal ?? "none"}).`;
        this.output.appendLine(`[backend] ${description}`);

        if (this.stdoutReader) {
            this.stdoutReader.close();
            this.stdoutReader = undefined;
        }
        this.proc = undefined;
        this.startPromise = undefined;

        const pending = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of pending) {
            entry.reject(new Error(description));
        }

        const suppressed = this.suppressNextExitNotification;
        this.suppressNextExitNotification = false;
        if (suppressed) {
            return;
        }

        const event: BackendEvent = {
            type: "error",
            ts: Date.now() / 1000,
            message: description,
        };
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // Ignore downstream failures.
            }
        }
    }
}

class AgentSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel("Azure Foundry Agent");
    private readonly configStore: FoundryConfigStore;
    private readonly backend: AgentBackendClient;
    private readonly disposables: vscode.Disposable[] = [];
    private view?: vscode.WebviewView;
    private refreshTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.configStore = new FoundryConfigStore(context);
        this.backend = new AgentBackendClient(context, this.output, this.configStore);

        this.disposables.push(
            this.output,
            this.backend,
            this.backend.onEvent((event) => this._onBackendEvent(event)),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this._scheduleRefresh(150)),
            vscode.workspace.onDidSaveTextDocument(() => this._scheduleRefresh(250)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("agentVs")) {
                    this.backend.restart("Azure Foundry Agent settings changed.");
                    this._scheduleRefresh(150);
                }
            }),
            this.context.secrets.onDidChange((event) => {
                if (event.key === API_KEY_SECRET) {
                    this.backend.restart("Azure Foundry API key changed.");
                    this._scheduleRefresh(150);
                }
            })
        );
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        vscode.Disposable.from(...this.disposables).dispose();
    }

    showOutput(): void {
        this.output.show(true);
    }

    async installDependencies(): Promise<void> {
        try {
            const result = await this.backend.installDependencies("", this._workspacePath());
            vscode.window.showInformationMessage(
                `Azure Foundry Agent backend dependencies installed with ${result.executable}.`
            );
            this._scheduleRefresh(150);
        } catch (error) {
            this._reportError(
                `Could not install Azure Foundry Agent backend dependencies: ${asErrorMessage(error)}`
            );
        }
    }

    async setApiKeyFromCommand(): Promise<void> {
        const apiKey = await vscode.window.showInputBox({
            prompt: "Azure AI Foundry API key",
            password: true,
            ignoreFocusOut: true,
        });
        if (!apiKey?.trim()) {
            return;
        }

        await this.configStore.setApiKey(apiKey);
        vscode.window.showInformationMessage("Azure Foundry Agent stored the Azure Foundry API key.");
        await this.refresh();
    }

    async clearApiKeyFromCommand(): Promise<void> {
        const action = await vscode.window.showWarningMessage(
            "Clear the stored Azure Foundry API key for Azure Foundry Agent?",
            { modal: true },
            "Clear Key"
        );
        if (action !== "Clear Key") {
            return;
        }

        await this.configStore.clearApiKey();
        vscode.window.showInformationMessage("Azure Foundry Agent cleared the stored Azure Foundry API key.");
        await this.refresh();
    }

    async openSettings(): Promise<void> {
        await vscode.commands.executeCommand("workbench.action.openSettings", "agentVs");
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media"),
            ],
        };
        webviewView.webview.html = this._htmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => {
            void this._handleViewMessage(message);
        });
        void this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.view) {
            return;
        }

        const workspacePath = this._workspacePath();
        if (!workspacePath) {
            this._postToView({
                type: "hydrate",
                payload: await this._fallbackPayload(""),
            });
            return;
        }

        try {
            const snapshot = await this.backend.initialize(workspacePath);
            this._postToView({
                type: "hydrate",
                payload: {
                    workspaceMissing: false,
                    workspacePath,
                    ...snapshot,
                } satisfies HydratePayload,
            });
        } catch (error) {
            const message = `Could not initialize Azure Foundry Agent: ${asErrorMessage(error)}`;
            this._reportError(message, false);
            this._postToView({ type: "error", message });
            this._postToView({
                type: "hydrate",
                payload: await this._fallbackPayload(workspacePath),
            });
        }
    }

    private async _handleViewMessage(message: unknown): Promise<void> {
        const payload = (message ?? {}) as Record<string, unknown>;
        const type = String(payload.type ?? "");
        if (!type) {
            return;
        }

        if (type === "ready" || type === "refresh") {
            await this.refresh();
            return;
        }
        if (type === "installDependencies") {
            await this.installDependencies();
            return;
        }
        if (type === "showOutput") {
            this.showOutput();
            return;
        }
        if (type === "saveConfig") {
            await this._saveConnectionConfig(payload);
            return;
        }
        if (type === "clearApiKey") {
            await this._clearApiKeyFromView();
            return;
        }
        if (type === "openSettings") {
            await this.openSettings();
            return;
        }
        if (type === "start") {
            await this._startGoal(
                String(payload.goal ?? ""),
                Number(payload.maxIterations ?? DEFAULT_MAX_ITERATIONS),
                Boolean(payload.attachEditorContext)
            );
            return;
        }
        if (type === "stop") {
            await this._runBackendAction("stop");
            return;
        }
        if (type === "reset") {
            await this._runBackendAction("reset_memory");
            await this.refresh();
            return;
        }
        if (type === "testConnection") {
            await this._testConnection();
            return;
        }
        if (type === "openFile") {
            await this._openWorkspaceFile(String(payload.path ?? ""));
        }
    }

    private async _saveConnectionConfig(payload: Record<string, unknown>): Promise<void> {
        const endpoint = String(payload.endpoint ?? "").trim();
        const model = String(payload.model ?? "").trim();
        const apiKey = String(payload.apiKey ?? "");

        await this.configStore.saveConnection({ endpoint, model, apiKey });
        this.backend.restart("Azure Foundry connection changed.");
        vscode.window.showInformationMessage("Azure Foundry Agent saved the Azure Foundry connection.");
        await this.refresh();
    }

    private async _clearApiKeyFromView(): Promise<void> {
        await this.configStore.clearApiKey();
        this.backend.restart("Azure Foundry API key cleared.");
        vscode.window.showInformationMessage("Azure Foundry Agent cleared the stored Azure Foundry API key.");
        await this.refresh();
    }

    private async _startGoal(goal: string, maxIterations: number, attachEditorContext: boolean): Promise<void> {
        const workspacePath = this._workspacePath();
        if (!workspacePath) {
            this._reportError("Open a folder in VS Code before starting the agent.");
            return;
        }

        const trimmedGoal = goal.trim();
        const goalWithContext = attachEditorContext
            ? this._withEditorContext(trimmedGoal)
            : trimmedGoal;
        const iterations =
            Number.isFinite(maxIterations) && maxIterations > 0
                ? maxIterations
                : Number(
                      vscode.workspace.getConfiguration("agentVs").get("maxIterations") ??
                          DEFAULT_MAX_ITERATIONS
                  );

        try {
            await this.backend.initialize(workspacePath);
            await this.backend.request("start", {
                goal: goalWithContext,
                max_iterations: iterations,
            });
            this._scheduleRefresh(150);
        } catch (error) {
            this._reportError(asErrorMessage(error));
        }
    }

    private async _runBackendAction(method: string, params: Record<string, unknown> = {}): Promise<void> {
        try {
            const workspacePath = this._workspacePath();
            if (workspacePath) {
                await this.backend.initialize(workspacePath);
            }
            await this.backend.request(method, params);
        } catch (error) {
            this._reportError(asErrorMessage(error));
        }
    }

    private async _testConnection(): Promise<void> {
        const workspacePath = this._workspacePath();
        if (!workspacePath) {
            this._reportError("Open a folder in VS Code before testing the connection.");
            return;
        }

        try {
            await this.backend.initialize(workspacePath);
            const result = (await this.backend.request("test_connection")) as {
                model: string;
                reply: string;
            };
            vscode.window.showInformationMessage(
                `Azure Foundry Agent connected to ${result.model}: ${result.reply}`
            );
            await this.refresh();
        } catch (error) {
            this._reportError(asErrorMessage(error));
        }
    }

    private async _openWorkspaceFile(relativePath: string): Promise<void> {
        const workspacePath = this._workspacePath();
        if (!workspacePath || !relativePath) {
            return;
        }

        const target = path.join(workspacePath, relativePath);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private _withEditorContext(goal: string): string {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return goal;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            return goal;
        }

        const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        const selection = editor.selection;
        const sections = [`Active file: ${relativePath}`];

        if (!selection.isEmpty) {
            const rawSelection = editor.document.getText(selection);
            const truncated = rawSelection.length > EDITOR_CONTEXT_CHAR_LIMIT;
            const selectedText = truncated
                ? rawSelection.slice(0, EDITOR_CONTEXT_CHAR_LIMIT)
                : rawSelection;
            const language = editor.document.languageId || "text";
            sections.push(
                `Selected lines: ${selection.start.line + 1}-${selection.end.line + 1}`,
                `Selected code:\n\`\`\`${language}\n${selectedText}\n\`\`\`${
                    truncated ? "\nSelection truncated for prompt size." : ""
                }`
            );
        } else {
            sections.push(
                "No selection was attached. Inspect the active file in the workspace if it is relevant."
            );
        }

        return `${goal}\n\nVS Code editor context:\n${sections.join("\n\n")}`;
    }

    private _onBackendEvent(event: BackendEvent): void {
        this._postToView({ type: "backendEvent", event });

        const eventType = String(event.type ?? "");
        if (["observation", "finished", "run_done", "plan"].includes(eventType)) {
            this._scheduleRefresh(350);
        }
    }

    private _scheduleRefresh(delayMs: number): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, delayMs);
    }

    private _workspacePath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    }

    private _postToView(message: Record<string, unknown>): void {
        this.view?.webview.postMessage(message);
    }

    private _reportError(message: string, notifyUser = true): void {
        this.output.show(true);
        this.output.appendLine(`[error] ${message}`);
        if (notifyUser) {
            void vscode.window.showErrorMessage(message);
        }
    }

    private async _fallbackPayload(workspacePath: string): Promise<HydratePayload> {
        const config = await this.configStore.getSnapshot();
        const state: SessionState = { plan: [], running: false, finished: false, iteration: 0 };

        return {
            workspaceMissing: !workspacePath,
            workspacePath: workspacePath || undefined,
            health: {
                ok: false,
                endpoint: config.endpoint,
                model: config.model,
                key_set: config.hasApiKey,
                endpoint_set: Boolean(config.endpoint),
                model_set: Boolean(config.model),
                config_ready: Boolean(config.endpoint && config.model && config.hasApiKey),
                workspace: workspacePath,
                runtime_dir: workspacePath ? path.join(workspacePath, ".agentvs") : "",
                env_file: String(
                    vscode.workspace.getConfiguration("agentVs").get("envFile") ?? ""
                ).trim(),
                running: false,
            },
            state,
            files: { files: [] },
            events: [],
        };
    }

    private _htmlForWebview(webview: vscode.Webview): string {
        const nonce = String(Date.now()) + String(Math.random()).slice(2);
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media", "panel.js")
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media", "panel.css")
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Azure Foundry Agent</title>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <div class="eyebrow">CRJTECH</div>
        <h1>Azure Foundry Agent</h1>
        <p>Configure an Azure AI Foundry model, attach a workspace, and run coding tasks inside VS Code.</p>
      </div>
      <div class="hero-badges">
        <span id="statusBadge" class="badge badge-idle">idle</span>
        <span id="healthBadge" class="badge">config needed</span>
      </div>
    </header>

    <section class="panel config-panel">
      <div class="panel-head">
        <span>Azure Foundry</span>
        <span id="configMeta" class="panel-meta">not configured</span>
      </div>
      <div class="config-grid">
        <label class="config-field config-field-wide">
          <span>Endpoint</span>
          <input id="endpointInput" type="text" placeholder="https://&lt;resource&gt;.openai.azure.com/openai/v1/" />
        </label>
        <label class="config-field">
          <span>Model / Deployment</span>
          <input id="modelInput" type="text" placeholder="gpt-5-codex or your deployment name" />
        </label>
        <label class="config-field">
          <span>API Key</span>
          <input id="apiKeyInput" type="password" placeholder="Leave blank to keep the stored key" />
        </label>
      </div>
      <div id="configNote" class="config-note">
        Paste either a base <code>/openai/v1/</code> endpoint or a full responses URL. The API key is stored in VS Code secret storage.
      </div>
      <div class="tool-row">
        <button id="saveConfigBtn" class="ghost-button">Save Config</button>
        <button id="clearKeyBtn" class="ghost-button danger">Clear Key</button>
        <button id="settingsBtn" class="ghost-button">Open Settings</button>
      </div>
    </section>

    <section id="workspaceMissing" class="empty-state hidden">
      Open a folder in VS Code to let Azure Foundry Agent inspect files, run tasks, and apply edits in a workspace.
    </section>

    <section id="mainContent" class="stack hidden">
      <div class="facts">
        <article class="fact-card">
          <span class="fact-label">Workspace</span>
          <span id="workspacePath" class="fact-value">-</span>
        </article>
        <article class="fact-card">
          <span class="fact-label">Model</span>
          <span id="modelName" class="fact-value">-</span>
        </article>
        <article class="fact-card">
          <span class="fact-label">Runtime</span>
          <span id="runtimePath" class="fact-value">-</span>
        </article>
      </div>

      <section class="tool-row">
        <button id="refreshBtn" class="ghost-button">Refresh</button>
        <button id="installBtn" class="ghost-button">Install Backend</button>
        <button id="outputBtn" class="ghost-button">Open Output</button>
        <button id="testBtn" class="ghost-button">Test API</button>
        <button id="resetBtn" class="ghost-button danger">Reset Memory</button>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span>Plan</span>
          <span id="iterationMeta" class="panel-meta">No run yet</span>
        </div>
        <ol id="planList" class="plan-list"></ol>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span>Workspace Files</span>
          <span id="fileCount" class="panel-meta">0</span>
        </div>
        <div id="filesList" class="files-list"></div>
      </section>

      <section class="panel log-panel">
        <div class="panel-head">
          <span>Session Feed</span>
          <span id="eventCount" class="panel-meta">0</span>
        </div>
        <div id="eventsLog" class="events-log"></div>
      </section>

      <section class="composer">
        <label class="composer-label" for="goalInput">Goal</label>
        <textarea id="goalInput" rows="4" placeholder="Refactor a module, fix a bug, add a feature, or explain a part of the current workspace."></textarea>
        <label class="context-toggle" for="attachContext">
          <input id="attachContext" type="checkbox" checked />
          <span>Attach active editor context</span>
        </label>
        <div class="composer-actions">
          <label class="iter-field">
            <span>Iter cap</span>
            <input id="maxIterations" type="number" min="1" max="500" />
          </label>
          <button id="stopBtn" class="ghost-button">Stop</button>
          <button id="runBtn" class="primary-button">Run</button>
        </div>
      </section>
    </section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new AgentSidebarProvider(context);

    context.subscriptions.push(
        provider,
        vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand("agentVs.openPanel", async () => {
            await vscode.commands.executeCommand(
                `workbench.view.extension.${ACTIVITY_CONTAINER_ID}`
            );
        }),
        vscode.commands.registerCommand("agentVs.installDependencies", async () => {
            await provider.installDependencies();
        }),
        vscode.commands.registerCommand("agentVs.showOutput", () => {
            provider.showOutput();
        }),
        vscode.commands.registerCommand("agentVs.setApiKey", async () => {
            await provider.setApiKeyFromCommand();
        }),
        vscode.commands.registerCommand("agentVs.clearApiKey", async () => {
            await provider.clearApiKeyFromCommand();
        }),
        vscode.commands.registerCommand("agentVs.openSettings", async () => {
            await provider.openSettings();
        })
    );
}

export function deactivate(): void {}

function asErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error ?? "Unknown error");
}
