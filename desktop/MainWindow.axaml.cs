using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Kitten.Desktop;

public partial class MainWindow : Window
{
    private sealed record ConversationItem(string Id, string Title, string ProjectRoot, string Agent, string? ParentConversationId, long UpdatedAt)
    {
        public override string ToString()
        {
            var branch = string.IsNullOrWhiteSpace(ParentConversationId) ? "" : "↳ ";
            var role = string.IsNullOrWhiteSpace(Agent) || string.Equals(Agent, "general", StringComparison.OrdinalIgnoreCase) ? "" : $"[{Agent}] ";
            return $"{branch}{role}{Title}";
        }

        /// <summary>Recency, because several sessions in one project often share the same opening line.</summary>
        public string Age
        {
            get
            {
                if (UpdatedAt <= 0) return "";
                var elapsed = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(UpdatedAt);
                if (elapsed < TimeSpan.Zero) return "now";
                if (elapsed.TotalMinutes < 1) return "now";
                if (elapsed.TotalHours < 1) return $"{(int)elapsed.TotalMinutes}m";
                if (elapsed.TotalDays < 1) return $"{(int)elapsed.TotalHours}h";
                return elapsed.TotalDays < 7 ? $"{(int)elapsed.TotalDays}d" : DateTimeOffset.FromUnixTimeMilliseconds(UpdatedAt).ToLocalTime().ToString("d MMM");
            }
        }
    }

    private EngineClient? _engine;
    private readonly TranscriptView _transcript;
    private readonly EngineProcess _engineProcess = new();
    private readonly List<ConversationItem> _conversationItems = new();
    private string? _conversationId;
    private string _conversationSearch = "";
    private string? _activeRunId;
    private string? _lastCompletedRunId;
    private string? _activeTaskId;
    private string? _lastPlanRequest;
    private string? _approvalRunId;
    private string? _approvalCallId;
    private string[] _suggestedCommands = Array.Empty<string>();
    private string? _activeVerificationId;
    private bool _submissionActive;
    private bool _assistantStreamed;
    private bool _loadingConversation;
    private bool _canResumeInterrupted;
    private string? _activeBakeoffId;
    private string? _lastBakeoffReportPath;
    private readonly List<(string Role, string Model)> _bakeoffRecommendations = new();
    private readonly HashSet<string> _activeRunFiles = new(StringComparer.OrdinalIgnoreCase);
    private int _activeRunAdded;
    private int _activeRunRemoved;

    public MainWindow()
    {
        InitializeComponent();
        _transcript = new TranscriptView(TranscriptHost, TranscriptScroll);
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        await ConnectEngineAsync();
    }

    private async void RetryEngine(object? sender, RoutedEventArgs e)
    {
        RetryEngineButton.IsEnabled = false;
        try { await ConnectEngineAsync(); }
        finally { RetryEngineButton.IsEnabled = _engine is null; }
    }

    private async Task ConnectEngineAsync()
    {
        if (_engine is not null) return;
        try
        {
            Exception? last = null;
            for (var attempt = 0; attempt < 3 && _engine is null; attempt++)
            {
                try
                {
                    _engineProcess.Start();
                    _engine = await EngineClient.ConnectAsync();
                }
                catch (Exception ex)
                {
                    last = ex;
                    _engine = null;
                    if (attempt < 2) await Task.Delay(250 * (attempt + 1));
                }
            }
            if (_engine is null) throw last ?? new InvalidOperationException("the local engine did not connect");
            _engine.EventReceived += OnEngineEvent;
            _engine.Disconnected += OnEngineDisconnected;
            SetEngineState(EngineState.Connected, "Engine connected");
            RetryEngineButton.IsEnabled = false;
            await RefreshModelStatusAsync();
            await RefreshConversationsAsync();
        }
        catch (Exception ex)
        {
            SetEngineState(EngineState.Failed, $"Engine unavailable: {ex.Message}");
            Activity.Text = "Install a complete Kitten package or repair the local engine.";
            RetryEngineButton.IsEnabled = true;
        }
    }

    protected override async void OnClosed(EventArgs e)
    {
        if (_engine is not null) await _engine.DisposeAsync();
        _engineProcess.Dispose();
        base.OnClosed(e);
    }

    private async Task RefreshConversationsAsync(string? selectId = null)
    {
        if (_engine is null) return;
        var result = await _engine.CallAsync("conversation.list", new { search = string.IsNullOrWhiteSpace(_conversationSearch) ? null : _conversationSearch });
        if (result is null || result.Value.ValueKind != JsonValueKind.Array) return;
        _conversationItems.Clear();
        foreach (var item in result.Value.EnumerateArray())
        {
            var id = item.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
            if (string.IsNullOrWhiteSpace(id)) continue;
            _conversationItems.Add(new ConversationItem(
                id,
                item.TryGetProperty("title", out var title) ? title.GetString() ?? "Untitled" : "Untitled",
                item.TryGetProperty("projectRoot", out var root) ? root.GetString() ?? "" : "",
                item.TryGetProperty("agent", out var agent) ? agent.GetString() ?? "general" : "general",
                item.TryGetProperty("parentConversationId", out var parent) && parent.ValueKind == JsonValueKind.String ? parent.GetString() : null,
                item.TryGetProperty("updatedAt", out var updated) && updated.ValueKind == JsonValueKind.Number ? updated.GetInt64() : 0));
        }
        ConversationList.ItemsSource = null;
        ConversationList.ItemsSource = _conversationItems;
        var wanted = selectId is null ? _conversationItems.FirstOrDefault() : _conversationItems.FirstOrDefault(x => x.Id == selectId);
        if (wanted is not null) ConversationList.SelectedItem = wanted;
        else
        {
            _conversationId = null;
            SetProject(null);
            _transcript.ShowSystem("Welcome to Kitten.\n\nOpen a project to start a durable coding task. Kitten will inspect the workspace, use the sidecar for bounded planning, and keep the main model focused on implementation.\n\nYou can configure a local endpoint or managed llama.cpp runtime from Configure in the Model controls.");
            Evidence.Text = "Open a project to begin.";
            Activity.Text = "Ready — open a project to start.";
            SetRunControls(false);
        }
    }

    private async Task RefreshModelStatusAsync()
    {
        if (_engine is null) return;
        try
        {
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("settings.inspect", new { projectRoot });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object) return;
            var models = value.GetProperty("models");
            var main = models.TryGetProperty("main", out var mainValue) ? mainValue.GetString() : "unknown";
            var sidecar = models.TryGetProperty("sidecar", out var sidecarValue) ? sidecarValue.GetString() : "none";
            var sidecarEndpoint = models.TryGetProperty("sidecarBaseUrl", out var sidecarEndpointValue) && sidecarEndpointValue.ValueKind == JsonValueKind.String ? sidecarEndpointValue.GetString() : null;
            // The status line is one line. Everything else that used to be crammed into it — history
            // budget, hardware guidance, bakeoff winners, runtime state — is detail on hover, because a
            // five-line block wedged into a 24px strip is unreadable and pushed the layout around.
            var line = new List<string> { main ?? "unknown", $"sidecar {(string.IsNullOrWhiteSpace(sidecar) ? "none" : sidecar)}" };
            var detail = new List<string> { $"Main model: {main}", $"Sidecar model: {(string.IsNullOrWhiteSpace(sidecar) ? "none" : sidecar)}" };
            if (!string.IsNullOrWhiteSpace(sidecarEndpoint)) detail.Add($"Sidecar endpoint: {sidecarEndpoint}");
            if (value.TryGetProperty("contextWindowTokens", out var contextValue) && contextValue.ValueKind == JsonValueKind.Number)
            {
                var contextTokens = contextValue.GetInt32();
                var historyBudget = Math.Min(8000, Math.Max(1800, (int)(contextTokens * 0.35)));
                line.Add($"{contextTokens / 1000}k ctx");
                detail.Add($"History budget: ~{historyBudget:n0} of {contextTokens:n0} context tokens");
            }
            var recommendation = await _engine.CallAsync("model.recommend");
            if (recommendation is { } guidance && guidance.ValueKind == JsonValueKind.Object && guidance.TryGetProperty("summary", out var summary))
                detail.Add(summary.GetString() ?? "");
            if (recommendation is { } bakeoffGuidance && bakeoffGuidance.ValueKind == JsonValueKind.Object && bakeoffGuidance.TryGetProperty("latestBakeoff", out var latestBakeoff) && latestBakeoff.ValueKind == JsonValueKind.Object && latestBakeoff.TryGetProperty("recommendations", out var latestRecommendations) && latestRecommendations.ValueKind == JsonValueKind.Array && latestRecommendations.GetArrayLength() > 0)
            {
                var winners = latestRecommendations.EnumerateArray().Select(item =>
                {
                    var role = item.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : "tier";
                    var model = item.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "model";
                    var score = item.TryGetProperty("qualityScore", out var scoreValue) && scoreValue.ValueKind == JsonValueKind.Number ? $" {scoreValue.GetDouble():P0}" : "";
                    return $"{role}={model}{score}";
                });
                detail.Add($"Last bakeoff: {string.Join(", ", winners)}");
            }
            var runtime = await _engine.CallAsync("runtime.status");
            if (runtime is { } runtimeValue && runtimeValue.ValueKind == JsonValueKind.Object && runtimeValue.TryGetProperty("running", out var running))
                detail.Add($"Managed runtime: {(running.GetBoolean() ? "running" : "stopped")}");
            var probe = await _engine.CallAsync("model.probe", new { projectRoot });
            var offline = probe is { } probeValue && probeValue.ValueKind == JsonValueKind.Object && probeValue.TryGetProperty("reachable", out var reachable) && !reachable.GetBoolean();
            // An unreachable endpoint is the one model fact that has to be visible without hovering.
            if (offline) line.Add("endpoint offline — open Model settings");
            ModelText.Text = string.Join("  ·  ", line);
            ToolTip.SetTip(ModelText, string.Join("\n", detail.Where(entry => !string.IsNullOrWhiteSpace(entry))));
        }
        catch (Exception ex) { ModelText.Text = $"Models unavailable: {ex.Message}"; }
    }

    private async Task RefreshBakeoffHistoryAsync(string? projectRoot)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(projectRoot)) return;
        try
        {
            var result = await _engine.CallAsync("model.bakeoff.history", new { projectRoot, max = 1 });
            var path = result is { } value && value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0
                && value[0].TryGetProperty("path", out var pathValue) && pathValue.ValueKind == JsonValueKind.String
                ? pathValue.GetString()
                : null;
            _lastBakeoffReportPath = path;
            ViewBakeoffReportButton.IsEnabled = !string.IsNullOrWhiteSpace(path);
            ShowBakeoffSection(!string.IsNullOrWhiteSpace(path));
        }
        catch { /* report history is advisory and must never block project activation */ }
    }

    private async void CheckModels(object? sender, RoutedEventArgs e)
    {
        await RefreshModelStatusAsync();
        if (_engine is null) return;
        try
        {
            var probe = await _engine.CallAsync("model.probe");
            var reachableText = probe is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("reachable", out var reachable)
                ? (reachable.GetBoolean() ? "Endpoint reachable" : "Endpoint not reachable")
                : "Endpoint status unknown";
            var plan = await _engine.CallAsync("model.launch-plan");
            if (plan is { } launch && launch.ValueKind == JsonValueKind.Object)
            {
                var backend = launch.TryGetProperty("backend", out var backendValue) ? backendValue.GetString() : "unknown";
                var sidecarMode = launch.TryGetProperty("sidecarMode", out var sidecarValue) ? sidecarValue.GetString() : "disabled";
                var slots = launch.TryGetProperty("parallelSlots", out var slotsValue) ? slotsValue.GetInt32().ToString() : "1";
                var warnings = launch.TryGetProperty("warnings", out var warningValue) && warningValue.ValueKind == JsonValueKind.Array
                    ? string.Join("; ", warningValue.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)))
                    : "";
                Activity.Text = $"{reachableText}\nBackend: {backend}; sidecar: {sidecarMode}; slots: {slots}" + (string.IsNullOrWhiteSpace(warnings) ? "" : $"\n{warnings}");
            }
            else Activity.Text = reachableText;
        }
        catch (Exception ex) { Activity.Text = $"Model check failed: {ex.Message}"; }
    }

    private async void BenchmarkModels(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            Activity.Text = "Running a bounded model responsiveness probe...";
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("model.benchmark-battery", new { projectRoot, samples = 2 });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array) { Activity.Text = "Benchmark returned no result"; return; }
            var lines = rows.EnumerateArray().Select(row =>
            {
                var role = row.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : "tier";
                var model = row.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "model";
                var ok = row.TryGetProperty("successfulSamples", out var okValue) ? okValue.GetInt32() : 0;
                var latency = row.TryGetProperty("medianLatencyMs", out var latencyValue) && latencyValue.ValueKind == JsonValueKind.Number ? $"{latencyValue.GetDouble():0} ms" : "n/a";
                var tps = row.TryGetProperty("medianTokensPerSecond", out var tpsValue) && tpsValue.ValueKind == JsonValueKind.Number ? $"{tpsValue.GetDouble():0.0} tok/s" : "n/a";
                return $"{role} {model}: {ok} successful; median {latency}; {tps}";
            });
            Activity.Text = string.Join("\n", lines) + "\nSynthetic responsiveness check only; coding quality is not measured here.";
        }
        catch (Exception ex) { Activity.Text = $"Benchmark failed: {ex.Message}"; }
    }

    private async void CodingBenchmark(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            Activity.Text = "Running isolated coding-quality probe (up to 3 tasks per model)...";
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("model.coding-benchmark", new { projectRoot, timeoutMs = 30_000 });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array)
            {
                Activity.Text = "Coding probe returned no result";
                return;
            }
            var lines = rows.EnumerateArray().Select(row =>
            {
                var role = row.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : "tier";
                var model = row.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "model";
                var passed = row.TryGetProperty("passedCases", out var passedValue) ? passedValue.GetInt32() : 0;
                var total = row.TryGetProperty("totalCases", out var totalValue) ? totalValue.GetInt32() : 0;
                var score = row.TryGetProperty("score", out var scoreValue) && scoreValue.ValueKind == JsonValueKind.Number ? $" ({scoreValue.GetDouble():P0})" : "";
                return $"{role} {model}: {passed}/{total} cases{score}";
            });
            Activity.Text = string.Join("\n", lines) + "\nSandboxed smoke signal only; validate against your own held-out codebase.";
        }
        catch (Exception ex) { Activity.Text = $"Coding probe failed: {ex.Message}"; }
    }

    private async void ProjectBenchmark(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            Activity.Text = "Running held-out multi-file project probe (VM-isolated, no workspace writes)...";
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("model.project-benchmark", new { projectRoot, timeoutMs = 90_000 });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array)
            {
                Activity.Text = "Project probe returned no result";
                return;
            }
            var lines = rows.EnumerateArray().Select(row =>
            {
                var role = row.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : "tier";
                var model = row.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "model";
                var passed = row.TryGetProperty("passedCases", out var passedValue) ? passedValue.GetInt32() : 0;
                var total = row.TryGetProperty("totalCases", out var totalValue) ? totalValue.GetInt32() : 0;
                var score = row.TryGetProperty("score", out var scoreValue) && scoreValue.ValueKind == JsonValueKind.Number ? $" ({scoreValue.GetDouble():P0})" : "";
                return $"{role} {model}: {passed}/{total} hidden project cases{score}";
            });
            Activity.Text = string.Join("\n", lines) + "\nHeld-out signal only; generated files never touched the project or ran shell/network code.";
        }
        catch (Exception ex) { Activity.Text = $"Project probe failed: {ex.Message}"; }
    }

    private async void ModelBakeoff(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        if (_activeBakeoffId is not null) return;
        _activeBakeoffId = $"model-bakeoff-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
        CancelBakeoffButton.IsEnabled = true;
        ShowBakeoffSection(true);
        try
        {
            Activity.Text = "Running full local-model bakeoff (coding + held-out project tasks; up to 90 seconds per request)...";
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var candidates = new List<object>();
            try
            {
                var discovered = await _engine.CallAsync("model.discover", new { projectRoot });
                if (discovered is { } discoveredValue && discoveredValue.ValueKind == JsonValueKind.Object && discoveredValue.TryGetProperty("models", out var advertised) && advertised.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in advertised.EnumerateArray())
                    {
                        var model = item.TryGetProperty("id", out var modelValue) ? modelValue.GetString() : null;
                        var role = string.IsNullOrWhiteSpace(model) ? null : BakeoffRoleForModel(model!);
                        if (!string.IsNullOrWhiteSpace(model) && role is not null && !candidates.Any(candidate => JsonSerializer.Serialize(candidate).Contains(model, StringComparison.Ordinal)))
                            candidates.Add(new { role, model });
                    }
                }
            }
            catch { /* bakeoff falls back to the configured pair when discovery is unavailable */ }
            object request = candidates.Count > 0
                ? new { projectRoot, timeoutMs = 90_000, id = _activeBakeoffId, models = candidates.Take(12).ToArray() }
                : new { projectRoot, timeoutMs = 90_000, id = _activeBakeoffId };
            if (candidates.Count > 0) Activity.Text = $"Comparing {candidates.Count} discovered tier candidates (coding + held-out project tasks)...";
            var result = await _engine.CallAsync("model.bakeoff", request);
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("recommendations", out var recommendations) || recommendations.ValueKind != JsonValueKind.Array)
            {
                Activity.Text = "Bakeoff returned no result";
                return;
            }
            var lines = recommendations.EnumerateArray().Select(row =>
            {
                var role = row.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : "tier";
                var model = row.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "model";
                var quality = row.TryGetProperty("qualityScore", out var qualityValue) && qualityValue.ValueKind == JsonValueKind.Number ? $"{qualityValue.GetDouble():P0}" : "n/a";
                var coding = row.TryGetProperty("codingScore", out var codingValue) && codingValue.ValueKind == JsonValueKind.Number ? $"{codingValue.GetDouble():P0}" : "n/a";
                var project = row.TryGetProperty("projectScore", out var projectValue) && projectValue.ValueKind == JsonValueKind.Number ? $"{projectValue.GetDouble():P0}" : "n/a";
                return $"{role} {model}: combined {quality} (coding {coding}, project {project})";
            });
            _bakeoffRecommendations.Clear();
            foreach (var row in recommendations.EnumerateArray())
            {
                var role = row.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : null;
                var model = row.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : null;
                if (!string.IsNullOrWhiteSpace(role) && !string.IsNullOrWhiteSpace(model) && (role == "main" || role == "sidecar") && !_bakeoffRecommendations.Any(item => item.Role == role))
                    _bakeoffRecommendations.Add((role, model));
            }
            ApplyBakeoffButton.IsEnabled = _bakeoffRecommendations.Count > 0;
            _lastBakeoffReportPath = value.TryGetProperty("reportPath", out var reportPathValue) && reportPathValue.ValueKind == JsonValueKind.String ? reportPathValue.GetString() : null;
            ViewBakeoffReportButton.IsEnabled = !string.IsNullOrWhiteSpace(_lastBakeoffReportPath);
            Activity.Text = string.Join("\n", lines) + "\nRecommendation is based only on isolated local signals; review the saved report before changing models." + (string.IsNullOrWhiteSpace(_lastBakeoffReportPath) ? "" : $"\nSaved report: {_lastBakeoffReportPath}");
        }
        catch (Exception ex) { Activity.Text = $"Bakeoff failed: {ex.Message}"; }
        finally { _activeBakeoffId = null; CancelBakeoffButton.IsEnabled = false; }
    }

    private async void ViewBakeoffReport(object? sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_lastBakeoffReportPath)) return;
        try
        {
            var path = Path.GetFullPath(_lastBakeoffReportPath);
            if (!File.Exists(path)) { Activity.Text = "The last bakeoff report is no longer available."; ViewBakeoffReportButton.IsEnabled = false; return; }
            var report = File.ReadAllText(path);
            var close = new Button { Content = "Close" };
            var text = new TextBox { Text = report, IsReadOnly = true, AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.NoWrap, FontFamily = "Consolas", MinHeight = 420 };
            var reportScroll = new ScrollViewer { Content = text, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
            var dialog = new Window
            {
                Title = "Kitten bakeoff report",
                Width = 900,
                Height = 680,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Content = new DockPanel
                {
                    Margin = new Avalonia.Thickness(18),
                    Children = { close, reportScroll },
                },
            };
            DockPanel.SetDock(close, Dock.Bottom);
            close.Margin = new Avalonia.Thickness(0, 12, 0, 0);
            close.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right;
            await dialog.ShowDialog(this);
        }
        catch (Exception ex) { Activity.Text = $"Could not open bakeoff report: {ex.Message}"; }
    }

    private async void ApplyModelBakeoff(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || _bakeoffRecommendations.Count == 0) return;
        var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
        var approve = new Button { Content = "Apply to this project" };
        var cancel = new Button { Content = "Cancel" };
        var accepted = false;
        var dialog = new Window
        {
            Title = "Apply bakeoff winners",
            Width = 620,
            Height = 360,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 12,
                Children =
                {
                    new TextBlock { Text = "Kitten will explicitly select the highest-ranked configured candidate for each tier. This changes only the project model settings; no files are modified.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                    new TextBlock { Text = string.Join("\n", _bakeoffRecommendations.Select(item => $"{item.Role}: {item.Model}")), TextWrapping = Avalonia.Media.TextWrapping.Wrap, FontFamily = "Consolas" },
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { approve, cancel } },
                },
            },
        };
        approve.Click += (_, _) => { accepted = true; dialog.Close(); };
        cancel.Click += (_, _) => dialog.Close();
        await dialog.ShowDialog(this);
        if (!accepted) return;
        ApplyBakeoffButton.IsEnabled = false;
        try
        {
            foreach (var item in _bakeoffRecommendations)
                await _engine.CallAsync("model.select", new { role = item.Role, model = item.Model, scope = "project", projectRoot });
            Activity.Text = "Bakeoff winners applied to this project; model health refreshed.";
            await RefreshModelStatusAsync();
        }
        catch (Exception ex) { Activity.Text = $"Could not apply bakeoff winners: {ex.Message}"; ApplyBakeoffButton.IsEnabled = true; }
    }

    private async void CancelModelBakeoff(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || _activeBakeoffId is null) return;
        CancelBakeoffButton.IsEnabled = false;
        Activity.Text = "Stopping model bakeoff...";
        try { await _engine.CallAsync("model.bakeoff.cancel", new { id = _activeBakeoffId }); }
        catch (Exception ex) { Activity.Text = $"Could not stop bakeoff: {ex.Message}"; }
    }

    private async void ValidateModels(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            Activity.Text = "Validating configured models against the local endpoint...";
            var main = await _engine.CallAsync("model.validate", new { role = "main", projectRoot, probe = true, timeoutMs = 10_000 });
            var sidecar = await _engine.CallAsync("model.validate", new { role = "sidecar", projectRoot, probe = true, timeoutMs = 10_000 });
            static string Format(JsonElement? value, string role)
            {
                if (value is not { } item || item.ValueKind != JsonValueKind.Object) return $"{role}: unavailable";
                var valid = item.TryGetProperty("valid", out var validValue) && validValue.ValueKind == JsonValueKind.True;
                var verified = item.TryGetProperty("verified", out var verifiedValue) && verifiedValue.ValueKind == JsonValueKind.True;
                var error = item.TryGetProperty("error", out var errorValue) ? errorValue.GetString() : null;
                return $"{role}: {(valid ? (verified ? "verified" : error ?? "advertised, unreachable") : error ?? "invalid")}";
            }
            Activity.Text = $"{Format(main, "Main")}\\n{Format(sidecar, "Sidecar")}";
        }
        catch (Exception ex) { Activity.Text = $"Model validation failed: {ex.Message}"; }
    }

    private async void ModelHealth(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            Activity.Text = "Checking configured models and a bounded set of local candidates...";
            var checks = new[]
            {
                (Role: "main", Result: await _engine.CallAsync("model.health", new { role = "main", projectRoot, timeoutMs = 2500, maxCandidates = 8 })),
                (Role: "sidecar", Result: await _engine.CallAsync("model.health", new { role = "sidecar", projectRoot, timeoutMs = 2500, maxCandidates = 8 })),
            };
            var candidates = new List<(string Role, string Model, string Reason)>();
            var lines = new List<string>();
            foreach (var check in checks)
            {
                if (check.Result is not { } value || value.ValueKind != JsonValueKind.Object) { lines.Add($"{check.Role}: unavailable"); continue; }
                var configured = value.TryGetProperty("configured", out var configuredValue) ? configuredValue.GetString() ?? "none" : "none";
                var rows = value.TryGetProperty("rows", out var rowsValue) && rowsValue.ValueKind == JsonValueKind.Array ? rowsValue.EnumerateArray().ToArray() : Array.Empty<JsonElement>();
                var healthy = rows.Where(row => row.TryGetProperty("reachable", out var ok) && ok.ValueKind == JsonValueKind.True).ToArray();
                var configuredRow = rows.FirstOrDefault(row => row.TryGetProperty("id", out var id) && id.GetString() == configured);
                var configuredState = configuredRow.ValueKind == JsonValueKind.Object && configuredRow.TryGetProperty("state", out var stateValue)
                    ? stateValue.GetString() ?? "unavailable"
                    : (healthy.Any(row => row.TryGetProperty("id", out var id) && id.GetString() == configured) ? "responding" : "unavailable");
                var configuredLabel = configuredState == "slow/loading" ? "slow/loading" : configuredState == "responding" ? "responds" : "unavailable";
                lines.Add($"{check.Role}: {configured} {configuredLabel}; {healthy.Length} reachable candidate(s)");
                if (configuredState == "slow/loading") lines.Add($"{check.Role}: the configured model may still be loading; leave it selected or retry health after the runtime warms up.");
                if (value.TryGetProperty("recommendations", out var recommendations) && recommendations.ValueKind == JsonValueKind.Array)
                {
                    foreach (var recommendation in recommendations.EnumerateArray())
                    {
                        var model = recommendation.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : null;
                        var reason = recommendation.TryGetProperty("reason", out var reasonValue) ? reasonValue.GetString() : null;
                        if (!string.IsNullOrWhiteSpace(model) && !candidates.Any(candidate => candidate.Role == check.Role && candidate.Model == model))
                            candidates.Add((check.Role, model!, reason ?? "reachable"));
                    }
                }
            }
            Activity.Text = string.Join("\n", lines) + (candidates.Count == 0 ? "\nNo safe same-tier candidate was found. Keep the main 35B+ tier and start/load it in your local runtime." : "\nChoose a reachable candidate below to explicitly update this project.");
            if (candidates.Count == 0) return;
            var close = new Button { Content = "Close" };
            var dialog = new Window
            {
                Title = "Kitten model recovery",
                Width = 640,
                Height = Math.Min(520, 180 + candidates.Count * 64),
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
            };
            var content = new StackPanel { Margin = new Avalonia.Thickness(24), Spacing = 10 };
            content.Children.Add(new TextBlock { Text = "Nothing changes automatically. Select a responding candidate only when you want to use it.", TextWrapping = Avalonia.Media.TextWrapping.Wrap });
            foreach (var candidate in candidates)
            {
                var choose = new Button { Content = $"Use {candidate.Role}: {candidate.Model} — {candidate.Reason}", HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Left };
                choose.Click += async (_, _) =>
                {
                    choose.IsEnabled = false;
                    try
                    {
                        var root = projectRoot;
                        await _engine.CallAsync("model.select", new { role = candidate.Role, model = candidate.Model, projectRoot = root, scope = "project", timeoutMs = 5000 });
                        Activity.Text = $"Selected {candidate.Role} model {candidate.Model} for this project.";
                        dialog.Close();
                        await RefreshModelStatusAsync();
                    }
                    catch (Exception ex) { Activity.Text = $"Model selection failed: {ex.Message}"; choose.IsEnabled = true; }
                };
                content.Children.Add(choose);
            }
            close.Click += (_, _) => dialog.Close();
            content.Children.Add(close);
            dialog.Content = content;
            await dialog.ShowDialog(this);
        }
        catch (Exception ex) { Activity.Text = $"Model health check failed: {ex.Message}"; }
    }

    private async void ProbeCapabilities(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            Activity.Text = "Probing model capabilities (cached after the first pass)...";
            var main = await _engine.CallAsync("model.capabilities", new { role = "main", probe = true });
            var sidecar = await _engine.CallAsync("model.capabilities", new { role = "sidecar", probe = true });
            static string Format(JsonElement? value, string role)
            {
                if (value is not { } item || item.ValueKind != JsonValueKind.Object) return $"{role}: unavailable";
                var engine = item.TryGetProperty("engine", out var engineValue) ? engineValue.GetString() : "unknown";
                var grammar = item.TryGetProperty("grammar", out var grammarValue) && grammarValue.ValueKind == JsonValueKind.True;
                var logprobs = item.TryGetProperty("logprobs", out var logprobsValue) && logprobsValue.ValueKind == JsonValueKind.True;
                var cache = item.TryGetProperty("cachePrompt", out var cacheValue) && cacheValue.ValueKind == JsonValueKind.True;
                var context = item.TryGetProperty("contextSize", out var contextValue) && contextValue.ValueKind == JsonValueKind.Number ? contextValue.GetInt32().ToString() : "?";
                return $"{role}: {engine}; grammar {(grammar ? "on" : "off")}; logprobs {(logprobs ? "on" : "off")}; prompt cache {(cache ? "on" : "off")}; context {context}";
            }
            Activity.Text = $"{Format(main, "Main")}\n{Format(sidecar, "Sidecar")}";
        }
        catch (Exception ex) { Activity.Text = $"Capability probe failed: {ex.Message}"; }
    }

    private async void OpenWorkspaceExplorer(object? sender, RoutedEventArgs e)
    {
        var engine = _engine;
        if (engine is null) return;
        var root = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
        if (string.IsNullOrWhiteSpace(root))
        {
            Activity.Text = "Open a project before using the workspace explorer.";
            return;
        }
        var query = new TextBox { Watermark = "Search files, symbols, or imports...", MinWidth = 500 };
        var results = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 180, FontFamily = "Consolas" };
        var context = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 280, FontFamily = "Consolas", Text = "Search to preview the bounded context Kitten would hand a model for that query." };
        var status = new TextBlock { Text = "Indexing is local, bounded, and skips dependency/build directories.", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var index = new Button { Content = "Refresh index" };
        var search = new Button { Content = "Search" };
        var close = new Button { Content = "Close" };
        var dialog = new Window
        {
            Title = "Kitten workspace explorer",
            Width = 900,
            Height = 760,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 12,
                Children =
                {
                    PathRow(query, index, search),
                    status,
                    new TextBlock { Text = "Matching files", FontWeight = Avalonia.Media.FontWeight.Bold },
                    results,
                    new TextBlock { Text = "Bounded context", FontWeight = Avalonia.Media.FontWeight.Bold },
                    context,
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { close } },
                },
            },
        };
        close.Click += (_, _) => dialog.Close();
        async Task RefreshIndexAsync()
        {
            index.IsEnabled = false;
            status.Text = "Indexing the project…";
            try
            {
                var overview = await engine.CallAsync("workspace.index", new { root });
                if (overview is { } value && value.ValueKind == JsonValueKind.Object)
                {
                    var fileCount = value.TryGetProperty("files", out var filesValue) && filesValue.ValueKind == JsonValueKind.Number ? filesValue.GetInt32() : 0;
                    var testCount = value.TryGetProperty("tests", out var testsValue) && testsValue.ValueKind == JsonValueKind.Number ? testsValue.GetInt32() : 0;
                    var languages = value.TryGetProperty("languages", out var languagesValue) && languagesValue.ValueKind == JsonValueKind.Object
                        ? string.Join(", ", languagesValue.EnumerateObject().OrderByDescending(entry => entry.Value.ValueKind == JsonValueKind.Number ? entry.Value.GetInt32() : 0).Take(4).Select(entry => $"{entry.Name} {entry.Value}"))
                        : "";
                    status.Text = $"{fileCount} {(fileCount == 1 ? "file" : "files")} indexed · {testCount} test {(testCount == 1 ? "file" : "files")}{(languages.Length > 0 ? $" · {languages}" : "")}";
                }
                else status.Text = "Index complete.";
                // Show the project immediately. Opening onto two empty boxes gives the user nothing to
                // act on and no clue that a button has to be pressed first.
                var listed = await engine.CallAsync("workspace.files", new { root, limit = 400 });
                results.Text = DescribeSearchHits(listed);
            }
            catch (Exception ex) { status.Text = $"Index failed: {ex.Message}"; }
            finally { index.IsEnabled = true; }
        }
        index.Click += async (_, _) => await RefreshIndexAsync();
        search.Click += async (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(query.Text)) { status.Text = "Enter a search query first."; return; }
            search.IsEnabled = false;
            try
            {
                var hits = await engine.CallAsync("workspace.search", new { root, query = query.Text, limit = 20 });
                results.Text = DescribeSearchHits(hits);
                var bounded = await engine.CallAsync("workspace.context", new { root, query = query.Text, maxChars = 16000 });
                context.Text = bounded is { } contextValue && contextValue.ValueKind == JsonValueKind.String ? contextValue.GetString() : "No bounded context.";
                status.Text = "Search complete. Context is intentionally bounded before it reaches a model.";
            }
            catch (Exception ex) { status.Text = $"Search failed: {ex.Message}"; }
            finally { search.IsEnabled = true; }
        };
        var explorerTask = dialog.ShowDialog(this);
        await RefreshIndexAsync();
        await explorerTask;
    }

    private async void OpenAgentLibrary(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        var status = new TextBlock { Text = "Agent definitions are local to this project and editable from the app.", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var definitions = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 380, FontFamily = "Consolas" };
        var create = new Button { Content = "Create project agent" };
        var spawn = new Button { Content = "Run subagent" };
        var refresh = new Button { Content = "Refresh" };
        var close = new Button { Content = "Close" };
        var dialog = new Window
        {
            Title = "Kitten agent library",
            Width = 900,
            Height = 680,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            // The definition list is long, so the actions dock instead of scrolling out of reach.
            Content = new DockPanel
            {
                LastChildFill = true,
                Children =
                {
                    new Border
                    {
                        [DockPanel.DockProperty] = Dock.Bottom,
                        Padding = new Avalonia.Thickness(24, 12),
                        BorderThickness = new Avalonia.Thickness(0, 1, 0, 0),
                        BorderBrush = new Avalonia.Media.SolidColorBrush(Avalonia.Media.Color.Parse("#26262e")),
                        Child = ButtonRow(spawn, create, refresh, close),
                    },
                    new ScrollViewer
                    {
                        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
                        Content = new StackPanel
                        {
                            Margin = new Avalonia.Thickness(24),
                            Spacing = 12,
                            Children =
                            {
                                new TextBlock { Text = "Agents are bounded roles, not hidden magic: each definition declares its model tier, step budget, edit/bash/task permissions, and whether it may spawn children.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                                status,
                                definitions,
                            },
                        },
                    },
                },
            },
        };
        spawn.Classes.Add("primary");
        close.Click += (_, _) => dialog.Close();
        async Task RefreshAsync()
        {
            refresh.IsEnabled = false;
            try
            {
                var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
                var result = await _engine.CallAsync("agent.list", new { includeHidden = false, projectRoot });
                definitions.Text = result is { } value ? FormatAgentDefinitions(value) : "No agent definitions found.";
                status.Text = "Built-in, user, and project agents are resolved locally; later definitions override duplicate names.";
            }
            catch (Exception ex) { status.Text = $"Agent library failed: {ex.Message}"; }
            finally { refresh.IsEnabled = true; }
        }
        create.Click += async (_, _) =>
        {
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            if (string.IsNullOrWhiteSpace(projectRoot)) { status.Text = "Open a project before creating an agent."; return; }
            var name = new TextBox { Watermark = "agent-name (letters, numbers, - or _)", MinWidth = 360 };
            var description = new TextBox { Watermark = "What this agent is for", MinWidth = 360 };
            var model = new ComboBox { ItemsSource = new[] { "sidecar", "main" }, SelectedIndex = 0, MinWidth = 160 };
            var prompt = new TextBox { Watermark = "System instructions", AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 120, MinWidth = 360 };
            var save = new Button { Content = "Create" };
            var cancel = new Button { Content = "Cancel" };
            var createDialog = new Window
            {
                Title = "Create project agent", Width = 560, Height = 520,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Content = new StackPanel
                {
                    Margin = new Avalonia.Thickness(24), Spacing = 12,
                    Children =
                    {
                        new TextBlock { Text = "Create a reusable bounded role without editing config files.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                        name, description, model, prompt,
                        new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { save, cancel } },
                    },
                },
            };
            cancel.Click += (_, _) => createDialog.Close();
            save.Click += (_, _) =>
            {
                var safeName = (name.Text ?? "").Trim();
                if (!System.Text.RegularExpressions.Regex.IsMatch(safeName, "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")) { status.Text = "Agent name must use letters, numbers, '-' or '_' (max 64)."; return; }
                var body = (prompt.Text ?? "").Trim();
                if (body.Length < 8) { status.Text = "Give the agent at least a short system instruction."; return; }
                var folder = Path.Combine(projectRoot, ".kitten", "agents");
                Directory.CreateDirectory(folder);
                var file = Path.Combine(folder, safeName + ".md");
                if (File.Exists(file)) { status.Text = $"Agent '{safeName}' already exists."; return; }
                var safeDescription = (description.Text ?? "").Trim().Replace("\r", " ").Replace("\n", " ");
                var selectedModel = model.SelectedItem?.ToString() == "main" ? "main" : "sidecar";
                File.WriteAllText(file, $"---\nname: {safeName}\ndescription: {safeDescription}\nmode: subagent\nmodel: {selectedModel}\nsteps: 8\npermission: edit=deny,bash=deny,task=deny\nallowSpawn: false\n---\n{body}\n", new UTF8Encoding(false));
                createDialog.Close();
                status.Text = $"Created project agent '{safeName}'.";
                _ = RefreshAsync();
            };
            await createDialog.ShowDialog(this);
        };
        spawn.Click += async (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(_conversationId)) { status.Text = "Create or select a conversation before spawning a subagent."; return; }
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var agentNames = new[] { "explore", "review", "verify", "general" };
            try
            {
                var listed = await _engine.CallAsync("agent.list", new { includeHidden = false, projectRoot });
                if (listed is { } value && value.ValueKind == JsonValueKind.Array)
                {
                    var names = value.EnumerateArray().Select(item => item.TryGetProperty("name", out var name) ? name.GetString() : null).Where(name => !string.IsNullOrWhiteSpace(name)).Cast<string>().ToArray();
                    if (names.Length > 0) agentNames = names;
                }
            }
            catch { /* built-in roles remain available if discovery fails */ }
            var agent = new ComboBox { ItemsSource = agentNames, SelectedIndex = 0, MinWidth = 260 };
            var prompt = new TextBox { Watermark = "Give this subagent a bounded objective...", AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 150, MinWidth = 420 };
            var run = new Button { Content = "Start" };
            var cancelRun = new Button { Content = "Stop", IsEnabled = false };
            var closeRun = new Button { Content = "Close" };
            var runStatus = new TextBlock { Text = "The child conversation is durable and will appear in the main conversation list.", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
            var runId = $"manual-subagent-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
            var subagentDialog = new Window
            {
                Title = "Run Kitten subagent",
                Width = 640,
                Height = 420,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Content = new StackPanel
                {
                    Margin = new Avalonia.Thickness(24), Spacing = 12,
                    Children =
                    {
                        new TextBlock { Text = "Choose a bounded role. The child gets its own durable conversation and reports back to this parent.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                        agent, prompt, runStatus,
                        new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { run, cancelRun, closeRun } },
                    },
                },
            };
            closeRun.Click += async (_, _) =>
            {
                try { await _engine.CallAsync("task.cancel", new { parentRunId = runId }); } catch { }
                subagentDialog.Close();
            };
            cancelRun.Click += async (_, _) =>
            {
                cancelRun.IsEnabled = false;
                runStatus.Text = "Stopping subagent...";
                try { await _engine.CallAsync("task.cancel", new { parentRunId = runId }); } catch (Exception ex) { runStatus.Text = $"Stop failed: {ex.Message}"; }
            };
            run.Click += async (_, _) =>
            {
                var objective = prompt.Text?.Trim() ?? "";
                if (objective.Length < 8) { runStatus.Text = "Give the subagent a more specific objective."; return; }
                run.IsEnabled = false;
                cancelRun.IsEnabled = true;
                runStatus.Text = "Subagent is working; its transcript remains inspectable...";
                try
                {
                    var result = await _engine.CallAsync("task.spawn", new { parentConversationId = _conversationId, parentRunId = runId, agent = agent.SelectedItem?.ToString() ?? "explore", prompt = objective, projectRoot });
                    runStatus.Text = result is { } value ? $"Subagent finished: {JsonSerializer.Serialize(value)}" : "Subagent finished.";
                    cancelRun.IsEnabled = false;
                }
                catch (Exception ex) { runStatus.Text = ex.Message.Contains("cancelled", StringComparison.OrdinalIgnoreCase) ? "Subagent cancelled." : $"Subagent failed: {ex.Message}"; }
                finally { run.IsEnabled = true; cancelRun.IsEnabled = false; }
            };
            await subagentDialog.ShowDialog(this);
        };
        refresh.Click += async (_, _) => await RefreshAsync();
        var dialogTask = dialog.ShowDialog(this);
        await RefreshAsync();
        await dialogTask;
    }

    private static string FormatAgentDefinitions(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() == 0) return "No visible agent definitions found.";
        var cards = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var name = item.TryGetProperty("name", out var nameValue) ? nameValue.GetString() ?? "unnamed" : "unnamed";
            var description = item.TryGetProperty("description", out var descriptionValue) ? descriptionValue.GetString() ?? "" : "";
            var model = item.TryGetProperty("model", out var modelValue) ? modelValue.GetString() ?? "main" : "main";
            var mode = item.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() ?? "subagent" : "subagent";
            var source = item.TryGetProperty("source", out var sourceValue) ? sourceValue.GetString() ?? "local" : "local";
            var steps = item.TryGetProperty("steps", out var stepsValue) && stepsValue.ValueKind == JsonValueKind.Number ? $" · {stepsValue.GetInt32()} steps" : "";
            var permissions = new List<string>();
            if (item.TryGetProperty("permission", out var permission) && permission.ValueKind == JsonValueKind.Object)
            {
                foreach (var key in new[] { "edit", "bash", "task" })
                    if (permission.TryGetProperty(key, out var permissionValue) && permissionValue.ValueKind == JsonValueKind.String) permissions.Add($"{key}:{permissionValue.GetString()}");
            }
            var permissionText = permissions.Count == 0 ? "default permissions" : string.Join(", ", permissions);
            cards.Add($"{name}  ·  {model} / {mode}{steps}\n{description}\n{source}; {permissionText}");
        }
        return cards.Count == 0 ? "No visible agent definitions found." : string.Join("\n\n", cards);
    }

    private async void ExportConversation(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId)) return;
        try
        {
            var result = await _engine.CallAsync("conversation.export", new { id = _conversationId });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("content", out var contentValue) || contentValue.ValueKind != JsonValueKind.String)
            {
                Activity.Text = "Nothing to export yet.";
                return;
            }
            var title = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.Title ?? "kitten-conversation";
            var safeTitle = string.Concat(title.Select(character => Path.GetInvalidFileNameChars().Contains(character) ? '_' : character)).Trim();
            var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                Title = "Export Kitten conversation",
                SuggestedFileName = string.IsNullOrWhiteSpace(safeTitle) ? "kitten-conversation.md" : $"{safeTitle}.md",
                DefaultExtension = "md",
                FileTypeChoices = new[] { new FilePickerFileType("Markdown") { Patterns = new[] { "*.md" } } },
            });
            if (file is null) return;
            await using var stream = await file.OpenWriteAsync();
            await using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            await writer.WriteAsync(contentValue.GetString());
            Activity.Text = $"Conversation exported to {file.Name}";
        }
        catch (Exception ex) { Activity.Text = $"Export failed: {ex.Message}"; }
    }

    private async void ExportDiagnostics(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        try
        {
            Activity.Text = "Collecting redacted diagnostics...";
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("support.bundle", new { projectRoot });
            if (result is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("content", out var contentValue) || contentValue.ValueKind != JsonValueKind.String)
            {
                Activity.Text = "Diagnostics returned no content.";
                return;
            }
            var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                Title = "Export Kitten diagnostics",
                SuggestedFileName = $"kitten-diagnostics-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.txt",
                DefaultExtension = "txt",
                FileTypeChoices = new[] { new FilePickerFileType("Text") { Patterns = new[] { "*.txt" } } },
            });
            if (file is null) return;
            await using var stream = await file.OpenWriteAsync();
            await using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            await writer.WriteAsync(contentValue.GetString());
            Activity.Text = $"Diagnostics exported to {file.Name} (secrets redacted)";
        }
        catch (Exception ex) { Activity.Text = $"Diagnostics export failed: {ex.Message}"; }
    }

    private async void RunSuggestedChecks(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId) || _suggestedCommands.Length == 0) return;
        var root = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
        if (string.IsNullOrWhiteSpace(root)) { Activity.Text = "Open a project before running checks."; return; }
        _activeVerificationId = Guid.NewGuid().ToString("N");
        RunChecksButton.IsEnabled = false;
        CancelChecksButton.IsEnabled = true;
        Activity.Text = "Running bounded verification checks inside Kitten...";
        try
        {
            var result = await _engine.CallAsync("workspace.verify", new { id = _activeVerificationId, root, conversationId = _conversationId, runId = _lastCompletedRunId ?? "verification", commands = _suggestedCommands });
            if (result is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("passed", out var passed) && passed.ValueKind == JsonValueKind.False) Activity.Text = "Verification checks completed with failures; inspect the evidence.";
            else Activity.Text = "Verification checks passed.";
        }
        catch (Exception ex) { Activity.Text = $"Verification failed to run: {ex.Message}"; RunChecksButton.IsEnabled = true; }
        finally { _activeVerificationId = null; CancelChecksButton.IsEnabled = false; }
    }

    private async void CancelSuggestedChecks(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_activeVerificationId)) return;
        CancelChecksButton.IsEnabled = false;
        Activity.Text = "Stopping verification checks...";
        try { await _engine.CallAsync("workspace.verify.cancel", new { id = _activeVerificationId }); }
        catch (Exception ex) { Activity.Text = $"Could not stop verification: {ex.Message}"; }
    }

    private async void OpenTaskBoard(object? sender, RoutedEventArgs e)
    {
        var engine = _engine;
        if (engine is null || string.IsNullOrWhiteSpace(_conversationId)) return;
        var status = new TextBlock { Text = "Durable subagent nodes are loaded from the local store.", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var nodes = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = Avalonia.Media.TextWrapping.Wrap, MinHeight = 360, FontFamily = "Consolas" };
        var refresh = new Button { Content = "Refresh" };
        var resume = new Button { Content = "Resume incomplete plan" };
        var cancel = new Button { Content = "Cancel active plan", IsEnabled = _activeTaskId is not null };
        var close = new Button { Content = "Close" };
        var dialog = new Window
        {
            Title = "Kitten task board",
            Width = 860,
            Height = 640,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 12,
                Children =
                {
                    new TextBlock { Text = "Every node is persisted independently. Select its child conversation from the main list to inspect the full transcript and receipts.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                    status,
                    nodes,
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { refresh, resume, cancel, close } },
                },
            },
        };
        close.Click += (_, _) => dialog.Close();
        cancel.Click += async (_, _) =>
        {
            if (_activeTaskId is null) return;
            cancel.IsEnabled = false;
            try { await engine.CallAsync("task.cancel", new { parentRunId = _activeTaskId }); status.Text = "Cancellation requested; refreshing node states..."; await RefreshAsync(); }
            catch (Exception ex) { status.Text = $"Cancellation failed: {ex.Message}"; }
        };
        resume.Click += async (_, _) =>
        {
            if (_activeTaskId is not null) return;
            resume.IsEnabled = false;
            _activeTaskId = $"task-resume-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
            cancel.IsEnabled = true;
            status.Text = "Resuming incomplete subagent nodes; completed nodes are preserved...";
            try { await engine.CallAsync("task.resume", new { conversationId = _conversationId, parentRunId = _activeTaskId }); status.Text = "Incomplete plan resumed; refresh to inspect durable reports."; }
            catch (Exception ex) { status.Text = $"Resume failed: {ex.Message}"; }
            finally { _activeTaskId = null; cancel.IsEnabled = false; resume.IsEnabled = true; await RefreshAsync(); }
        };
        async Task RefreshAsync()
        {
            refresh.IsEnabled = false;
            try
            {
                var result = await engine.CallAsync("task.list", new { conversationId = _conversationId });
                // Never show the user a JSON literal. An empty plan printed "[]", which is not an answer.
                nodes.Text = DescribeTaskNodes(result);
                status.Text = _activeTaskId is null ? "No active plan." : "Plan running; updates are durable and survive reconnects.";
                cancel.IsEnabled = _activeTaskId is not null;
            }
            catch (Exception ex) { status.Text = $"Task board failed: {ex.Message}"; }
            finally { refresh.IsEnabled = true; }
        }
        refresh.Click += async (_, _) => await RefreshAsync();
        var dialogTask = dialog.ShowDialog(this);
        await RefreshAsync();
        await dialogTask;
    }

    private async void OpenWorkspaceChanges(object? sender, RoutedEventArgs e)
    {
        var engine = _engine;
        if (engine is null) return;
        var root = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
        if (string.IsNullOrWhiteSpace(root))
        {
            Activity.Text = "Open a project before reviewing changes.";
            return;
        }
        var status = new TextBlock { Text = "Reading local changes…", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Classes = { "body" } };
        // Sized to its content: a fixed 120px box around a single changed file is mostly empty space.
        var files = new SelectableTextBlock { FontFamily = new Avalonia.Media.FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 12, TextWrapping = Avalonia.Media.TextWrapping.Wrap };
        var diffBody = DiffBody();
        var diff = new ScrollViewer
        {
            Content = diffBody,
            MinHeight = 380,
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        };
        var refresh = new Button { Content = "Refresh" };
        var close = new Button { Content = "Close" };
        var dialog = new Window
        {
            Title = "Kitten changes",
            Width = 980,
            Height = 760,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 10,
                Children =
                {
                    status,
                    Section("Changed files"),
                    files,
                    Section("Diff"),
                    diff,
                    ButtonRow(refresh, close),
                },
            },
        };
        close.Click += (_, _) => dialog.Close();
        async Task RefreshAsync()
        {
            refresh.IsEnabled = false;
            status.Text = "Reading local changes...";
            try
            {
                var result = await engine.CallAsync("workspace.changes", new { root, maxBytes = 240000, maxFiles = 80 });
                if (result is not { } value || value.ValueKind != JsonValueKind.Object) { status.Text = "No change report returned."; return; }
                var branch = value.TryGetProperty("branch", out var branchValue) && branchValue.ValueKind == JsonValueKind.String ? branchValue.GetString() : null;
                var isGit = value.TryGetProperty("isGit", out var gitValue) && gitValue.GetBoolean();
                var truncated = value.TryGetProperty("truncated", out var truncatedValue) && truncatedValue.GetBoolean();
                // Name the project, not its full path; say plainly whether this is the whole picture.
                var projectName = Path.GetFileName(root!.TrimEnd('\\', '/'));
                status.Text = !isGit
                    ? $"{projectName} is not a Git repository, so there is nothing to diff."
                    : $"{projectName} · {branch ?? "detached HEAD"} · read-only{(truncated ? " · output bounded" : "")}";
                ToolTip.SetTip(status, root);
                var changedText = value.TryGetProperty("files", out var fileValue) && fileValue.ValueKind == JsonValueKind.Array
                    ? string.Join("\n", fileValue.EnumerateArray().Select(item =>
                    {
                        var path = item.TryGetProperty("path", out var pathValue) ? pathValue.GetString() : "?";
                        var change = item.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : "?";
                        return $"{change} {path}";
                    }))
                    : "No changed files.";
                if (value.TryGetProperty("untrackedPreviews", out var previewValue) && previewValue.ValueKind == JsonValueKind.Array)
                {
                    var previews = previewValue.EnumerateArray().Select(item =>
                    {
                        var path = item.TryGetProperty("path", out var pathValue) ? pathValue.GetString() : "?";
                        var content = item.TryGetProperty("content", out var contentValue) ? contentValue.GetString() : "";
                        return $"\n--- untracked preview: {path} ---\n{content}";
                    });
                    changedText += string.Join("\n", previews);
                }
                files.Text = changedText;
                SetDiff(diffBody, value.TryGetProperty("diff", out var diffValue) && diffValue.ValueKind == JsonValueKind.String ? diffValue.GetString() ?? "" : "");
            }
            catch (Exception ex) { status.Text = $"Change inspection failed: {ex.Message}"; }
            finally { refresh.IsEnabled = true; }
        }
        refresh.Click += async (_, _) => await RefreshAsync();
        var dialogTask = dialog.ShowDialog(this);
        await RefreshAsync();
        await dialogTask;
    }

    private async void OpenSidecarToolbox(object? sender, RoutedEventArgs e)
    {
        var engine = _engine;
        if (engine is null) return;
        var jobs = new[]
        {
            "classify_task", "extract_contract", "rank_files", "orient_task", "postflight_review", "select_tests", "compress_context",
            "summarize_output", "cluster_failure", "detect_loop", "review_diff", "audit_evidence",
            "predict_conflict", "prepare_capsule", "title", "progress", "choose_model", "estimate_risk",
            "summarize_diff", "suggest_commands", "explain_error", "map_dependencies", "generate_test_cases",
            "detect_secrets", "triage_logs", "draft_commit", "find_duplicates", "estimate_tokens", "summarize_tree",
        };
        var workflowLabels = new Dictionary<string, string>
        {
            ["task-intake"] = "Task intake",
            ["change-review"] = "Change review",
            ["failure-triage"] = "Failure triage",
            ["release-readiness"] = "Release readiness",
            ["refactor-plan"] = "Refactor plan",
            ["test-hardening"] = "Test hardening",
            ["dependency-audit"] = "Dependency audit",
        };
        var workflows = workflowLabels.Keys.ToArray();
        var job = new ComboBox { ItemsSource = jobs, SelectedIndex = 0, MinWidth = 260 };
        var workflow = new ComboBox { ItemsSource = workflows.Select(id => workflowLabels[id]).ToArray(), SelectedIndex = 0, MinWidth = 220 };
        var input = new TextBox
        {
            Watermark = "Paste a task, diff, error output, file list, or evidence here...",
            AcceptsReturn = true,
            TextWrapping = Avalonia.Media.TextWrapping.Wrap,
            MinHeight = 180,
        };
        var output = new TextBox
        {
            IsReadOnly = true,
            AcceptsReturn = true,
            TextWrapping = Avalonia.Media.TextWrapping.Wrap,
            MinHeight = 220,
            FontFamily = "Consolas",
        };
        var status = new TextBlock { Text = "The sidecar is bounded, JSON-validated, and falls back deterministically if unavailable.", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var run = new Button { Content = "Run sidecar job" };
        var cancel = new Button { Content = "Cancel", IsEnabled = false };
        var runWorkflow = new Button { Content = "Run workflow" };
        var cancelWorkflow = new Button { Content = "Cancel workflow", IsEnabled = false };
        var close = new Button { Content = "Close" };
        string? activeJobId = null;
        string? activeWorkflowId = null;
        var dialog = new Window
        {
            Title = "Kitten sidecar toolbox",
            Width = 780,
            Height = 680,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 12,
                Children =
                {
                    new TextBlock { Text = "Use the 2B–9B model for fast clerical work while the main model stays focused on coding.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { new TextBlock { Text = "Job:", VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center }, job, run, cancel } },
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { new TextBlock { Text = "Workflow:", VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center }, workflow, runWorkflow, cancelWorkflow } },
                    input,
                    status,
                    new TextBlock { Text = "Result", FontWeight = Avalonia.Media.FontWeight.Bold },
                    output,
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { close } },
                },
            },
        };
        close.Click += async (_, _) =>
        {
            if (activeJobId is not null)
            {
                try { await engine.CallAsync("sidecar.cancel", new { id = activeJobId }); status.Text = "Cancelling sidecar job before closing..."; }
                catch { /* the engine may already have completed while the dialog was closing */ }
                activeJobId = null;
            }
            if (activeWorkflowId is not null)
            {
                try { await engine.CallAsync("sidecar.cancel", new { id = activeWorkflowId }); } catch { }
                activeWorkflowId = null;
            }
            dialog.Close();
        };
        cancel.Click += async (_, _) =>
        {
            if (activeJobId is null) return;
            cancel.IsEnabled = false;
            status.Text = "Cancelling sidecar job...";
            try { await engine.CallAsync("sidecar.cancel", new { id = activeJobId }); }
            catch (Exception ex) { status.Text = $"Cancellation failed: {ex.Message}"; }
        };
        run.Click += async (_, _) =>
        {
            var type = job.SelectedItem?.ToString() ?? jobs[0];
            var text = input.Text?.Trim() ?? "";
            if (string.IsNullOrWhiteSpace(text)) { status.Text = "Add some input first."; return; }
            activeJobId = $"desktop-{type}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
            run.IsEnabled = false;
            cancel.IsEnabled = true;
            status.Text = $"Running {type} on the sidecar...";
            try
            {
                var root = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
                if (type is "rank_files" or "select_tests") await engine.CallAsync("workspace.index", new { root });
                var result = await engine.CallAsync("sidecar.run", new
                {
                    id = activeJobId,
                    type,
                    premise = $"Native sidecar toolbox request: {type}",
                    text,
                    query = text,
                    diff = text,
                    output = text,
                    root,
                });
                output.Text = result is { } value ? JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }) : "No result";
                status.Text = $"{type} completed. Treat the result as a bounded aid; execution receipts remain authoritative.";
            }
            catch (Exception ex) { status.Text = ex.Message.Contains("cancelled", StringComparison.OrdinalIgnoreCase) ? "Sidecar job cancelled." : $"Sidecar job failed: {ex.Message}"; }
            finally { activeJobId = null; run.IsEnabled = true; cancel.IsEnabled = false; }
        };
        cancelWorkflow.Click += async (_, _) =>
        {
            if (activeWorkflowId is null) return;
            cancelWorkflow.IsEnabled = false;
            status.Text = "Cancelling sidecar workflow...";
            try { await engine.CallAsync("sidecar.cancel", new { id = activeWorkflowId }); }
            catch (Exception ex) { status.Text = $"Workflow cancellation failed: {ex.Message}"; }
        };
        runWorkflow.Click += async (_, _) =>
        {
            var selectedLabel = workflow.SelectedItem?.ToString();
            var selected = workflowLabels.FirstOrDefault(item => item.Value == selectedLabel).Key ?? workflows[0];
            var text = input.Text?.Trim() ?? "";
            if (string.IsNullOrWhiteSpace(text)) { status.Text = "Add some input first."; return; }
            activeWorkflowId = $"desktop-workflow-{selected}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
            runWorkflow.IsEnabled = false;
            cancelWorkflow.IsEnabled = true;
            run.IsEnabled = false;
            status.Text = $"Running {selected} workflow on the sidecar...";
            try
            {
                var root = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
                var result = await engine.CallAsync("sidecar.workflow", new
                {
                    id = activeWorkflowId,
                    workflow = selected,
                    premise = $"Native sidecar workflow: {selected}",
                    text,
                    query = text,
                    diff = text,
                    output = text,
                    root,
                });
                output.Text = result is { } value ? JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }) : "No result";
                status.Text = $"{selected} workflow completed. Treat every step as advisory; execution receipts remain authoritative.";
            }
            catch (Exception ex) { status.Text = ex.Message.Contains("cancelled", StringComparison.OrdinalIgnoreCase) ? "Sidecar workflow cancelled." : $"Sidecar workflow failed: {ex.Message}"; }
            finally { activeWorkflowId = null; runWorkflow.IsEnabled = true; cancelWorkflow.IsEnabled = false; run.IsEnabled = true; }
        };
        await dialog.ShowDialog(this);
    }

    private async void ConfigureModels(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        var endpoint = new TextBox { Watermark = "OpenAI-compatible endpoint", MinWidth = 420 };
        var sidecarEndpoint = new TextBox { Watermark = "Sidecar endpoint (optional; defaults to the main endpoint)", MinWidth = 420 };
        var main = new TextBox { Watermark = "Main model (35B-200B)", MinWidth = 420 };
        var sidecar = new TextBox { Watermark = "Sidecar model (2B-9B)", MinWidth = 420 };
        var runtimeExecutable = new TextBox { Watermark = "Local runtime executable (for example llama-server.exe)", MinWidth = 420 };
        var mainModelPath = new TextBox { Watermark = "Main model file (.gguf)", MinWidth = 420 };
        var sidecarModelPath = new TextBox { Watermark = "Sidecar model file (.gguf, optional)", MinWidth = 420 };
        var discoverStatus = new TextBlock { Text = "", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var findLocal = new Button { Content = "Find local endpoint" };
        var discover = new Button { Content = "Discover models at endpoint" };
        var importCatalog = new Button { Content = "Import verified catalog JSON" };
        var downloadCatalog = new Button { Content = "Download catalog entries", IsEnabled = false };
        var cancelDownload = new Button { Content = "Cancel download", IsEnabled = false };
        var startRuntime = new Button { Content = "Start local runtime" };
        var stopRuntime = new Button { Content = "Stop local runtime" };
        var runtimeStatus = new TextBlock { Text = "", TextWrapping = Avalonia.Media.TextWrapping.Wrap, Opacity = 0.75 };
        var browseRuntime = new Button { Content = "Browse runtime" };
        var findRuntime = new Button { Content = "Find installed runtime" };
        var browseMainModel = new Button { Content = "Browse main model" };
        var browseSidecarModel = new Button { Content = "Browse sidecar model" };
        JsonElement[] catalogEntries = Array.Empty<JsonElement>();
        string? activeDownloadId = null;
        try
        {
            var selectedProjectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var current = await _engine.CallAsync("settings.inspect", new { projectRoot = selectedProjectRoot });
            if (current is { } value && value.ValueKind == JsonValueKind.Object)
            {
                var models = value.GetProperty("models");
                endpoint.Text = models.GetProperty("baseUrl").GetString();
                if (models.TryGetProperty("sidecarBaseUrl", out var sidecarEndpointValue) && sidecarEndpointValue.ValueKind == JsonValueKind.String) sidecarEndpoint.Text = sidecarEndpointValue.GetString();
                main.Text = models.GetProperty("main").GetString();
                sidecar.Text = models.GetProperty("sidecar").GetString();
                if (value.TryGetProperty("managedRuntime", out var managedRuntime) && managedRuntime.ValueKind == JsonValueKind.Object)
                {
                    if (managedRuntime.TryGetProperty("executable", out var executable) && executable.ValueKind == JsonValueKind.String) runtimeExecutable.Text = executable.GetString();
                    if (managedRuntime.TryGetProperty("mainModelPath", out var mainPath) && mainPath.ValueKind == JsonValueKind.String) mainModelPath.Text = mainPath.GetString();
                    if (managedRuntime.TryGetProperty("sidecarModelPath", out var sidecarPath) && sidecarPath.ValueKind == JsonValueKind.String) sidecarModelPath.Text = sidecarPath.GetString();
                }
            }
        }
        catch { }
        var save = new Button { Content = "Save for this project" };
        var cancel = new Button { Content = "Cancel" };
        // Every field is labelled and every button row wraps. Fixed-width inputs beside non-wrapping
        // button rows overflowed the window: the description, the last button in each row and the Save
        // row were all clipped off the edge, and the two model fields showed bare values with no idea
        // which was which once a watermark had been replaced.
        save.Classes.Add("primary");
        foreach (var input in new[] { endpoint, sidecarEndpoint, main, sidecar, runtimeExecutable, mainModelPath, sidecarModelPath }) input.MinWidth = 260;
        // Each field now carries a label, so a watermark that repeats it is just noise. Keep watermarks
        // only where they add an example.
        endpoint.Watermark = "http://localhost:1234/v1";
        sidecarEndpoint.Watermark = "";
        main.Watermark = "";
        sidecar.Watermark = "";
        runtimeExecutable.Watermark = "";
        mainModelPath.Watermark = "";
        sidecarModelPath.Watermark = "";
        var dialog = new Window
        {
            Title = "Kitten model setup",
            Width = 780,
            Height = 720,
            MinWidth = 560,
            MinHeight = 420,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            // Save and Cancel are docked, not scrolled: the primary action must never be below the fold.
            Content = new DockPanel
            {
                LastChildFill = true,
                Children =
                {
                    new Border
                    {
                        [DockPanel.DockProperty] = Dock.Bottom,
                        Padding = new Avalonia.Thickness(24, 12),
                        BorderThickness = new Avalonia.Thickness(0, 1, 0, 0),
                        BorderBrush = new Avalonia.Media.SolidColorBrush(Avalonia.Media.Color.Parse("#26262e")),
                        Child = ButtonRow(save, cancel),
                    },
                    new ScrollViewer
                    {
                        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
                        Content = new StackPanel
                        {
                            Margin = new Avalonia.Thickness(24),
                            Spacing = 14,
                            Children =
                            {
                        Section("Endpoint"),
                        Hint("Kitten talks to an OpenAI-compatible local server. The sidecar handles clerical work so the main model stays on the code."),
                        Field("Main endpoint", endpoint),
                        Field("Sidecar endpoint (optional — defaults to the main endpoint)", sidecarEndpoint),
                        ButtonRow(findLocal, discover, importCatalog, downloadCatalog, cancelDownload),
                        discoverStatus,
                        Section("Models"),
                        Field("Main model (35B–200B)", main),
                        Field("Sidecar model (2B–9B)", sidecar),
                        Section("Managed local runtime"),
                        Hint("Optional. Point Kitten at a llama.cpp server and it starts and stops it for you — no terminal."),
                        Field("Runtime executable (for example llama-server.exe)", PathRow(runtimeExecutable, browseRuntime, findRuntime)),
                        Field("Main model file (.gguf)", PathRow(mainModelPath, browseMainModel)),
                        Field("Sidecar model file (.gguf, optional)", PathRow(sidecarModelPath, browseSidecarModel)),
                                ButtonRow(startRuntime, stopRuntime),
                                runtimeStatus,
                            },
                        },
                    },
                },
            },
        };
        cancel.Click += async (_, _) =>
        {
            if (activeDownloadId is not null)
            {
                try { await _engine.CallAsync("model.download.cancel", new { id = activeDownloadId }); } catch { }
                activeDownloadId = null;
            }
            dialog.Close();
        };
        cancelDownload.Click += async (_, _) =>
        {
            if (activeDownloadId is null) return;
            cancelDownload.IsEnabled = false;
            discoverStatus.Text = "Cancelling model download...";
            try { await _engine.CallAsync("model.download.cancel", new { id = activeDownloadId }); }
            catch (Exception ex) { discoverStatus.Text = $"Download cancellation failed: {ex.Message}"; }
        };
        async Task PickModelFileAsync(TextBox target)
        {
            var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                AllowMultiple = false,
                Title = "Choose a local model file",
                FileTypeFilter = new[] { new FilePickerFileType("Model files") { Patterns = new[] { "*.gguf", "*.safetensors", "*.bin" } } },
            });
            if (files.Count > 0) target.Text = files[0].Path.LocalPath;
        }
        browseRuntime.Click += async (_, _) =>
        {
            var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                AllowMultiple = false,
                Title = "Choose the local runtime executable",
                FileTypeFilter = new[] { new FilePickerFileType("Executable") { Patterns = new[] { "*.exe", "*" } } },
            });
            if (files.Count > 0) runtimeExecutable.Text = files[0].Path.LocalPath;
        };
        findRuntime.Click += async (_, _) =>
        {
            try
            {
                var found = await _engine.CallAsync("runtime.discover");
                if (found is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("executables", out var executables) && executables.ValueKind == JsonValueKind.Array)
                {
                    var first = executables.EnumerateArray().Select(item => item.GetString()).FirstOrDefault(path => !string.IsNullOrWhiteSpace(path));
                    runtimeExecutable.Text = first ?? runtimeExecutable.Text;
                    runtimeStatus.Text = first is null ? "No installed llama-server was found on PATH. Browse for one or use an OpenAI-compatible endpoint." : $"Found runtime: {first}";
                }
            }
            catch (Exception ex) { runtimeStatus.Text = $"Runtime discovery failed: {ex.Message}"; }
        };
        findLocal.Click += async (_, _) =>
        {
            findLocal.IsEnabled = false;
            discoverStatus.Text = "Checking common local model endpoints...";
            try
            {
                var found = await _engine.CallAsync("model.local-discover", new { timeoutMs = 900 });
                if (found is { } value && value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
                {
                    var first = value.EnumerateArray().FirstOrDefault(item => item.ValueKind == JsonValueKind.Object && item.TryGetProperty("baseUrl", out var url) && url.ValueKind == JsonValueKind.String);
                    if (first.ValueKind == JsonValueKind.Object)
                    {
                        endpoint.Text = first.GetProperty("baseUrl").GetString();
                        var models = first.TryGetProperty("models", out var advertised) && advertised.ValueKind == JsonValueKind.Array
                            ? advertised.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToArray()
                            : Array.Empty<string>();
                        discoverStatus.Text = $"Found local endpoint {endpoint.Text} ({models.Length} advertised model(s)). Click Discover models to populate the tier fields.";
                    }
                }
                else discoverStatus.Text = "No common local endpoint responded. Start LM Studio/llama.cpp or enter an endpoint manually.";
            }
            catch (Exception ex) { discoverStatus.Text = $"Local endpoint scan failed: {ex.Message}"; }
            finally { findLocal.IsEnabled = true; }
        };
        browseMainModel.Click += async (_, _) => await PickModelFileAsync(mainModelPath);
        browseSidecarModel.Click += async (_, _) => await PickModelFileAsync(sidecarModelPath);
        startRuntime.Click += async (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(runtimeExecutable.Text) || string.IsNullOrWhiteSpace(mainModelPath.Text))
            {
                runtimeStatus.Text = "Choose the runtime executable and main model file first.";
                return;
            }
            startRuntime.IsEnabled = false;
            runtimeStatus.Text = "Starting the managed local runtime and checking its endpoint...";
            try
            {
                var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
                var result = await _engine.CallAsync("runtime.start", new
                {
                    executable = runtimeExecutable.Text,
                    mainModelPath = mainModelPath.Text,
                    sidecarModelPath = string.IsNullOrWhiteSpace(sidecarModelPath.Text) ? null : sidecarModelPath.Text,
                    baseUrl = endpoint.Text,
                    sidecarBaseUrl = string.IsNullOrWhiteSpace(sidecarEndpoint.Text) ? null : sidecarEndpoint.Text,
                    projectRoot,
                });
                var reachable = result is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("probe", out var probe) && probe.TryGetProperty("reachable", out var isReachable) && isReachable.GetBoolean();
                runtimeStatus.Text = reachable ? "Managed runtime is running and responding." : "Runtime started, but its endpoint did not respond.";
                await RefreshModelStatusAsync();
            }
            catch (Exception ex) { runtimeStatus.Text = $"Runtime start failed: {ex.Message}"; }
            finally { startRuntime.IsEnabled = true; }
        };
        stopRuntime.Click += async (_, _) =>
        {
            stopRuntime.IsEnabled = false;
            try
            {
                await _engine.CallAsync("runtime.stop");
                runtimeStatus.Text = "Managed runtime stopped.";
                await RefreshModelStatusAsync();
            }
            catch (Exception ex) { runtimeStatus.Text = $"Runtime stop failed: {ex.Message}"; }
            finally { stopRuntime.IsEnabled = true; }
        };
        discover.Click += async (_, _) =>
        {
            discover.IsEnabled = false;
            discoverStatus.Text = "Contacting the local model endpoint...";
            try
            {
                var found = await _engine.CallAsync("model.discover", new { baseUrl = endpoint.Text });
                if (found is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Array)
                {
                    var ids = models.EnumerateArray().Select(item => item.TryGetProperty("id", out var id) ? id.GetString() : null).Where(id => !string.IsNullOrWhiteSpace(id)).Cast<string>().ToArray();
                    if (ids.Length > 0)
                    {
                        // Never trust provider ordering: a local endpoint often advertises the
                        // lightweight model first. Prefer known-size candidates that fit Kitten's
                        // lanes, while retaining unknown-size IDs for providers that omit parameter
                        // counts. The server applies the same contract when settings are saved.
                        var discoveredMain = ids.FirstOrDefault(id => BakeoffRoleForModel(id) == "main") ?? ids.FirstOrDefault(id => BakeoffRoleForModel(id) is null) ?? ids[0];
                        var discoveredSidecar = ids.FirstOrDefault(id => BakeoffRoleForModel(id) == "sidecar" && !string.Equals(id, discoveredMain, StringComparison.OrdinalIgnoreCase));
                        main.Text = discoveredMain;
                        if (string.IsNullOrWhiteSpace(sidecar.Text) || sidecar.Text == "none") sidecar.Text = discoveredSidecar ?? sidecar.Text;
                        var mainLabel = discoveredMain;
                        var sidecarLabel = discoveredSidecar is null ? "no known sidecar candidate" : discoveredSidecar;
                        discoverStatus.Text = $"Found {ids.Length} model(s). Suggested main: {mainLabel}; sidecar: {sidecarLabel}. Review before saving.";
                    }
                    else discoverStatus.Text = "The endpoint responded, but did not advertise any models.";
                }
                else discoverStatus.Text = "The endpoint could not be queried. Check that the local runtime is running.";
            }
            catch (Exception ex) { discoverStatus.Text = $"Discovery failed: {ex.Message}"; }
            finally { discover.IsEnabled = true; }
        };
        importCatalog.Click += async (_, _) =>
        {
            var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                AllowMultiple = false,
                Title = "Import Kitten model catalog",
                FileTypeFilter = new[] { new FilePickerFileType("JSON catalog") { Patterns = new[] { "*.json" } } },
            });
            if (files.Count == 0) return;
            try
            {
                await using var stream = await files[0].OpenReadAsync();
                using var reader = new StreamReader(stream);
                var raw = await reader.ReadToEndAsync();
                var catalog = await _engine.CallAsync("model.catalog", new { raw });
                if (catalog is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("catalog contains no entries");
                var parsed = entries.EnumerateArray().ToArray();
                catalogEntries = parsed;
                downloadCatalog.IsEnabled = parsed.Length > 0;
                var mainEntry = parsed.FirstOrDefault(entry => entry.TryGetProperty("role", out var role) && role.GetString() == "main");
                var sidecarEntry = parsed.FirstOrDefault(entry => entry.TryGetProperty("role", out var role) && role.GetString() == "sidecar");
                if (mainEntry.ValueKind == JsonValueKind.Object && mainEntry.TryGetProperty("id", out var mainId)) main.Text = mainId.GetString();
                if (sidecarEntry.ValueKind == JsonValueKind.Object && sidecarEntry.TryGetProperty("id", out var sidecarId)) sidecar.Text = sidecarId.GetString();
                discoverStatus.Text = $"Imported {parsed.Length} verified catalog entr{(parsed.Length == 1 ? "y" : "ies")}. Review the selected tiers, then save.";
            }
            catch (Exception ex) { discoverStatus.Text = $"Catalog import failed: {ex.Message}"; }
        };
        downloadCatalog.Click += async (_, _) =>
        {
            if (catalogEntries.Length == 0) return;
            var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { AllowMultiple = false, Title = "Choose where to store downloaded models" });
            if (folders.Count == 0) return;
            downloadCatalog.IsEnabled = false;
            cancelDownload.IsEnabled = true;
            try
            {
                var folder = folders[0].Path.LocalPath;
                for (var index = 0; index < catalogEntries.Length; index++)
                {
                    var entry = catalogEntries[index];
                    var id = entry.TryGetProperty("id", out var idValue) ? idValue.GetString() ?? $"model-{index + 1}" : $"model-{index + 1}";
                    var format = entry.TryGetProperty("format", out var formatValue) ? formatValue.GetString() : "gguf";
                    var safeName = string.Concat(id.Select(character => Path.GetInvalidFileNameChars().Contains(character) || character is '/' or '\\' ? '_' : character));
                    var destination = Path.Combine(folder, $"{safeName}.{(format == "safetensors" ? "safetensors" : "gguf")}");
                    activeDownloadId = $"catalog-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{index}";
                    Activity.Text = $"Downloading catalog model {index + 1}/{catalogEntries.Length}: {id}";
                    await _engine.CallAsync("model.download", new { id = activeDownloadId, entry, destination });
                    var role = entry.TryGetProperty("role", out var roleValue) ? roleValue.GetString() : null;
                    if (string.Equals(role, "main", StringComparison.OrdinalIgnoreCase)) mainModelPath.Text = destination;
                    else if (string.Equals(role, "sidecar", StringComparison.OrdinalIgnoreCase)) sidecarModelPath.Text = destination;
                }
                discoverStatus.Text = $"Downloaded {catalogEntries.Length} catalog model(s) with checksum verification.";
            }
            catch (Exception ex) { discoverStatus.Text = ex.Message.Contains("cancel", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("abort", StringComparison.OrdinalIgnoreCase) ? "Model download cancelled." : $"Model download failed: {ex.Message}"; }
            finally { activeDownloadId = null; downloadCatalog.IsEnabled = true; cancelDownload.IsEnabled = false; }
        };
        save.Click += async (_, _) =>
        {
            try
            {
                var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
                await _engine.CallAsync("settings.update", new
                {
                    scope = "project",
                    projectRoot,
                    update = new
                    {
                        baseUrl = endpoint.Text,
                        sidecarBaseUrl = string.IsNullOrWhiteSpace(sidecarEndpoint.Text) ? null : sidecarEndpoint.Text,
                        mainModel = main.Text,
                        sidecarModel = sidecar.Text,
                        runtimeExecutable = string.IsNullOrWhiteSpace(runtimeExecutable.Text) ? null : runtimeExecutable.Text,
                        mainModelPath = string.IsNullOrWhiteSpace(mainModelPath.Text) ? null : mainModelPath.Text,
                        sidecarModelPath = string.IsNullOrWhiteSpace(sidecarModelPath.Text) ? null : sidecarModelPath.Text,
                    },
                });
                await RefreshModelStatusAsync();
                Activity.Text = "Model settings saved";
                dialog.Close();
            }
            catch (Exception ex) { Activity.Text = $"Could not save model settings: {ex.Message}"; }
        };
        await dialog.ShowDialog(this);
    }

    private async void SelectConversation(object? sender, SelectionChangedEventArgs e)
    {
        if (ConversationList.SelectedItem is ConversationItem item) await ActivateConversationAsync(item);
    }

    private async Task ActivateConversationAsync(ConversationItem item)
    {
        if (_engine is null || _loadingConversation || _conversationId == item.Id) return;
        _loadingConversation = true;
        try
        {
            _conversationId = item.Id;
            _lastPlanRequest = null;
            _suggestedCommands = Array.Empty<string>();
            _activeVerificationId = null;
            RunChecksButton.IsEnabled = false;
            CancelChecksButton.IsEnabled = false;
            SetProject(item.ProjectRoot);
            _activeRunId = null;
            _lastCompletedRunId = null;
            UndoButton.IsEnabled = false;
            RedoButton.IsEnabled = false;
            ResetApproval();
            var events = await _engine.CallAsync("conversation.events", new { id = item.Id });
            Evidence.Text = "Verified receipts will appear here.";
            RenderHistory(events);
            if (!string.IsNullOrWhiteSpace(item.ProjectRoot))
            {
                try { await _engine.CallAsync("runtime.ensure", new { projectRoot = item.ProjectRoot }); } catch { /* runtime setup remains available from Model settings */ }
            }
            await RefreshModelStatusAsync();
            await RefreshBakeoffHistoryAsync(item.ProjectRoot);
            _canResumeInterrupted = HasInterruptedRun(events);
            ResumeButton.IsEnabled = _canResumeInterrupted;
            Activity.Text = "Ready";
            SetRunControls(false);
        }
        finally { _loadingConversation = false; }
    }

    private static bool HasInterruptedRun(JsonElement? events)
    {
        if (events is not { } value || value.ValueKind != JsonValueKind.Array) return false;
        var states = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var frame in value.EnumerateArray())
        {
            if (!frame.TryGetProperty("runId", out var idValue) || idValue.ValueKind != JsonValueKind.String || !frame.TryGetProperty("type", out var typeValue)) continue;
            var id = idValue.GetString() ?? "";
            var type = typeValue.GetString() ?? "";
            if (type is "run.interrupted" or "run.completed" or "run.failed" or "run.cancelled") states[id] = type;
        }
        return states.Values.Any(type => type == "run.interrupted");
    }

    private void RenderHistory(JsonElement? events)
    {
        if (events is null || events.Value.ValueKind != JsonValueKind.Array) return;
        var text = new StringBuilder();
        var streamedRuns = new HashSet<string>();
        var replayedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? historicReceipt = null;
        string? historicPostflight = null;
        string? historicVerificationOutputText = null;
        foreach (var frame in events.Value.EnumerateArray())
        {
            var type = frame.TryGetProperty("type", out var typeValue) ? typeValue.GetString() ?? "" : "";
            var runId = frame.TryGetProperty("runId", out var runValue) ? runValue.GetString() ?? "" : "";
            switch (type)
            {
                case "user.message":
                    if (frame.TryGetProperty("text", out var user)) text.Append($"You: {user.GetString()}\n\n");
                    break;
                case "assistant.final":
                    if (!streamedRuns.Contains(runId))
                    {
                        if (frame.TryGetProperty("text", out var assistant)) text.Append($"Kitten: {assistant.GetString()}\n\n");
                    }
                    else text.Append("\n\n");
                    break;
                case "assistant.delta":
                    if (!streamedRuns.Contains(runId)) { text.Append("Kitten: "); streamedRuns.Add(runId); }
                    if (frame.TryGetProperty("text", out var delta)) text.Append(delta.GetString() ?? "");
                    break;
                case "tool.completed":
                    // Replayed history has to show the work, not just the conclusion.
                    text.Append(TranscriptView.ToolLine(
                        frame.TryGetProperty("name", out var toolName) ? toolName.GetString() ?? "tool" : "tool",
                        frame.TryGetProperty("target", out var toolTarget) ? toolTarget.GetString() ?? "" : "",
                        !frame.TryGetProperty("ok", out var toolOk) || toolOk.ValueKind != JsonValueKind.False,
                        frame.TryGetProperty("durationMs", out var toolMs) && toolMs.ValueKind == JsonValueKind.Number ? toolMs.GetInt64() : 0,
                        frame.TryGetProperty("output", out var toolOutput) ? toolOutput.GetString() ?? "" : ""));
                    break;
                case "file.changed":
                    // Changed files belong to the CHANGES panel; appending them to the transcript text
                    // merged them into whichever card was open (the user's own message, typically).
                    if (frame.TryGetProperty("path", out var path)) replayedFiles.Add(path.GetString() ?? "");
                    break;
                case "receipt.finalized":
                    // A replayed session has receipts; the panel used to claim they would "appear after a
                    // run" while the evidence for that very run sat unread in the event log.
                    if (frame.TryGetProperty("lines", out var replayReceipt) && replayReceipt.ValueKind == JsonValueKind.Array)
                    {
                        var lines = replayReceipt.EnumerateArray().Where(line => line.ValueKind == JsonValueKind.String).Select(line => line.GetString() ?? "").Where(line => line.Length > 0).ToArray();
                        if (lines.Length > 0) historicReceipt = string.Join("\n", lines);
                    }
                    break;
                case "run.completed":
                    var historicVerified = frame.TryGetProperty("verified", out var historicVerifiedValue) && historicVerifiedValue.ValueKind == JsonValueKind.True;
                    var historicFinished = frame.TryGetProperty("finished", out var historicFinishedValue) && historicFinishedValue.ValueKind == JsonValueKind.True;
                    var historicGrade = historicVerified ? "✓ verified" : historicFinished ? "~ checked" : "• unverified";
                    var historicSummary = frame.TryGetProperty("summary", out var historicSummaryValue) ? historicSummaryValue.GetString() : "";
                    var historicWall = frame.TryGetProperty("wallMs", out var historicWallValue) && historicWallValue.ValueKind == JsonValueKind.Number ? frame.GetProperty("wallMs").GetInt64() : 0;
                    _lastCompletedRunId = runId;
                    text.Append($"Outcome: {historicGrade} · {Duration(historicWall)}\n{historicSummary}\n\n");
                    break;
                case "run.failed":
                    text.Append($"Outcome: failed — {(frame.TryGetProperty("error", out var historicError) ? historicError.GetString() : "unknown error")}\n\n");
                    break;
                case "run.cancelled":
                    text.Append("Outcome: stopped by you\n\n");
                    break;
                case "run.interrupted":
                    // Replayed history has to account for every run it started. An interrupted run used
                    // to leave a user message with nothing after it, as if the request had been ignored.
                    text.Append("Outcome: interrupted — Kitten closed while this run was in flight. Nothing was left running; use Resume to continue.\n\n");
                    break;
                case "sidecar.postflight":
                    var historicSecrets = ReadStringArray(frame, "secrets");
                    var historicWarnings = ReadStringArray(frame, "warnings");
                    var historicEvidenceWarnings = ReadStringArray(frame, "evidenceWarnings");
                    var historicRecommendedTests = ReadStringArray(frame, "recommendedTests");
                    var historicSuggestedCommands = ReadStringArray(frame, "suggestedCommands");
                    var historicRisk = frame.TryGetProperty("risk", out var historicRiskValue) ? historicRiskValue.GetString() : "low";
                    var historicRiskReasons = ReadStringArray(frame, "riskReasons");
                    var historicTestCases = ReadStringArray(frame, "generatedTestCases");
                    _suggestedCommands = historicSuggestedCommands;
                    RunChecksButton.IsEnabled = historicSuggestedCommands.Length > 0;
                    var historicSource = frame.TryGetProperty("source", out var historicSourceValue) ? historicSourceValue.GetString() : "deterministic";
                    text.Append($"Sidecar postflight ({historicSource})\n");
                    if (historicSecrets.Length > 0) text.Append($"Possible secrets: {string.Join(", ", historicSecrets)}\n");
                    if (historicWarnings.Length > 0) text.Append($"Review warnings: {string.Join("; ", historicWarnings)}\n");
                    if (historicEvidenceWarnings.Length > 0) text.Append($"Evidence notes: {string.Join("; ", historicEvidenceWarnings)}\n");
                    if (historicRecommendedTests.Length > 0) text.Append($"Recommended tests: {string.Join(", ", historicRecommendedTests)}\n");
                    text.Append($"Risk: {historicRisk}{(historicRiskReasons.Length > 0 ? $" ({string.Join(", ", historicRiskReasons)})" : "")}\n");
                    if (historicTestCases.Length > 0) text.Append($"Generated edge cases: {string.Join("; ", historicTestCases)}\n");
                    if (historicSuggestedCommands.Length > 0) text.Append($"Suggested commands: {string.Join(" · ", historicSuggestedCommands)}\n");
                    text.Append("\n");
                    historicPostflight = $"Sidecar postflight ({historicSource})\n" + (historicSecrets.Length > 0 ? $"Possible secrets: {string.Join(", ", historicSecrets)}\n" : "No credential patterns detected.\n") + (historicWarnings.Length > 0 ? $"Review warnings: {string.Join("; ", historicWarnings)}\n" : "No diff warnings.\n") + (historicEvidenceWarnings.Length > 0 ? $"Evidence notes: {string.Join("; ", historicEvidenceWarnings)}\n" : "Evidence packet present.\n") + (historicRecommendedTests.Length > 0 ? $"Recommended tests: {string.Join(", ", historicRecommendedTests)}\n" : "") + (historicSuggestedCommands.Length > 0 ? $"Suggested commands: {string.Join(" · ", historicSuggestedCommands)}" : "");
                    break;
                case "sidecar.failure":
                    var historicFailureSource = frame.TryGetProperty("source", out var historicFailureSourceValue) ? historicFailureSourceValue.GetString() : "deterministic";
                    var historicFailureSeverity = frame.TryGetProperty("severity", out var historicFailureSeverityValue) ? historicFailureSeverityValue.GetString() : "error";
                    var historicFailureSignature = frame.TryGetProperty("signature", out var historicFailureSignatureValue) ? historicFailureSignatureValue.GetString() : "unknown failure";
                    var historicFailureCause = frame.TryGetProperty("likelyCause", out var historicFailureCauseValue) ? historicFailureCauseValue.GetString() : "inspect the failure";
                    var historicFailureLines = ReadStringArray(frame, "salientLines");
                    text.Append($"Sidecar failure card ({historicFailureSource}, {historicFailureSeverity})\nSignature: {historicFailureSignature}\nLikely cause: {historicFailureCause}\n");
                    if (historicFailureLines.Length > 0) text.Append($"Salient lines: {string.Join(" | ", historicFailureLines)}\n");
                    text.Append("\n");
                    historicPostflight = $"Sidecar failure card ({historicFailureSource}, {historicFailureSeverity})\nSignature: {historicFailureSignature}\nLikely cause: {historicFailureCause}" + (historicFailureLines.Length > 0 ? $"\nSalient lines: {string.Join(" | ", historicFailureLines)}" : "");
                    break;
                case "workspace.verification":
                    var historicVerificationPassed = frame.TryGetProperty("passed", out var verificationPassedValue) && verificationPassedValue.ValueKind == JsonValueKind.True;
                    var historicVerificationCancelled = frame.TryGetProperty("cancelled", out var verificationCancelledValue) && verificationCancelledValue.ValueKind == JsonValueKind.True;
                    var historicVerificationCommands = ReadStringArray(frame, "commands");
                    var historicVerificationOutput = ReadVerificationOutput(frame);
                    historicVerificationOutputText = historicVerificationOutput;
                    text.Append($"Native verification {(historicVerificationCancelled ? "cancelled" : historicVerificationPassed ? "passed" : "failed")}: {string.Join(" · ", historicVerificationCommands)}\n\n");
                    historicPostflight = $"Native verification {(historicVerificationCancelled ? "cancelled" : historicVerificationPassed ? "passed" : "failed")}\nCommands: {string.Join(" · ", historicVerificationCommands)}";
                    break;
            }
        }
        _transcript.Replay(text.ToString());
        // A replayed session reports the files that session touched, instead of claiming "no changes".
        SetChangesSummary(replayedFiles.Count, 0, 0);
        if (historicPostflight is not null && !string.IsNullOrWhiteSpace(historicVerificationOutputText)) historicPostflight += $"\n\n{historicVerificationOutputText}";
        // The run's own receipt is the primary evidence; a sidecar postflight review adds to it.
        var evidence = string.Join("\n\n", new[] { historicReceipt, historicPostflight }.Where(entry => !string.IsNullOrWhiteSpace(entry)));
        if (!string.IsNullOrWhiteSpace(evidence)) Evidence.Text = evidence;
        _assistantStreamed = false;
    }

    private static string[] ReadStringArray(JsonElement frame, string property)
    {
        if (!frame.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array) return Array.Empty<string>();
        return value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString() ?? "").Where(item => !string.IsNullOrWhiteSpace(item)).ToArray();
    }

    private static string ReadVerificationOutput(JsonElement frame)
    {
        if (!frame.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return "";
        var lines = new List<string>();
        foreach (var result in results.EnumerateArray())
        {
            var command = result.TryGetProperty("command", out var commandValue) ? commandValue.GetString() : "check";
            var passed = result.TryGetProperty("passed", out var passedValue) && passedValue.ValueKind == JsonValueKind.True;
            var output = result.TryGetProperty("output", out var outputValue) && outputValue.ValueKind == JsonValueKind.String ? outputValue.GetString() : "";
            lines.Add($"[{(passed ? "pass" : "fail")}] {command}\n{output}");
        }
        return string.Join("\n", lines).Trim().Length > 12_000 ? string.Join("\n", lines).Trim()[^12_000..] : string.Join("\n", lines).Trim();
    }

    private void OnEngineDisconnected(Exception? error)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var lost = _engine;
            _engine = null;
            SetEngineState(EngineState.Failed, "Engine disconnected");
            Activity.Text = $"The local engine stopped; no new work will start. Click Retry engine to reconnect.{(error is null ? "" : $" ({error.Message})")}";
            RetryEngineButton.IsEnabled = true;
            _ = lost?.DisposeAsync();
            // A broken pipe does not guarantee that the child process exited. Dispose the process
            // wrapper too, otherwise RetryEngine could see a still-live stale child and never spawn
            // a fresh engine for the new pipe connection.
            _engineProcess.Dispose();
        });
    }

    private void OnEngineEvent(JsonElement frame)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var type = frame.TryGetProperty("type", out var typeValue) ? typeValue.GetString() ?? "" : "";
            var progressPayload = frame.TryGetProperty("payload", out var progressValue) ? progressValue : default;
            if (type == "model.download.progress" && progressPayload.ValueKind == JsonValueKind.Object)
            {
                var phase = progressPayload.TryGetProperty("phase", out var phaseValue) ? phaseValue.GetString() : "downloading";
                var received = progressPayload.TryGetProperty("receivedBytes", out var receivedValue) ? receivedValue.GetInt64() : 0;
                var total = progressPayload.TryGetProperty("totalBytes", out var totalValue) && totalValue.ValueKind == JsonValueKind.Number ? totalValue.GetInt64() : 0;
                Activity.Text = total > 0 ? $"Model {phase}: {received / 1_048_576.0:0.0} / {total / 1_048_576.0:0.0} MB" : $"Model {phase}: {received / 1_048_576.0:0.0} MB";
                return;
            }
            if (type == "model.bakeoff.progress" && progressPayload.ValueKind == JsonValueKind.Object)
            {
                var phase = progressPayload.TryGetProperty("phase", out var bakeoffPhase) ? bakeoffPhase.GetString() : "probe";
                var status = progressPayload.TryGetProperty("status", out var bakeoffStatus) ? bakeoffStatus.GetString() : "started";
                var role = progressPayload.TryGetProperty("role", out var bakeoffRole) ? bakeoffRole.GetString() : "tier";
                var model = progressPayload.TryGetProperty("model", out var bakeoffModel) ? bakeoffModel.GetString() : "model";
                var taskId = progressPayload.TryGetProperty("taskId", out var bakeoffTask) ? bakeoffTask.GetString() : "task";
                var taskIndex = progressPayload.TryGetProperty("taskIndex", out var bakeoffTaskIndex) ? bakeoffTaskIndex.GetInt32() : 0;
                var taskTotal = progressPayload.TryGetProperty("taskTotal", out var bakeoffTaskTotal) ? bakeoffTaskTotal.GetInt32() : 0;
                if (status == "completed")
                {
                    var passed = progressPayload.TryGetProperty("passed", out var passedValue) ? passedValue.GetInt32() : 0;
                    var totalCases = progressPayload.TryGetProperty("total", out var totalValue) ? totalValue.GetInt32() : 0;
                    var ok = progressPayload.TryGetProperty("ok", out var okValue) && okValue.ValueKind == JsonValueKind.True;
                    Activity.Text = $"Bakeoff {phase}: {role} {model} — {taskId} {taskIndex}/{taskTotal} {(ok ? $"passed ({passed}/{totalCases})" : $"needs review ({passed}/{totalCases})")}";
                }
                else Activity.Text = $"Bakeoff {phase}: {role} {model} — {taskId} {taskIndex}/{taskTotal} running...";
                return;
            }
            var eventConversation = frame.TryGetProperty("conversationId", out var conversation) ? conversation.GetString() : null;
            if (eventConversation is not null && eventConversation != _conversationId) return;
            var payload = frame.TryGetProperty("payload", out var payloadValue) ? payloadValue : default;
            var runId = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("runId", out var rid) ? rid.GetString() : null;
            switch (type)
            {
                case "conversation.renamed":
                    Activity.Text = payload.TryGetProperty("title", out var renamedTitle) ? $"Conversation titled: {renamedTitle.GetString()}" : "Conversation renamed";
                    _ = RefreshConversationsAsync(_conversationId);
                    break;
                case "sidecar.preflight":
                    var phase = payload.TryGetProperty("phase", out var preflightPhase) ? preflightPhase.GetString() : "started";
                    Activity.Text = phase switch { "ready" => "Sidecar orientation ready; starting main model", "fallback" => "Sidecar unavailable; using deterministic orientation", _ => "Sidecar is orienting the task..." };
                    break;
                case "sidecar.postflight":
                    var secrets = payload.TryGetProperty("secrets", out var secretValue) && secretValue.ValueKind == JsonValueKind.Array ? secretValue.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() : Array.Empty<string>();
                    var warnings = payload.TryGetProperty("warnings", out var warningValue) && warningValue.ValueKind == JsonValueKind.Array ? warningValue.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() : Array.Empty<string>();
                    var evidenceWarnings = payload.TryGetProperty("evidenceWarnings", out var evidenceValue) && evidenceValue.ValueKind == JsonValueKind.Array ? evidenceValue.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() : Array.Empty<string>();
                    var recommendedTests = ReadStringArray(payload, "recommendedTests");
                    var suggestedCommands = ReadStringArray(payload, "suggestedCommands");
                    var postflightRisk = payload.TryGetProperty("risk", out var postflightRiskValue) ? postflightRiskValue.GetString() : "low";
                    var postflightRiskReasons = ReadStringArray(payload, "riskReasons");
                    var postflightTestCases = ReadStringArray(payload, "generatedTestCases");
                    var postflightSource = payload.TryGetProperty("source", out var sourceValue) ? sourceValue.GetString() : "deterministic";
                    Activity.Text = secrets.Length > 0 ? "Postflight warning: possible secret material" : warnings.Length > 0 ? "Postflight review found a warning" : "Postflight review complete";
                    Evidence.Text += $"\nSidecar postflight ({postflightSource}):\n" + (secrets.Length > 0 ? $"Possible secrets: {string.Join(", ", secrets)}\n" : "No credential patterns detected.\n") + (warnings.Length > 0 ? $"Review warnings: {string.Join("; ", warnings)}\n" : "No diff warnings.\n") + (evidenceWarnings.Length > 0 ? $"Evidence notes: {string.Join("; ", evidenceWarnings)}\n" : "Evidence packet present.\n") + $"Risk: {postflightRisk}{(postflightRiskReasons.Length > 0 ? $" ({string.Join(", ", postflightRiskReasons)})" : "")}";
                    if (recommendedTests.Length > 0) Evidence.Text += $"\nRecommended tests: {string.Join(", ", recommendedTests)}";
                    if (postflightTestCases.Length > 0) Evidence.Text += $"\nGenerated edge cases: {string.Join("; ", postflightTestCases)}";
                    if (suggestedCommands.Length > 0) Evidence.Text += $"\nSuggested commands: {string.Join(" · ", suggestedCommands)}";
                    _suggestedCommands = suggestedCommands;
                    RunChecksButton.IsEnabled = suggestedCommands.Length > 0;
                    break;
                case "sidecar.failure":
                    var failureSource = payload.TryGetProperty("source", out var failureSourceValue) ? failureSourceValue.GetString() : "deterministic";
                    var failureSeverity = payload.TryGetProperty("severity", out var failureSeverityValue) ? failureSeverityValue.GetString() : "error";
                    var failureSignature = payload.TryGetProperty("signature", out var failureSignatureValue) ? failureSignatureValue.GetString() : "unknown failure";
                    var failureCause = payload.TryGetProperty("likelyCause", out var failureCauseValue) ? failureCauseValue.GetString() : "inspect the failure";
                    var failureLines = ReadStringArray(payload, "salientLines");
                    Activity.Text = "Sidecar failure card ready";
                    Evidence.Text += $"\nFailure card ({failureSource}, {failureSeverity})\nSignature: {failureSignature}\nLikely cause: {failureCause}" + (failureLines.Length > 0 ? $"\nSalient lines: {string.Join(" | ", failureLines)}" : "");
                    break;
                case "workspace.verification":
                    var verificationPassed = payload.TryGetProperty("passed", out var verificationPassedValue) && verificationPassedValue.ValueKind == JsonValueKind.True;
                    var verificationCancelled = payload.TryGetProperty("cancelled", out var verificationCancelledValue) && verificationCancelledValue.ValueKind == JsonValueKind.True;
                    var verificationCommands = ReadStringArray(payload, "commands");
                    Activity.Text = verificationCancelled ? "Verification cancelled" : verificationPassed ? "Suggested verification passed" : "Suggested verification failed";
                    Evidence.Text += $"\nNative verification {(verificationCancelled ? "cancelled" : verificationPassed ? "passed" : "failed")}: {string.Join(" · ", verificationCommands)}";
                    _activeVerificationId = null;
                    CancelChecksButton.IsEnabled = false;
                    RunChecksButton.IsEnabled = _suggestedCommands.Length > 0;
                    break;
                case "run.started":
                    _activeRunId = runId;
                    ResumeButton.IsEnabled = false;
                    _assistantStreamed = false;
                    _activeRunFiles.Clear();
                    _activeRunAdded = 0;
                    _activeRunRemoved = 0;
                    Activity.Text = runId is null ? "Run started" : $"Run {ShortId(runId)} started";
                    // The panels describe THIS run. Leaving the previous run's receipt and file count on
                    // screen while a new one is in flight reads as if they belong to it.
                    Evidence.Text = "Receipts appear as this run produces them.";
                    SetChangesSummary(0, 0, 0);
                    SetComposerHint("");
                    SetRunControls(true);
                    break;
                case "reasoning.delta":
                    // The card already reads "thinking…" from the moment it opens; this only confirms
                    // in the run panel that the model is reasoning. The reasoning itself is never shown.
                    Activity.Text = "Thinking…";
                    break;
                case "assistant.delta":
                    if (payload.TryGetProperty("text", out var delta))
                    {
                        _transcript.AppendAssistant(delta.GetString() ?? "");
                        _assistantStreamed = true;
                    }
                    break;
                case "assistant.final":
                    // A non-streaming lane delivers the whole answer at once; either way the card closes here.
                    if (!_assistantStreamed && payload.TryGetProperty("text", out var finalText)) _transcript.CompleteAssistant(finalText.GetString() ?? "");
                    else if (_transcript.IsStreaming) _transcript.CompleteAssistant();
                    _assistantStreamed = false;
                    break;
                case "file.changed":
                    if (payload.TryGetProperty("path", out var changedPath)) _activeRunFiles.Add(changedPath.GetString() ?? "");
                    if (payload.TryGetProperty("added", out var added) && added.ValueKind == JsonValueKind.Number) _activeRunAdded += added.GetInt32();
                    if (payload.TryGetProperty("removed", out var removed) && removed.ValueKind == JsonValueKind.Number) _activeRunRemoved += removed.GetInt32();
                    break;
                case "receipt.finalized":
                    if (payload.TryGetProperty("filesChanged", out var receiptFiles) && receiptFiles.ValueKind == JsonValueKind.Array)
                        foreach (var file in receiptFiles.EnumerateArray()) if (file.ValueKind == JsonValueKind.String) _activeRunFiles.Add(file.GetString() ?? "");
                    break;
                case "tool.started": Activity.Text = payload.TryGetProperty("name", out var tool) ? $"Using {tool.GetString()}" : "Running tool"; break;
                case "tool.completed":
                    // The step lands in the transcript the moment it finishes, so the conversation shows
                    // the actual work — which files were read, what was edited, which command ran.
                    _transcript.AddTool(
                        payload.TryGetProperty("name", out var doneName) ? doneName.GetString() ?? "tool" : "tool",
                        payload.TryGetProperty("target", out var doneTarget) ? doneTarget.GetString() ?? "" : "",
                        !payload.TryGetProperty("ok", out var doneOk) || doneOk.ValueKind != JsonValueKind.False,
                        payload.TryGetProperty("durationMs", out var doneMs) && doneMs.ValueKind == JsonValueKind.Number ? doneMs.GetInt64() : 0,
                        payload.TryGetProperty("output", out var doneOutput) ? doneOutput.GetString() ?? "" : "");
                    break;
                case "task.started": Activity.Text = payload.TryGetProperty("agent", out var taskAgent) ? $"Sidecar subagent started: {taskAgent.GetString()}" : "Subagent started"; break;
                case "task.completed": Activity.Text = payload.TryGetProperty("status", out var taskStatus) ? $"Subagent completed: {taskStatus.GetString()}" : "Subagent completed"; break;
                case "task.blocked": Activity.Text = payload.TryGetProperty("report", out var taskReport) ? $"Subagent blocked: {taskReport.GetString()}" : "Subagent blocked"; break;
                case "tool.approval_required":
                    _approvalRunId = runId;
                    _approvalCallId = payload.TryGetProperty("callId", out var call) ? call.GetString() : null;
                    ShowApproval($"Approval needed: {(payload.TryGetProperty("name", out var name) ? name.GetString() : "action")}\n{(payload.TryGetProperty("reason", out var reason) ? reason.GetString() : "")}");
                    ApproveButton.IsEnabled = true;
                    DenyButton.IsEnabled = true;
                    Activity.Text = "Waiting for your approval";
                    break;
                case "tool.approval_resolved": ResetApproval(); break;
                case "verification.started": Activity.Text = "Verifying the result"; break;
                case "verification.passed": Evidence.Text = "Verification passed; evidence recorded."; break;
                case "verification.failed": Evidence.Text = "Verification failed; Kitten will keep the run honest."; break;
                case "run.completed":
                    var finished = payload.TryGetProperty("finished", out var finishedValue) && finishedValue.ValueKind == JsonValueKind.True;
                    var verified = payload.TryGetProperty("verified", out var verifiedValue) && verifiedValue.ValueKind == JsonValueKind.True;
                    var summary = payload.TryGetProperty("summary", out var summaryValue) ? summaryValue.GetString() : "";
                    var wallMs = payload.TryGetProperty("wallMs", out var wallValue) && wallValue.ValueKind == JsonValueKind.Number ? wallValue.GetInt64() : 0;
                    var grade = verified ? "✓ verified" : finished ? "~ checked" : "• unverified";
                    Activity.Text = $"Run complete · {grade} · {_activeRunFiles.Count} file(s) · {Duration(wallMs)}";
                    var usage = payload.TryGetProperty("usage", out var usageValue) && usageValue.ValueKind == JsonValueKind.Object
                        ? "Usage: " + ReadLong(usageValue, "prompt") + " prompt + " + ReadLong(usageValue, "completion") + " completion tokens"
                        : "Usage: unavailable";
                    var completionTokens = payload.TryGetProperty("usage", out var speedUsage) && speedUsage.ValueKind == JsonValueKind.Object ? ReadLong(speedUsage, "completion") : 0;
                    var speed = wallMs > 0 && completionTokens > 0 ? $" · {completionTokens / (wallMs / 1000.0):0.0} tok/s" : "";
                    Evidence.Text = $"{grade}\n{summary}\nFiles: {_activeRunFiles.Count} ( +{_activeRunAdded} / -{_activeRunRemoved} lines )\n{usage}{speed}";
                    SetChangesSummary(_activeRunFiles.Count, _activeRunAdded, _activeRunRemoved);
                    SetComposerHint($"{grade} · {Duration(wallMs)}{speed}");
                    _lastCompletedRunId = runId;
                    _activeRunId = null;
                    _canResumeInterrupted = false;
                    ResumeButton.IsEnabled = false;
                    SetRunControls(false);
                    UndoButton.IsEnabled = _lastCompletedRunId is not null;
                    RedoButton.IsEnabled = false;
                    break;
                case "run.failed":
                    var failureMessage = payload.TryGetProperty("error", out var failure) ? failure.GetString() ?? "Run failed" : "Run failed";
                    Activity.Text = System.Text.RegularExpressions.Regex.IsMatch(failureMessage, "timeout|timed out|unloaded|model.*respond", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                        ? $"Main model is unavailable or still loading: {failureMessage}\nUse Model health to find a responding local tier."
                        : $"Run failed: {failureMessage}";
                    Evidence.Text = Activity.Text;
                    _activeRunId = null;
                    ResumeButton.IsEnabled = false;
                    SetRunControls(false);
                    break;
                case "run.cancelled":
                    Activity.Text = "Run cancelled";
                    _activeRunId = null;
                    ResumeButton.IsEnabled = false;
                    SetRunControls(false);
                    break;
                case "run.interrupted":
                    Activity.Text = "Run interrupted; it can be resumed safely";
                    _activeRunId = null;
                    _canResumeInterrupted = true;
                    ResumeButton.IsEnabled = true;
                    SetRunControls(false);
                    break;
            }
        });
    }

    private static string ShortId(string id) => id[..Math.Min(8, id.Length)];

    private static string? BakeoffRoleForModel(string model)
    {
        var match = System.Text.RegularExpressions.Regex.Match(model, @"(?:^|[-_])(?<b>\d{1,3})b(?:$|[-_])", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!match.Success || !int.TryParse(match.Groups["b"].Value, out var billions)) return null;
        return billions <= 9 ? "sidecar" : billions is >= 35 and <= 200 ? "main" : null;
    }

    private static long ReadLong(JsonElement value, string property)
        => value.TryGetProperty(property, out var number) && number.ValueKind == JsonValueKind.Number ? number.GetInt64() : 0;

    private async void OpenProject(object? sender, RoutedEventArgs e)
    {
        var folder = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { AllowMultiple = false, Title = "Open project" });
        if (folder.Count == 0 || _engine is null) return;
        var project = folder[0].Path.LocalPath;
        _conversationSearch = "";
        ConversationSearch.Text = "";
        var result = await _engine.CallAsync("conversation.create", new { title = "New task", projectRoot = project, agent = "general" });
        var id = result?.ValueKind == JsonValueKind.Object && result.Value.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
        await RefreshConversationsAsync(id);
    }

    private async void NewTask(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        var project = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
        if (string.IsNullOrWhiteSpace(project))
        {
            Activity.Text = "Open a project before starting a new task.";
            return;
        }
        try
        {
            _conversationSearch = "";
            ConversationSearch.Text = "";
            var result = await _engine.CallAsync("conversation.create", new { title = "New task", projectRoot = project, agent = "general" });
            var id = result?.ValueKind == JsonValueKind.Object && result.Value.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
            await RefreshConversationsAsync(id);
            Activity.Text = "New task ready.";
        }
        catch (Exception ex) { Activity.Text = $"Could not create a new task: {ex.Message}"; }
    }

    private async void SearchConversations(object? sender, RoutedEventArgs e)
    {
        _conversationSearch = ConversationSearch.Text?.Trim() ?? "";
        await RefreshConversationsAsync();
        Activity.Text = string.IsNullOrWhiteSpace(_conversationSearch) ? "Showing all conversations." : $"Showing conversations matching '{_conversationSearch}'.";
    }

    private void PromptKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (e.KeyModifiers & KeyModifiers.Control) != 0)
        {
            e.Handled = true;
            if ((e.KeyModifiers & KeyModifiers.Shift) != 0) PlanAndRun(sender, new RoutedEventArgs());
            else Submit(sender, new RoutedEventArgs());
            return;
        }
        if (e.Key == Key.Escape && (_activeRunId is not null || _activeTaskId is not null || _submissionActive))
        {
            e.Handled = true;
            CancelRun(sender, new RoutedEventArgs());
        }
    }

    private async void Submit(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId) || string.IsNullOrWhiteSpace(Prompt.Text) || _activeRunId is not null || _activeTaskId is not null) return;
        var text = Prompt.Text.Trim();
        Prompt.Text = "";
        var mention = System.Text.RegularExpressions.Regex.Match(text, "^@(?<agent>[A-Za-z0-9][A-Za-z0-9_-]{0,63})\\s+(?<prompt>.+)$", System.Text.RegularExpressions.RegexOptions.Singleline);
        if (mention.Success)
        {
            await SubmitMentionAsync(mention.Groups["agent"].Value, mention.Groups["prompt"].Value.Trim());
            return;
        }
        _submissionActive = true;
        Activity.Text = "Running...";
        _transcript.AddUser(text);
        _transcript.BeginAssistant("Kitten");
        SetRunControls(true);
        try
        {
            var result = await _engine.CallAsync("conversation.submit", new { conversationId = _conversationId, text });
            if (result is { } completed && completed.ValueKind == JsonValueKind.Object)
            {
                if (completed.TryGetProperty("cancelled", out var cancelled) && cancelled.ValueKind == JsonValueKind.True) Activity.Text = "Run cancelled before the model started.";
                else if (completed.TryGetProperty("verified", out var verified)) Evidence.Text = verified.GetBoolean() ? "Verified execution evidence recorded." : "Finished without independent verification.";
            }
        }
        catch (Exception ex) { Activity.Text = $"Run failed: {ex.Message}"; SetRunControls(false); }
        finally { _submissionActive = false; SetRunControls(false); }
    }

    private async Task SubmitMentionAsync(string agent, string objective)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId)) return;
        var parentRunId = $"mention-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
        _activeTaskId = parentRunId;
        Activity.Text = $"Starting @{agent} subagent...";
        _transcript.AddUser($"@{agent} {objective}");
        _transcript.AddNote($"@{agent} subagent", "Launching a bounded subagent…");
        SetRunControls(true);
        try
        {
            var projectRoot = _conversationItems.FirstOrDefault(item => item.Id == _conversationId)?.ProjectRoot;
            var result = await _engine.CallAsync("task.spawn", new { parentConversationId = _conversationId, parentRunId, agent, prompt = objective, projectRoot });
            if (result is { } value && value.ValueKind == JsonValueKind.Object)
            {
                var child = value.TryGetProperty("conversation", out var childValue) && childValue.ValueKind == JsonValueKind.Object
                    ? childValue.TryGetProperty("id", out var childId) ? childId.GetString() : null
                    : null;
                var run = value.TryGetProperty("run", out var runValue) && runValue.ValueKind == JsonValueKind.Object ? runValue : default;
                var status = run.ValueKind == JsonValueKind.Object && run.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : "completed";
                var summary = run.ValueKind == JsonValueKind.Object && run.TryGetProperty("summary", out var summaryValue) ? summaryValue.GetString() : "No summary returned.";
                _transcript.AddNote($"@{agent} subagent · {status}", summary ?? "");
                Evidence.Text = $"@{agent} child session completed{(string.IsNullOrWhiteSpace(child) ? "" : $" ({child})")}. Open it from the conversation list to inspect the full transcript and receipts.";
                Activity.Text = $"@{agent} subagent completed.";
            }
            else Activity.Text = $"@{agent} subagent completed.";
            await RefreshConversationsAsync(_conversationId);
        }
        catch (Exception ex)
        {
            Activity.Text = ex.Message.Contains("cancel", StringComparison.OrdinalIgnoreCase) ? $"@{agent} subagent cancelled." : $"@{agent} subagent failed: {ex.Message}";
        }
        finally
        {
            _activeTaskId = null;
            SetRunControls(false);
        }
    }

    private async void ResumeInterrupted(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId) || !_canResumeInterrupted || _activeRunId is not null || _activeTaskId is not null) return;
        _canResumeInterrupted = false;
        ResumeButton.IsEnabled = false;
        Activity.Text = "Resuming the interrupted task with its persisted context...";
        _submissionActive = true;
        _transcript.AddUser("Continue the interrupted task from the last durable state.");
        _transcript.BeginAssistant("Kitten");
        SetRunControls(true);
        try
        {
            var result = await _engine.CallAsync("conversation.submit", new { conversationId = _conversationId, text = "Continue the interrupted task from the last durable state. Re-check the workspace and report what remains before making changes." });
            if (result is { } completed && completed.ValueKind == JsonValueKind.Object)
            {
                if (completed.TryGetProperty("cancelled", out var cancelled) && cancelled.ValueKind == JsonValueKind.True) Activity.Text = "Resume cancelled before the model started.";
                else if (completed.TryGetProperty("verified", out var verified)) Evidence.Text = verified.GetBoolean() ? "Verified execution evidence recorded." : "Finished without independent verification.";
            }
        }
        catch (Exception ex) { Activity.Text = $"Resume failed: {ex.Message}"; ResumeButton.IsEnabled = true; _canResumeInterrupted = true; SetRunControls(false); }
        finally { _submissionActive = false; SetRunControls(false); }
    }

    private async void PlanAndRun(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId) || string.IsNullOrWhiteSpace(Prompt.Text) || _activeRunId is not null || _activeTaskId is not null) return;
        var text = Prompt.Text.Trim();
        Prompt.Text = "";
        _activeTaskId = $"task-plan-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
        Activity.Text = "Sidecar is mapping the repository, reviewing risks, and defining verification...";
        SetRunControls(true);
        try
        {
            var suggestion = await _engine.CallAsync("task.plan-suggest", new { conversationId = _conversationId, text, parentRunId = _activeTaskId });
            if (suggestion is not { } suggested || suggested.ValueKind != JsonValueKind.Object || !suggested.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("sidecar did not return a task plan");
            await _engine.CallAsync("task.plan", new { conversationId = _conversationId, nodes });
            var result = await _engine.CallAsync("task.run", new { conversationId = _conversationId, parentRunId = _activeTaskId });
            if (result is { } rows && rows.ValueKind == JsonValueKind.Array)
            {
                var summaries = rows.EnumerateArray().Select(row =>
                {
                    var agent = row.TryGetProperty("agent", out var agentValue) ? agentValue.GetString() : "subagent";
                    var status = row.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : "unknown";
                    var report = row.TryGetProperty("report", out var reportValue) ? reportValue.GetString() : "";
                    return $"{agent}: {status}\n{report}";
                });
                _transcript.AddNote($"Sidecar plan for: {text}", string.Join("\n\n", summaries));
                Evidence.Text = "Read-only subagent reports completed. Review them, then use Run for the implementation step.";
            }
            _lastPlanRequest = text;
            await RefreshConversationsAsync(_conversationId);
            ImplementButton.IsEnabled = true;
            Activity.Text = "Sidecar plan complete";
        }
        catch (Exception ex) { Activity.Text = $"Sidecar plan failed: {ex.Message}"; }
        finally { _activeTaskId = null; SetRunControls(false); }
    }

    private async void ImplementPlan(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId) || string.IsNullOrWhiteSpace(_lastPlanRequest) || _activeRunId is not null || _activeTaskId is not null) return;
        try
        {
            var planId = $"task-implementation-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}";
            _activeTaskId = planId;
            SetRunControls(true);
            Activity.Text = "Sidecar is orienting the bounded implementation scope...";
            var suggestion = await _engine.CallAsync("task.plan-edit-suggest", new { conversationId = _conversationId, text = _lastPlanRequest, parentRunId = planId });
            if (suggestion is not { } suggested)
            {
                Activity.Text = "No bounded implementation scope was found";
                return;
            }
            if (suggested.ValueKind != JsonValueKind.Object || !suggested.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            {
                Activity.Text = suggested.TryGetProperty("note", out var note) ? note.GetString() : "No bounded implementation scope was found";
                return;
            }
            var allowed = suggested.TryGetProperty("allowedFiles", out var allowedValue) && allowedValue.ValueKind == JsonValueKind.Array
                ? allowedValue.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)).Cast<string>().ToArray()
                : Array.Empty<string>();
            if (allowed.Length == 0) { Activity.Text = "No bounded implementation scope was found"; return; }
            if (!await ConfirmImplementationAsync(allowed)) { Activity.Text = "Implementation cancelled; no files were changed."; return; }
            _activeTaskId = planId;
            Activity.Text = "Main model is implementing the approved file scope...";
            SetRunControls(true);
            await _engine.CallAsync("task.plan", new { conversationId = _conversationId, nodes });
            var result = await _engine.CallAsync("task.run", new { conversationId = _conversationId, parentRunId = _activeTaskId });
            if (result is { } rows && rows.ValueKind == JsonValueKind.Array)
            {
                var summaries = rows.EnumerateArray().Select(row =>
                {
                    var agent = row.TryGetProperty("agent", out var agentValue) ? agentValue.GetString() : "subagent";
                    var status = row.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : "unknown";
                    var report = row.TryGetProperty("report", out var reportValue) ? reportValue.GetString() : "";
                    return $"{agent}: {status}\n{report}";
                });
                _transcript.AddNote("Bounded implementation results (approved files only)", string.Join("\n\n", summaries));
                Evidence.Text = "Implementation and verification subagents returned durable reports. Inspect the changed files before continuing.";
            }
            await RefreshConversationsAsync(_conversationId);
            Activity.Text = "Bounded implementation complete";
        }
        catch (Exception ex) { Activity.Text = $"Bounded implementation failed: {ex.Message}"; }
        finally { _activeTaskId = null; SetRunControls(false); }
    }

    private async Task<bool> ConfirmImplementationAsync(IReadOnlyList<string> allowedFiles)
    {
        var approve = new Button { Content = "Approve and run main model" };
        var cancel = new Button { Content = "Cancel" };
        var accepted = false;
        var dialog = new Window
        {
            Title = "Approve bounded implementation",
            Width = 620,
            Height = 420,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Avalonia.Thickness(24),
                Spacing = 12,
                Children =
                {
                    new TextBlock { Text = "Kitten will allow the main model to edit only these indexed files. The sidecar plan remains read-only.", TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                    new TextBlock { Text = string.Join("\n", allowedFiles), TextWrapping = Avalonia.Media.TextWrapping.Wrap, MaxHeight = 260 },
                    new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, Children = { approve, cancel } },
                },
            },
        };
        approve.Click += (_, _) => { accepted = true; dialog.Close(); };
        cancel.Click += (_, _) => dialog.Close();
        await dialog.ShowDialog(this);
        return accepted;
    }

    private async void CancelRun(object? sender, RoutedEventArgs e)
    {
        if (_engine is null) return;
        if (_activeTaskId is not null)
        {
            try { await _engine.CallAsync("task.cancel", new { parentRunId = _activeTaskId }); Activity.Text = "Stopping sidecar plan..."; }
            catch (Exception ex) { Activity.Text = $"Could not stop sidecar plan: {ex.Message}"; }
            return;
        }
        if (_activeRunId is null)
        {
            if (_submissionActive && !string.IsNullOrWhiteSpace(_conversationId))
            {
                try { await _engine.CallAsync("conversation.submit.cancel", new { conversationId = _conversationId }); Activity.Text = "Stopping task orientation..."; }
                catch (Exception ex) { Activity.Text = $"Could not stop task orientation: {ex.Message}"; }
            }
            return;
        }
        try { await _engine.CallAsync("run.cancel", new { runId = _activeRunId }); }
        catch (Exception ex) { Activity.Text = $"Could not stop run: {ex.Message}"; }
    }

    private async void UndoLastRun(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_lastCompletedRunId)) return;
        try
        {
            var result = await _engine.CallAsync("run.undo", new { runId = _lastCompletedRunId });
            Activity.Text = result is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("ok", out var ok) && ok.GetBoolean()
                ? "Last run undone; files restored to the pre-run snapshot."
                : "Undo could not be applied.";
            UndoButton.IsEnabled = false;
            RedoButton.IsEnabled = true;
        }
        catch (Exception ex) { Activity.Text = $"Undo failed: {ex.Message}"; }
    }

    private async void RedoLastRun(object? sender, RoutedEventArgs e)
    {
        if (_engine is null || string.IsNullOrWhiteSpace(_conversationId)) return;
        try
        {
            var result = await _engine.CallAsync("run.redo", new { conversationId = _conversationId });
            Activity.Text = result is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("ok", out var ok) && ok.GetBoolean()
                ? "Last undone run reapplied."
                : "Redo could not be applied.";
            RedoButton.IsEnabled = false;
            UndoButton.IsEnabled = true;
        }
        catch (Exception ex) { Activity.Text = $"Redo failed: {ex.Message}"; }
    }

    private async void ApproveAction(object? sender, RoutedEventArgs e) => await ResolveApprovalAsync(true);
    private async void DenyAction(object? sender, RoutedEventArgs e) => await ResolveApprovalAsync(false);

    private async Task ResolveApprovalAsync(bool allowed)
    {
        if (_engine is null || _approvalRunId is null || _approvalCallId is null) return;
        try { await _engine.CallAsync("approval.resolve", new { runId = _approvalRunId, callId = _approvalCallId, allowed }); ResetApproval(); }
        catch (Exception ex) { Activity.Text = $"Approval failed: {ex.Message}"; }
    }

    private void ResetApproval()
    {
        _approvalRunId = null;
        _approvalCallId = null;
        ShowApproval("");
        ApproveButton.IsEnabled = false;
        DenyButton.IsEnabled = false;
    }

    private void SetRunControls(bool running)
    {
        var hasConversation = !string.IsNullOrWhiteSpace(_conversationId);
        PlanButton.IsEnabled = hasConversation && !running;
        ImplementButton.IsEnabled = hasConversation && !running && !string.IsNullOrWhiteSpace(_lastPlanRequest);
        RunButton.IsEnabled = hasConversation && !running;
        CancelButton.IsEnabled = running && (_activeRunId is not null || _activeTaskId is not null || _submissionActive);
    }
}
